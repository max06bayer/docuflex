#!/usr/bin/env python3
import re
import sys
from pathlib import Path

from PIL import Image
from reportlab.pdfgen import canvas


def natural_key(path):
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", path.name)]


def main():
    if len(sys.argv) != 4:
        raise RuntimeError("Expected output path, render DPI, and page-image directory.")
    output_path, dpi_value, image_directory = sys.argv[1:]
    dpi = max(36, int(dpi_value))
    images = sorted(Path(image_directory).glob("page-*.jpg"), key=natural_key)
    if not images:
        raise RuntimeError("The PDF renderer did not create any compressed page images.")

    document = canvas.Canvas(output_path, pageCompression=1)
    for image_path in images:
        with Image.open(image_path) as image:
            width = image.width * 72 / dpi
            height = image.height * 72 / dpi
        document.setPageSize((width, height))
        document.drawImage(str(image_path), 0, 0, width=width, height=height, preserveAspectRatio=True, mask='auto')
        document.showPage()
    document.save()


if __name__ == "__main__":
    main()
