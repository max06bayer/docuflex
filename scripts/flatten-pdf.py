#!/usr/bin/env python3
"""Flatten PDF annotations/forms or rasterize every page."""

from __future__ import annotations

import sys
from pathlib import Path

import fitz


def flatten_standard(input_path: Path, output_path: Path) -> None:
    document = fitz.open(input_path)
    if document.needs_pass:
        document.close()
        raise RuntimeError("Password-protected PDFs must be unlocked before flattening.")
    document.bake(annots=True, widgets=True)
    document.save(output_path, garbage=4, deflate=True, clean=True)
    document.close()


def flatten_rasterized(input_path: Path, output_path: Path) -> None:
    source = fitz.open(input_path)
    if source.needs_pass:
        source.close()
        raise RuntimeError("Password-protected PDFs must be unlocked before rasterizing.")
    output = fitz.open()
    scale = 200 / 72
    for source_page in source:
        target_page = output.new_page(width=source_page.rect.width, height=source_page.rect.height)
        pixmap = source_page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, annots=True)
        target_page.insert_image(target_page.rect, stream=pixmap.tobytes("jpeg", jpg_quality=92))
    metadata = source.metadata
    if metadata:
        output.set_metadata(metadata)
    output.save(output_path, garbage=4, deflate=True)
    output.close()
    source.close()


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: flatten-pdf.py INPUT.pdf OUTPUT.pdf standard|rasterize")
    input_path, output_path, method = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    if method == "rasterize":
        flatten_rasterized(input_path, output_path)
    elif method == "standard":
        flatten_standard(input_path, output_path)
    else:
        raise RuntimeError("Unsupported flatten method.")


if __name__ == "__main__":
    main()
