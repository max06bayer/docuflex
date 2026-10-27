"""Editable PDF slides with complete image occurrences and original paint order."""
import io
import math
import re
import struct
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

import pymupdf as fitz
from fontTools.ttLib import TTFont, TTLibError
from fontTools.varLib.instancer import instantiateVariableFont
from lxml import etree as ET
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_AUTO_SIZE, MSO_ANCHOR
from pptx.util import Pt

P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
FONTS = Path(__file__).resolve().parents[1] / 'backend/fonts'


def font_key(name):
    return re.sub(r'[^a-z0-9]', '', re.sub(r'^[A-Z]{6}\+', '', name).lower())


def font_style(font):
    selection = font['OS/2'].fsSelection
    return ('bold' if selection & 32 else '') + ('italic' if selection & 1 else '') or 'regular'


def font_bytes(font):
    stream = io.BytesIO()
    font.save(stream)
    return stream.getvalue()


def eot_font(font):
    """Uncompressed EOT 2.0, as required for PowerPoint's fontdata parts."""
    data = font_bytes(font)
    os2 = font['OS/2']
    panose = bytes(getattr(os2.panose, name) for name in (
        'bFamilyType', 'bSerifStyle', 'bWeight', 'bProportion', 'bContrast',
        'bStrokeVariation', 'bArmStyle', 'bLetterForm', 'bMidline', 'bXHeight'))
    header = struct.pack('<4I', 0, len(data), 0x00020001, 0)
    header += panose + struct.pack('<BBIHH', 1, int(bool(os2.fsSelection & 1)), os2.usWeightClass, os2.fsType, 0x504C)
    header += struct.pack('<7I', *[getattr(os2, f'ulUnicodeRange{i}', 0) for i in range(1,5)],
                          getattr(os2, 'ulCodePageRange1', 0), getattr(os2, 'ulCodePageRange2', 0), font['head'].checkSumAdjustment)
    header += bytes(16)
    for name_id in (1, 2, 5, 4):
        value = (font['name'].getDebugName(name_id) or '').encode('utf-16le')
        header += struct.pack('<HH', 0, len(value)) + value
    header += struct.pack('<HH', 0, 0)  # final name padding and empty RootString
    return struct.pack('<I', len(header)+len(data)) + header[4:] + data


class SlideFonts:
    def __init__(self, document):
        self.pdf = {}
        self.cache = {}
        self.used = {}
        self.link_colors = set()
        seen = set()
        for page in document:
            for info in page.get_fonts(full=True):
                if info[0] in seen:
                    continue
                seen.add(info[0])
                _, ext, _, data = document.extract_font(info[0])
                if ext not in ('ttf','otf') or not data:
                    continue
                try:
                    font = TTFont(io.BytesIO(data))
                except (TTLibError, KeyError):
                    continue
                rights = font['OS/2'].fsType
                # Preview/print-only fonts must not make an editable deck
                # read-only. Use an editable, bundled face for those fonts.
                if ((rights & 15) and not (rights & 8)) or rights & 0x200:
                    continue
                # Different PDF subsets of one family contain different glyphs.
                # Give each embedded subset its own family so Office cannot use
                # a later, incomplete subset for an earlier slide's text.
                family = f"Docuflex PDF {info[0]} {font['name'].getDebugName(1)}"
                for record in font['name'].names:
                    if record.nameID in (1,4,6,16):
                        record.string = (family.replace(' ','') if record.nameID == 6 else family).encode(record.getEncoding())
                self.pdf.setdefault(font_key(info[3]), []).append(font)

    def resolve(self, span):
        name = span['font']
        bold, italic = bool(span['flags'] & 16), bool(span['flags'] & 2)
        needed = frozenset(ord(c) for c in span['text'] if not c.isspace())
        key = (name, bold, italic, needed if font_key(name) in self.pdf else None)
        if key not in self.cache:
            font = None
            needed = {ord(c) for c in span['text'] if not c.isspace()}
            for source_key, sources in self.pdf.items():
                if source_key == font_key(name):
                    font = next((face for face in sorted(sources, key=lambda f: len(f.getBestCmap() or {}), reverse=True) if needed.issubset(face.getBestCmap() or {})), None)
                    if font is not None:
                        break
            if font is None and name.startswith('Derailed'):
                # Newcastle's PDF permits its brand face only for preview/print.
                # Inter is bundled under OFL and can be embedded for editing.
                weight = next((weight for style, weight in [('ExtraBold',800),('SemiBold',600),('Bold',700),('Medium',500),('Light',300)] if style in name), 400)
                path = FONTS / ('inter-variable-italic.ttf' if italic else 'inter-variable-normal.ttf')
                font = instantiateVariableFont(TTFont(path), {'wght': weight}, inplace=False)
                family = f'Docuflex Export Sans {weight}' + (' Italic' if italic else '')
                for record in font['name'].names:
                    if record.nameID in (1,4,6,16):
                        record.string = (family.replace(' ','') if record.nameID == 6 else family).encode(record.getEncoding())
                    elif record.nameID in (2,17):
                        record.string = 'Regular'.encode(record.getEncoding())
                font['OS/2'].fsSelection = 64
                font['head'].macStyle = 0
            if font is None:
                lower = name.lower()
                base = ('Carlito' if 'calibri' in lower or 'carlito' in lower else
                        'LiberationMono' if 'courier' in lower or 'mono' in lower else
                        'LiberationSerif' if 'times' in lower or 'roman' in lower else 'LiberationSans')
                style = 'BoldItalic' if bold and italic else 'Bold' if bold else 'Italic' if italic else 'Regular'
                font = TTFont(FONTS / 'fallback' / f'{base}-{style}.ttf')
            if 'fvar' in font:
                font = instantiateVariableFont(font, {axis.axisTag: axis.defaultValue for axis in font['fvar'].axes}, inplace=False)
            family = font['name'].getDebugName(1)
            style = font_style(font)
            self.cache[key] = (family, style, font)
        family, style, font = self.cache[key]
        needed = {ord(c) for c in span['text'] if not c.isspace()}
        if not needed.issubset(font.getBestCmap() or {}):
            # A PDF subset can omit characters on later slides. Prefer a full
            # bundled face instead of embedding a font that cannot draw them.
            style_name = 'BoldItalic' if bold and italic else 'Bold' if bold else 'Italic' if italic else 'Regular'
            font = TTFont(FONTS / 'fallback' / f'LiberationSans-{style_name}.ttf')
            family, style = font['name'].getDebugName(1), font_style(font)
        self.used[(family, style)] = font
        return family, style, font

    def embed(self, output):
        with ZipFile(output) as package:
            parts = {name: package.read(name) for name in package.namelist()}
        root = ET.fromstring(parts['ppt/presentation.xml'])
        rels = ET.fromstring(parts['ppt/_rels/presentation.xml.rels'])
        types = ET.fromstring(parts['[Content_Types].xml'])
        ET.SubElement(types, f'{{{CT}}}Default', Extension='fntdata', ContentType='application/x-fontdata')
        listing = ET.Element(f'{{{P}}}embeddedFontLst')
        by_family = {}
        for index, ((family, style), font) in enumerate(self.used.items(),1):
            face = by_family.get(family)
            if face is None:
                face = ET.SubElement(listing, f'{{{P}}}embeddedFont')
                ET.SubElement(face, f'{{{P}}}font', typeface=family, pitchFamily='34', charset='0')
                by_family[family] = face
            rid = f'rIdEmbeddedFont{index}'
            ET.SubElement(face, f'{{{P}}}{"boldItalic" if style == "bolditalic" else style}', {f'{{{R}}}id':rid})
            ET.SubElement(rels, f'{{{REL}}}Relationship', Id=rid, Type=R+'/font', Target=f'fonts/font{index}.fntdata')
            parts[f'ppt/fonts/font{index}.fntdata'] = eot_font(font)
        before = {f'{{{P}}}{tag}' for tag in ('custShowLst','photoAlbum','custDataLst','kinsoku','defaultTextStyle','modifyVerifier','extLst')}
        position = next((index for index,child in enumerate(root) if child.tag in before),len(root))
        root.insert(position, listing)
        root.set('embedTrueTypeFonts','1')
        root.set('saveSubsetFonts','1')
        if len(self.link_colors) == 1:
            color = next(iter(self.link_colors))
            for name in list(parts):
                if name.startswith('ppt/theme/') and name.endswith('.xml'):
                    theme = ET.fromstring(parts[name])
                    for element in theme.xpath('//*[local-name()="hlink" or local-name()="folHlink"]'):
                        for child in list(element): element.remove(child)
                        ET.SubElement(element, '{http://schemas.openxmlformats.org/drawingml/2006/main}srgbClr', val=color)
                    parts[name] = ET.tostring(theme, encoding='UTF-8', xml_declaration=True, standalone=True)
        parts['ppt/presentation.xml'] = ET.tostring(root,encoding='UTF-8',xml_declaration=True,standalone=True)
        parts['ppt/_rels/presentation.xml.rels'] = ET.tostring(rels,encoding='UTF-8',xml_declaration=True,standalone=True)
        parts['[Content_Types].xml'] = ET.tostring(types,encoding='UTF-8',xml_declaration=True,standalone=True)
        with ZipFile(output,'w',compression=ZIP_DEFLATED) as package:
            for name,data in parts.items():
                package.writestr(name,data)


def page_images(page):
    """All painted image occurrences, including objects slightly outside MediaBox."""
    events = [(seq, fitz.Rect(box)) for seq,(kind,box) in enumerate(page.get_bboxlog()) if kind == 'fill-image']
    blocks = [block for block in page.get_text('dict',flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_MEDIABOX_CLIP,
                                              clip=fitz.INFINITE_RECT())['blocks'] if block['type']==1]
    used = set()
    for index,info in enumerate(page.get_image_info(xrefs=True)):
        box = fitz.Rect(info['bbox'])
        if box.is_empty or not box.intersects(page.rect):
            continue
        seq = next((seq for seq,bounds in events if seq not in used and sum(abs(a-b) for a,b in zip(bounds,box)) < 0.1),None)
        if seq is None:
            raise ValueError('Could not preserve PDF image paint order.')
        used.add(seq)
        xref = info['xref']
        if xref:
            extracted = page.parent.extract_image(xref)
            pix = fitz.Pixmap(page.parent, xref)
            smask = extracted.get('smask',0)
            if pix.colorspace and pix.colorspace.n not in (1,3):
                pix = fitz.Pixmap(fitz.csRGB,pix)
            if smask:
                if pix.alpha:
                    pix = fitz.Pixmap(pix, 0)
                pix = fitz.Pixmap(pix,fitz.Pixmap(page.parent,smask))
            data = pix.tobytes('png')
        else:
            block = next((b for b in blocks if sum(abs(a-b) for a,b in zip(b['bbox'],box))<0.1),None)
            if block is None:
                raise ValueError('Could not recover a PDF inline image.')
            pix = fitz.Pixmap(block['image'])
            if block.get('mask'):
                pix = fitz.Pixmap(pix,fitz.Pixmap(block['mask']))
            data = pix.tobytes('png')
        yield seq, info, data


def build_slides(document, output, text_lines, rgb, slide_paths):
    presentation = Presentation()
    fonts = SlideFonts(document)
    size_scale = min(1,4032/max(document[0].rect.width,document[0].rect.height))
    sw,sh = max(72,document[0].rect.width*size_scale),max(72,document[0].rect.height*size_scale)
    presentation.slide_width,presentation.slide_height=Pt(sw),Pt(sh)
    for page in document:
        slide=presentation.slides.add_slide(presentation.slide_layouts[6])
        scale=min(sw/page.rect.width,sh/page.rect.height)
        dx,dy=(sw-page.rect.width*scale)/2,(sh-page.rect.height*scale)/2
        transform=lambda point:(round(Pt(point.x*scale+dx)),round(Pt(point.y*scale+dy)))
        ordered=slide_paths(page,slide,transform)
        for seq,info,data in page_images(page):
            box=fitz.Rect(info['bbox'])
            a,b,c,d,e,f=info['transform']
            iw,ih=math.hypot(a,b),math.hypot(c,d)
            center=fitz.Point(e+(a+c)/2,f+(b+d)/2)
            shape=slide.shapes.add_picture(io.BytesIO(data),*transform(fitz.Point(center.x-iw/2,center.y-ih/2)),
                                          width=Pt(iw*scale),height=Pt(ih*scale))
            shape.rotation=math.degrees(math.atan2(b,a))
            if a*d-b*c<0:
                shape._element.spPr.xfrm.set('flipV','1')
            ordered.append((seq,shape._element))
        # Match the actual text origin, not intersecting font bounding boxes:
        # adjacent title lines can overlap in their ascender/descender boxes.
        paint={}
        for trace in page.get_texttrace():
            for _,_,origin,_ in trace['chars']:
                key=(trace['font'],round(origin[0],2),round(origin[1],2))
                paint[key]=min(paint.get(key,trace['seqno']),trace['seqno'])
        links=[link for link in page.get_links() if link.get('uri','').startswith(('https://','http://','mailto:'))]
        for line in text_lines(page):
            direction=line.get('dir',(1,0))
            for span in line['spans']:
                text=span['text']
                if not text.strip():continue
                family,style,font=fonts.resolve(span)
                size=span['size']
                box=fitz.Rect(span['bbox'])
                padding=size*0.25
                ascent=max(1.0,font['hhea'].ascent/font['head'].unitsPerEm)
                x,y=span['origin'][0],span['origin'][1]-size*ascent
                shape=slide.shapes.add_textbox(Pt((x-padding)*scale+dx),Pt((y-padding)*scale+dy),
                                              Pt((box.width+size*2+padding*2)*scale),Pt((size*2+padding*2)*scale))
                frame=shape.text_frame
                frame.clear();frame.word_wrap=False;frame.auto_size=MSO_AUTO_SIZE.SHAPE_TO_FIT_TEXT
                frame.vertical_anchor=MSO_ANCHOR.TOP
                frame.margin_left=frame.margin_right=frame.margin_top=frame.margin_bottom=Pt(padding*scale)
                paragraph=frame.paragraphs[0]
                paragraph.space_before=paragraph.space_after=Pt(0)
                run=paragraph.add_run();run.text=text
                run.font.name=family;run.font.size=Pt(size*scale)
                run.font.bold='bold' in style;run.font.italic='italic' in style
                run.font.color.rgb=RGBColor.from_string(rgb(span['color']))
                run._r.get_or_add_rPr().set('kern','400000')
                cmap=font.getBestCmap() or {}
                advance=sum(font['hmtx'][cmap[ord(c)]][0] for c in text if ord(c) in cmap)/font['head'].unitsPerEm*size
                if len(text)>1:
                    # Match the source run's width even for editable substitute fonts.
                    tracking=(box.width-advance)/max(1,len(text)-1)*scale
                    run._r.get_or_add_rPr().set('spc',str(round(tracking*100)))
                for link in links:
                    # Link bounds can touch adjacent black text by a fraction
                    # of a point. That text must not acquire hyperlink styling.
                    overlap = (fitz.Rect(link['from']) & box).get_area()
                    if overlap > box.get_area() * 0.1:
                        run.hyperlink.address=link['uri']
                        run.font.underline=False
                        fonts.link_colors.add(rgb(span['color']))
                        break
                seq=paint.get((span['font'],round(span['origin'][0],2),round(span['origin'][1],2)))
                if seq is None:
                    seq=min((trace['seqno'] for trace in page.get_texttrace() if any(abs(origin[0]-span['origin'][0])<0.1 and abs(origin[1]-span['origin'][1])<0.1 for _,_,origin,_ in trace['chars'])),default=100000)
                ordered.append((seq,shape._element))
                angle=math.degrees(math.atan2(direction[1],direction[0]))
                if abs(angle)>0.1:
                    center=(box.tl+box.br)*0.5
                    width,height=(box.height+size*2 if abs(direction[1])>0.5 else box.width+size*2),size*2
                    shape.width,shape.height=Pt(width*scale),Pt(height*scale)
                    shape.left,shape.top=Pt((center.x-width/2)*scale+dx),Pt((center.y-height/2)*scale+dy)
                    shape.rotation=angle
        for _,element in sorted(ordered,key=lambda item:item[0]):
            slide.shapes._spTree.remove(element);slide.shapes._spTree.append(element)
    presentation.save(output)
    fonts.embed(output)
