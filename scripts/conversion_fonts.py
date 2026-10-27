"""Preserve usable PDF/repository fonts in editable Word documents.

Only fonts permitting editable embedding are used. A PDF's glyph subset is often
not a usable Unicode font; never embed such a font and corrupt editable text.
"""
import io
import re
import uuid
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

from fontTools.ttLib import TTFont, TTLibError
from fontTools.varLib.instancer import instantiateVariableFont
from lxml import etree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/package/2006/content-types'


def key(name):
    return re.sub(r'[^a-z0-9]', '', re.sub(r'^[A-Z]{6}\+', '', name).lower())


def candidates(document):
    seen = set()
    for page in document:
        for info in page.get_fonts(full=True):
            if info[0] in seen:
                continue
            seen.add(info[0])
            name, extension, _, data = document.extract_font(info[0])
            if data and extension in ('ttf', 'otf'):
                yield name, data
    # Full redistributable fonts shipped with Docuflex are preferable to an
    # incomplete PDF subset and allow the recipient to type additional text.
    for file in (Path(__file__).resolve().parents[1] / 'backend/fonts').rglob('*.ttf'):
        yield file.stem, file.read_bytes()


def embed_word_fonts(document, output):
    with ZipFile(output) as package:
        parts = {name: package.read(name) for name in package.namelist()}
    root = ET.fromstring(parts['word/document.xml'])
    required = {}
    for run in root.iter(f'{{{W}}}r'):
        names = run.findall(f'{{{W}}}rPr/{{{W}}}rFonts')
        text = ''.join(run.itertext())
        bold = run.find(f'{{{W}}}rPr/{{{W}}}b')
        italic = run.find(f'{{{W}}}rPr/{{{W}}}i')
        enabled = lambda element: element is not None and element.get(f'{{{W}}}val', '1') not in ('0', 'false', 'off')
        style = ('Bold' if enabled(bold) else '') + ('Italic' if enabled(italic) else '')
        style = style or 'Regular'
        for element in names:
            for attr in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
                name = element.get(f'{{{W}}}{attr}')
                if name:
                    required.setdefault((name, style), set()).update(ord(char) for char in text if not char.isspace())
                    if name == 'Noto Sans Math':
                        required.setdefault((name, 'Regular'), set()).update(ord(char) for char in text if not char.isspace())
    table = ET.fromstring(parts['word/fontTable.xml'])
    rel_path = 'word/_rels/fontTable.xml.rels'
    rels = ET.fromstring(parts[rel_path]) if rel_path in parts else ET.Element(f'{{{P}}}Relationships', nsmap={None: P})
    types = ET.fromstring(parts['[Content_Types].xml'])
    if not any(element.get('Extension') == 'odttf' for element in types):
        ET.SubElement(types, f'{{{C}}}Default', Extension='odttf', ContentType='application/vnd.openxmlformats-officedocument.obfuscatedFont')
    embedded = set()
    for source_name, data in candidates(document):
        try:
            font = TTFont(io.BytesIO(data))
        except (TTLibError, KeyError):
            continue
        rights = font['OS/2'].fsType if 'OS/2' in font else 0
        # OpenType permits the least restrictive bit when several are set.
        if ((rights & 0xF) and not (rights & 0x8)) or (rights & 0x200):
            continue
        selection = font['OS/2'].fsSelection if 'OS/2' in font else 0
        mac_style = font['head'].macStyle if 'head' in font else 0
        style = ('Bold' if selection & 32 or mac_style & 1 else '') + ('Italic' if selection & 1 or mac_style & 2 else '')
        style = style or 'Regular'
        names = {key(source_name)}
        for record in font['name'].names:
            if record.nameID in (1, 4, 6, 16):
                names.add(key(record.toUnicode()))
        cmap = font.getBestCmap() or {}
        matches = [name for (name, requested_style), chars in required.items()
                   if (name, requested_style) not in embedded and requested_style == style
                   and key(name) in names and chars.issubset(cmap)]
        if not matches:
            continue
        # Variable fonts need a static instance for older Office readers.
        if 'fvar' in font:
            font = instantiateVariableFont(font, {axis.axisTag: axis.defaultValue for axis in font['fvar'].axes}, inplace=False)
        stream = io.BytesIO()
        font.save(stream)
        for name in matches:
            identifier = uuid.uuid4()
            obfuscated = bytearray(stream.getvalue())
            mask = identifier.bytes[::-1]
            for index in range(min(32, len(obfuscated))):
                obfuscated[index] ^= mask[index % 16]
            filename = f'fonts/{identifier.hex}.odttf'
            parts[f'word/{filename}'] = bytes(obfuscated)
            rid = f'rIdFont{identifier.hex}'
            ET.SubElement(rels, f'{{{P}}}Relationship', Id=rid, Type=f'{R}/font', Target=filename)
            element = next((item for item in table if item.get(f'{{{W}}}name') == name), None)
            if element is None:
                element = ET.SubElement(table, f'{{{W}}}font', {f'{{{W}}}name': name})
            ET.SubElement(element, f'{{{W}}}embed{style}', {f'{{{R}}}id': rid, f'{{{W}}}fontKey': '{' + str(identifier).upper() + '}'})
            embedded.add((name, style))
        if len(embedded) == len(required):
            break
    if embedded:
        # CT_Font has a defined order for regular/bold/italic relationships.
        order = {'embedRegular': 0, 'embedBold': 1, 'embedItalic': 2, 'embedBoldItalic': 3}
        for element in table:
            children = [child for child in element if ET.QName(child).localname in order]
            for child in children:
                element.remove(child)
            element.extend(sorted(children, key=lambda child: order[ET.QName(child).localname]))
        parts['word/fontTable.xml'] = ET.tostring(table, xml_declaration=True, encoding='UTF-8', standalone=True)
        parts[rel_path] = ET.tostring(rels, xml_declaration=True, encoding='UTF-8', standalone=True)
        parts['[Content_Types].xml'] = ET.tostring(types, xml_declaration=True, encoding='UTF-8', standalone=True)
        with ZipFile(output, 'w', compression=ZIP_DEFLATED) as package:
            for name, data in parts.items():
                package.writestr(name, data)
    return sorted({name for name, _ in embedded})
