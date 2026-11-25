#!/usr/bin/env python3
"""Bundled Store raster helper. Inputs are private pipes; no network or file-path arguments."""
import io
import json
import math
import os
import threading
import struct
import sys
import zlib
from PIL import Image, ImageDraw, ImageFilter

MAX_PIXELS = 40_000_000
MAX_BYTES = 160 * 1024 * 1024
MAGIC = 0x44465232
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def dimensions(width, height):
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise ValueError("Raster exceeds safe dimensions")


def encode(image, jpeg=False, bounds=()):
    dimensions(*image.size)
    rgb = image.convert("RGB")
    pixels = zlib.compress(rgb.tobytes(), 6)
    codec = 0
    if jpeg and len(pixels) > 1_500_000:
        output = io.BytesIO()
        rgb.save(output, format="JPEG", quality=90)
        pixels = output.getvalue()
        codec = 1
    alpha = b""
    if "A" in image.getbands():
        channel = image.getchannel("A")
        if channel.getextrema() != (255, 255):
            alpha = zlib.compress(channel.tobytes(), 6)
    return struct.pack(">7I", MAGIC, image.width, image.height, codec, len(pixels), len(alpha), len(bounds)) + pixels + alpha + b"".join(struct.pack(">4d", *box) for box in bounds)


def decode_frame(data):
    if len(data) < 28:
        raise ValueError("Truncated raster")
    magic, width, height, codec, size, alpha_size, count = struct.unpack(">7I", data[:28])
    dimensions(width, height)
    if magic != MAGIC or size + alpha_size + 28 + count * 32 != len(data):
        raise ValueError("Invalid raster frame")
    pixels = data[28:28 + size]
    if codec == 1:
        return Image.open(io.BytesIO(pixels)).convert("RGB")
    inflater = zlib.decompressobj()
    raw = inflater.decompress(pixels, width * height * 3 + 1)
    if not inflater.eof or len(raw) != width * height * 3:
        raise ValueError("Invalid raster length")
    return Image.frombytes("RGB", (width, height), raw)


def main():
    line = sys.stdin.buffer.readline(8 * 1024 * 1024 + 1)
    if len(line) > 8 * 1024 * 1024 or not line.endswith(b"\n"):
        raise ValueError("Raster geometry exceeds safe limits")
    params = json.loads(line)
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Raster input exceeds safe limits")
    operation = sys.argv[1]
    if operation == "image":
        with Image.open(io.BytesIO(data)) as image:
            dimensions(*image.size)
            image.load()
            result = encode(image.convert("RGBA"))
    elif operation == "render":
        import fitz
        dpi = float(params["dpi"])
        if not math.isfinite(dpi) or not 1 <= dpi <= 300:
            raise ValueError("Invalid raster resolution")
        with fitz.open(stream=data, filetype="pdf") as document:
            page = document[int(params["page"])]
            dimensions(math.ceil(page.rect.width * dpi / 72), math.ceil(page.rect.height * dpi / 72))
            pixmap = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), colorspace=fitz.csRGB, alpha=False, annots=True)
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
            # Keep glyph coverage tied to the renderer used for these pixels.
            # These extra bounds also prevent PDFBox from restoring affected text.
            extra_bounds = []
            extra_black = []
            if params.get("redacting"):
                original_polygons = params.get("polygons", [])
                original_colors = params.get("black", [])
                for block in page.get_text("rawdict")["blocks"]:
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            for char in span.get("chars", []):
                                if not char.get("c", "").strip():
                                    continue
                                rect = fitz.Rect(char["bbox"]) * page.rotation_matrix
                                for polygon, black in zip(original_polygons, original_colors, strict=True):
                                    region = fitz.Rect(min(p[0] for p in polygon), min(p[1] for p in polygon), max(p[0] for p in polygon), max(p[1] for p in polygon))
                                    if not rect.intersects(region):
                                        continue
                                    if rect.height > page.rect.height * .25 or rect.width > page.rect.width * .5:
                                        continue
                                    pad = max(.75, rect.height * .06)
                                    extra_bounds.append((rect.x0-pad, rect.y0-pad, rect.x1+pad, rect.y1+pad))
                                    extra_black.append(black)
                                    break
        width, height = params["display"]
        if not (math.isfinite(width) and math.isfinite(height) and width > 0 and height > 0):
            raise ValueError("Invalid page dimensions")
        draw = ImageDraw.Draw(image)
        for polygon, black in zip(params.get("polygons", []), params.get("black", []), strict=True):
            if len(polygon) != 4 or not all(math.isfinite(c) for point in polygon for c in point):
                raise ValueError("Invalid redaction polygon")
            points = [(x * image.width / width, y * image.height / height) for x, y in polygon]
            color = "black" if black else "white"
            draw.polygon(points, fill=color)
            draw.line(points + [points[0]], fill=color, width=4, joint="curve")
        for box, black in zip(extra_bounds, extra_black, strict=True):
            left, top, right, bottom = box
            points = [(x * image.width / width, y * image.height / height) for x, y in [(left, top), (right, top), (right, bottom), (left, bottom)]]
            color = "black" if black else "white"
            draw.polygon(points, fill=color)
            draw.line(points + [points[0]], fill=color, width=4, joint="curve")
        result = encode(image, jpeg=bool(params.get("redacting")), bounds=extra_bounds)
    elif operation == "blur":
        source = decode_frame(data)
        box = tuple(map(int, params["box"]))
        left, top, right, bottom = box
        if not (0 <= left < right <= source.width and 0 <= top < bottom <= source.height):
            raise ValueError("Invalid blur bounds")
        radius = max(1, min(15, int(params["radius"])))
        crop = source.crop(box)
        blurred = crop.filter(ImageFilter.BoxBlur(radius))
        # Match the existing ConvolveOp EDGE_NO_OP behavior at the crop boundary.
        if crop.width > radius * 2 and crop.height > radius * 2:
            crop.paste(blurred.crop((radius, radius, crop.width-radius, crop.height-radius)), (radius, radius))
        result = encode(crop)
    else:
        raise ValueError("Unknown raster operation")
    sys.stdout.buffer.write(result)


if __name__ == "__main__":
    parent = os.getppid()
    def watch_parent():
        while not threading.Event().wait(.25):
            if os.getppid() != parent:
                os._exit(75)
    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        main()
    except Exception as error:
        print("Native raster helper failed: " + type(error).__name__, file=sys.stderr)
        sys.exit(2)
