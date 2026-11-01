"""Check actual redacted pixels as well as extracted text, using disposable PDFs."""
import base64
import io
import json
import os
import re
import subprocess
import urllib.request

import fitz
from PIL import Image

base = os.environ['PDF_BACKEND_URL']
assert re.fullmatch(r'http://127\.0\.0\.1:\d+', base)
tesseract = os.environ.get('TESSERACT_BIN', 'tesseract')
for rotation in (0, 90, 180, 270):
    source = fitz.open()
    page = source.new_page(width=612, height=792)
    page.insert_text((72, 120), 'SECRET FIXTURE', fontsize=28)
    page.insert_text((72, 650), 'Keep this text', fontsize=24)
    secret = page.search_for('SECRET FIXTURE')[0]
    page.set_rotation(rotation)
    rect = secret * page.rotation_matrix
    rect += (-8, -8, 8, 8)
    display = page.rect
    annotation = {'page': 0, 'type': 'blackout', 'x': rect.x0/display.width, 'y': rect.y0/display.height,
                  'width': rect.width/display.width, 'height': rect.height/display.height, 'color': [0, 0, 0]}
    body = json.dumps({'pdfBase64': base64.b64encode(source.tobytes()).decode(), 'annotations': [annotation]}).encode()
    request = urllib.request.Request(base+'/export', data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        result = fitz.open(stream=response.read(), filetype='pdf')
    assert 'SECRET' not in result[0].get_text()
    assert 'Keep this text' in result[0].get_text()
    pixmap = result[0].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    image = Image.frombytes('RGB', (pixmap.width, pixmap.height), pixmap.samples)
    crop = image.crop((int(rect.x0*2)+4, int(rect.y0*2)+4, int(rect.x1*2)-4, int(rect.y1*2)-4))
    ratio = sum(max(pixel) < 25 for pixel in crop.get_flattened_data())/(crop.width*crop.height)
    assert ratio > .98, (rotation, 'Redaction is not visually opaque', ratio)
    # OCR in the original reading orientation must see only the retained text.
    unrotated = image.rotate(rotation, expand=True)
    png = io.BytesIO()
    unrotated.save(png, format='PNG')
    text = subprocess.check_output([tesseract, 'stdin', 'stdout', '-l', 'eng', '--psm', '11'], input=png.getvalue(), stderr=subprocess.DEVNULL).decode()
    assert 'SECRET' not in text.upper() and 'FIXTURE' not in text.upper(), (rotation, text)
    assert 'Keep this text' in text, (rotation, text)
print('Visual redaction passed at 0, 90, 180 and 270 degrees: opaque pixels, no secret in OCR or extracted text, retained text readable.')
