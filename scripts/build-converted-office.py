#!/usr/bin/env python3
"""Local PDF -> editable Office conversion. Never wrap rendered pages in Office files.

Word and slides retain PDF coordinates with
native text and vector paths; workbooks contain extracted table/positioned cells.
Raster images are kept only as individual source illustrations, never as a text
replacement. Scans are reconstructed with local Tesseract before conversion.
"""
import csv
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pymupdf as fitz

MAX_PAGES = 500
MAX_OBJECTS = 100_000


def font_name(name):
    name = re.sub(r"^[A-Z]{6}\+", "", name or "")
    lm = re.match(r'LM(Roman|Sans|Mono)(\d+)', name, re.I)
    if lm:
        family, optical = lm.groups()
        suffix = f' {optical}' if family.lower() == 'roman' and optical in ('8', '12', '17') else ''
        return f'Docuflex Modern {family.title()}{suffix}'
    if name.startswith('LMMath') or name == 'Cambria Math':
        return 'Noto Sans Math'
    name = re.sub(r"[-,](BoldItalic|BoldOblique|Bold|Italic|Oblique|Regular|Roman|MT)$", "", name)
    aliases = {"Helvetica": "Arial", "Times": "Times New Roman", "Courier": "Courier New", 'ArialMT': 'Arial'}
    return aliases.get(name, name) or "Arial"


def rgb(color):
    if isinstance(color, int):
        return f"{color & 0xffffff:06X}"
    if len(color) == 1:
        color = color * 3
    return "".join(f"{round(max(0, min(1, value)) * 255):02X}" for value in color[:3])


def xml_text(text):
    """Office XML 1.0 cannot contain control codes, surrogates or FFFE/FFFF."""
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "\ufffd", text or "")


def glyph_unicode(name):
    from fontTools.agl import toUnicode
    # TeX extension fonts name delimiter sizes separately from their Unicode.
    base = re.sub(r"(?:bigg?|Bigg?|display|text|small)$", "", name)
    return toUnicode(name) or toUnicode(base) or {
        'hatwide': '^', 'tildewide': '~', 'radical': '\u221a',
    }.get(base, '')


def text_lines(page):
    # rawdict retains character origins, so unknown PDF codes can be matched to
    # actual glyph IDs instead of inserting invalid XML or deleting symbols.
    raw = page.get_text("rawdict", flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)
    invalid = any(xml_text(char['c']) != char['c'] or char['c'] == '\ufffd' or span['font'].startswith('LMMathExtension')
                  for block in raw['blocks'] for line in block.get('lines', [])
                  for span in line['spans'] for char in span['chars'])
    recovered = {}
    if invalid:
        from fontTools.cffLib import CFFFontSet
        from fontTools.ttLib import TTFont, TTLibError
        orders = {}
        for trace in page.get_texttrace():
            if not trace['font'].startswith('LMMathExtension') and not any(code == 0xfffd or xml_text(chr(code)) != chr(code) for code, *_ in trace['chars']):
                continue
            name = trace['font']
            if name not in orders:
                orders[name] = []
                for info in page.get_fonts(full=True):
                    base = re.sub(r'^[A-Z]{6}\+', '', info[3])
                    if not (base.startswith(name) or name.startswith(base)):
                        continue
                    _, extension, _, data = page.parent.extract_font(info[0])
                    try:
                        if extension == 'cff':
                            font = CFFFontSet()
                            font.decompile(io.BytesIO(data), None)
                            orders[name] = font[font.fontNames[0]].charset
                        elif extension in ('ttf', 'otf'):
                            orders[name] = TTFont(io.BytesIO(data)).getGlyphOrder()
                    except (TTLibError, ValueError, KeyError):
                        pass
                    break
            order = orders[name]
            for code, glyph_id, origin, _ in trace['chars']:
                if glyph_id < len(order):
                    value = glyph_unicode(order[glyph_id])
                    if value:
                        recovered[(name, round(origin[0], 2), round(origin[1], 2))] = value
    for block in raw['blocks']:
        for line in block.get('lines', []):
            line['_recovered_characters'] = False
            for span in line['spans']:
                characters = []
                repaired = False
                for char in span.pop('chars'):
                    value = char['c']
                    if xml_text(value) != value or value == '\ufffd' or (span['font'].startswith('LMMathExtension') and value.strip()):
                        origin = char['origin']
                        value = recovered.get((span['font'], round(origin[0], 2), round(origin[1], 2)), xml_text(value))
                        repaired = True
                    characters.append(value)
                span['text'] = xml_text(''.join(characters))
                if repaired:
                    # Extension-font byte encodings are not usable Unicode
                    # Office fonts. Use a Unicode maths face for repaired runs.
                    span['font'] = 'Cambria Math'
                    line['_recovered_characters'] = True
            if any(span['text'].strip() for span in line['spans']):
                yield line


def reconstruct_scans(document, directory):
    """OCR only pages with images and no text. Do not copy the scan behind the text."""
    count = 0
    for page in document:
        if page.get_text().strip() or not page.get_images():
            continue
        scale = min(3, 4500 / max(page.rect.width, page.rect.height))
        image = Path(directory) / f"ocr-{page.number}.png"
        page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(image)
        result = subprocess.run(
            [os.environ.get("TESSERACT_BIN", "tesseract"), str(image), "stdout", "-l", "eng+deu", "-c", "tessedit_create_tsv=1"],
            capture_output=True, text=True, timeout=90, check=True,
        )
        words = [row for row in csv.DictReader(io.StringIO(result.stdout), delimiter="\t")
                 if row.get("text", "").strip() and float(row.get("conf", -1)) >= 20]
        if not words:
            raise ValueError("OCR found no readable text. Try a clearer scan or run the OCR tool first.")
        # Replace the scanned page with recognized text, preserving page size.
        # OCR cannot recover original fonts or reliably separate art from text.
        replacement = fitz.open()
        target = replacement.new_page(width=page.rect.width, height=page.rect.height)
        for word in words:
            x, y, width, height = [float(word[key]) / scale for key in ("left", "top", "width", "height")]
            text = word["text"]
            size = min(height, width / max(fitz.get_text_length(text, fontsize=1), 0.1))
            target.insert_text((x, y + height * 0.85), text, fontsize=max(1, size), fontname="helv")
        number = page.number
        document.delete_page(number)
        document.insert_pdf(replacement, start_at=number)
        replacement.close()
        count += 1
    return count


def build_docx(pdf, output):
    from conversion_word import build_layout_docx
    build_layout_docx(pdf, output, text_lines, font_name, rgb, slide_paths)


def slide_paths(page, slide, transform):
    """Keep PDF paths editable; approximate cubic curves with vector segments."""
    from pptx.dml.color import RGBColor
    from pptx.oxml.xmlchemy import OxmlElement
    from pptx.util import Pt
    ordered = []
    for path in page.get_drawings():
        if not path.get("items"):
            continue
        builder = slide.shapes.build_freeform(0, 0, scale=1)
        # Freeform coordinates are EMUs; using 1 avoids rounding PDF points.
        started = False
        last_point = None
        for item in path["items"]:
            kind = item[0]
            if kind == "l":
                start, end = transform(item[1]), transform(item[2])
                if last_point != start:
                    builder.move_to(*start)
                builder.add_line_segments([end], close=False)
                last_point = end
                started = True
            elif kind in ("re", "qu"):
                rect = item[1]
                points = ([rect.tl, rect.tr, rect.br, rect.bl] if kind == "re"
                          else [rect.ul, rect.ur, rect.lr, rect.ll])
                builder.move_to(*transform(points[0]))
                builder.add_line_segments([transform(point) for point in points[1:]], close=True)
                started = True
            elif kind == "c":
                # python-pptx's public freeform API only supports straight lines.
                # Approximate the cubic by short editable vector segments.
                p0, p1, p2, p3 = item[1:]
                if last_point != transform(p0):
                    builder.move_to(*transform(p0))
                points = []
                for step in range(1, 25):
                    t = step / 24
                    points.append(transform(fitz.Point(
                        (1-t)**3*p0.x + 3*(1-t)**2*t*p1.x + 3*(1-t)*t*t*p2.x + t**3*p3.x,
                        (1-t)**3*p0.y + 3*(1-t)**2*t*p1.y + 3*(1-t)*t*t*p2.y + t**3*p3.y)))
                builder.add_line_segments(points, close=False)
                last_point = points[-1]
                started = True
        if not started:
            continue
        if path.get('closePath'):
            builder.add_line_segments([], close=True)
        shape = builder.convert_to_shape()
        shape._element.spPr.append(OxmlElement('a:effectLst'))
        for reference in shape._element.xpath('./p:style/a:effectRef'):
            reference.set('idx', '0')
        ordered.append((path.get('seqno', 0), shape._element))
        if path.get("fill") is not None:
            shape.fill.solid()
            shape.fill.fore_color.rgb = RGBColor.from_string(rgb(path["fill"]))
        else:
            shape.fill.background()
        if path.get("color") is not None:
            shape.line.color.rgb = RGBColor.from_string(rgb(path["color"]))
            shape.line.width = Pt(max(0.1, path.get("width", 1)))
        else:
            shape.line.fill.background()
        # Preserve opacity instead of turning translucent fills opaque.
        for node, opacity in ((shape.fill._xPr, path.get("fill_opacity", 1)),
                              (shape.line._get_or_add_ln(), path.get("stroke_opacity", 1))):
            for color in node.iter():
                if color.tag.endswith("}srgbClr") and opacity is not None and opacity < 1:
                    alpha = OxmlElement("a:alpha")
                    alpha.set("val", str(round(opacity * 100000)))
                    color.append(alpha)

    return ordered


def build_pptx(document, output):
    from conversion_presentation import build_slides
    build_slides(document, output, text_lines, rgb, slide_paths)


def write_cell(cell, text, spans=()):
    from openpyxl.styles import Alignment, Font
    text = xml_text(text)[:32767]
    # Preserve identifiers/leading zeroes and never activate PDF text as formulas.
    numeric = text.strip()
    digits = numeric.replace('-', '').replace('.', '').lstrip('0')
    if (re.fullmatch(r"-?(?:0|[1-9]\d{0,14})(?:\.\d+)?", numeric)
            and len(digits) <= 15 and len(numeric.partition('.')[2]) <= 30):
        cell.value = float(numeric) if "." in numeric else int(numeric)
        if '.' in numeric:
            cell.number_format = '0.' + '0' * len(numeric.split('.')[1])
    else:
        cell.value = text
        cell.data_type = "s"
    if spans:
        span = max(spans, key=lambda span: len(span["text"]))
        cell.font = Font(name=font_name(span["font"]), size=span["size"],
                         bold=bool(span["flags"] & 16), italic=bool(span["flags"] & 2), color=rgb(span["color"]))
    cell.alignment = Alignment(vertical="top", wrap_text=True)


def build_xlsx(document, output):
    from openpyxl import Workbook
    from openpyxl.styles import Border, Side, PatternFill
    from openpyxl.drawing.image import Image as WorksheetImage
    from openpyxl.utils import get_column_letter
    workbook = Workbook()
    for page in document:
        sheet = workbook.active if page.number == 0 else workbook.create_sheet()
        sheet.title = f"Page {page.number + 1}"
        sheet.sheet_view.showGridLines = False
        lines = list(text_lines(page))
        tables = page.find_tables().tables
        if not tables:
            tables = [table for table in page.find_tables(strategy="text").tables
                      if table.row_count >= 2 and table.col_count >= 2]
        row_number = 1
        fills = [path for path in page.get_drawings() if path.get('fill') is not None]
        elements = [(fitz.Rect(table.bbox).y0, "table", table) for table in tables]
        for line in lines:
            center = fitz.Rect(line["bbox"]).tl + (fitz.Rect(line["bbox"]).br - fitz.Rect(line["bbox"]).tl) * 0.5
            if not any(center in fitz.Rect(table.bbox) for table in tables):
                elements.append((line["bbox"][1], "line", line))
        for _, kind, element in sorted(elements, key=lambda item: item[0]):
            if kind == "table":
                for row_index, row in enumerate(element.extract()):
                    source_row = element.rows[row_index]
                    for column, value in enumerate(row, 1):
                        box = source_row.cells[column - 1]
                        if box is None:
                            continue
                        box = fitz.Rect(box)
                        spans = [span for line in lines for span in line['spans']
                                 if box.contains(fitz.Rect(span['bbox']).tl + (1, 1))]
                        cell = sheet.cell(row_number, column)
                        write_cell(cell, value, spans)
                        cell.border = Border(**{edge: Side(style="thin", color="B0B0B0")
                                               for edge in ("left", "right", "top", "bottom")})
                        center = (box.tl + box.br) * 0.5
                        for path in fills:
                            if center in path['rect']:
                                cell.fill = PatternFill('solid', fgColor=rgb(path['fill']))
                        sheet.column_dimensions[get_column_letter(column)].width = min(80, max(8, box.width / 5.25))
                        sheet.row_dimensions[row_number].height = max(sheet.row_dimensions[row_number].height or 0, box.height)
                        # The detector represents covered cells by None. Recover
                        # horizontal/vertical spans from the source cell bounds.
                        xs = sorted({round(fitz.Rect(c).x0, 1) for r in element.rows for c in r.cells if c}
                                    | {round(fitz.Rect(c).x1, 1) for r in element.rows for c in r.cells if c})
                        ys = sorted({round(fitz.Rect(c).y0, 1) for r in element.rows for c in r.cells if c}
                                    | {round(fitz.Rect(c).y1, 1) for r in element.rows for c in r.cells if c})
                        col_span = max(1, sum(box.x0 - 0.5 <= x < box.x1 - 0.5 for x in xs))
                        row_span = max(1, sum(box.y0 - 0.5 <= y < box.y1 - 0.5 for y in ys))
                        if col_span > 1 or row_span > 1:
                            sheet.merge_cells(start_row=row_number, start_column=column,
                                              end_row=row_number + row_span - 1, end_column=column + col_span - 1)
                    row_number += 1
                row_number += 1
            else:
                # Use gaps between spans as cell boundaries for non-table content.
                groups = []
                for span in element["spans"]:
                    if groups and span["bbox"][0] - groups[-1][-1]["bbox"][2] < max(8, span["size"]):
                        groups[-1].append(span)
                    else:
                        groups.append([span])
                for column, group in enumerate(groups, 1):
                    write_cell(sheet.cell(row_number, column), "".join(span["text"] for span in group), group)
                sheet.row_dimensions[row_number].height = max(span["size"] for span in element["spans"]) * 1.5
                row_number += 1
        for column in sheet.columns:
            width = min(65, max(12, max(len(str(cell.value or "")) for cell in column) + 2))
            dimension = sheet.column_dimensions[get_column_letter(column[0].column)]
            dimension.width = max(dimension.width, width)
        # Preserve actual source illustrations alongside the editable cells.
        for block in page.get_text('dict')['blocks']:
            if block['type'] == 1:
                picture = WorksheetImage(io.BytesIO(block['image']))
                box = fitz.Rect(block['bbox'])
                picture.width, picture.height = box.width * 4 / 3, box.height * 4 / 3
                sheet.add_image(picture, f'A{row_number}')
                row_number += max(1, math.ceil(picture.height / 20))
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.page_setup.orientation = "landscape" if page.rect.width > page.rect.height else "portrait"
        sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 0
    workbook.save(str(output))


def main():
    if len(sys.argv) != 4:
        raise ValueError("Expected output format, output path, and source PDF path.")
    output_format, output_path, pdf_path = sys.argv[1:]
    if output_format not in ("docx", "pptx", "xlsx"):
        raise ValueError("Unsupported editable Office format.")
    document = fitz.open(pdf_path)
    try:
        if document.needs_pass:
            raise ValueError("Unlock the password-protected PDF before converting it.")
        if not 0 < len(document) <= MAX_PAGES:
            raise ValueError(f"Editable conversion supports up to {MAX_PAGES} pages at a time.")
        with tempfile.TemporaryDirectory(prefix="docuflex-editable-") as directory:
            ocr_pages = reconstruct_scans(document, directory)
            # Normalize page rotation before reading coordinates in all engines.
            for page in document:
                if page.rotation:
                    page.remove_rotation()
                if len(page.get_text("words")) + len(page.get_drawings()) > MAX_OBJECTS:
                    raise ValueError("This page is too complex to convert safely. Split the PDF first.")
            normalized = Path(directory) / "normalized.pdf"
            document.save(normalized)
            if output_format == "docx":
                build_docx(normalized, output_path)
            elif output_format == "pptx":
                build_pptx(document, output_path)
            else:
                build_xlsx(document, output_path)
            print(json.dumps({"ocrPages": ocr_pages}))
    finally:
        document.close()


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(f"CONVERSION_INPUT: {error}", file=sys.stderr)
        sys.exit(2)
