#!/usr/bin/env python3
"""Build Docuflex PDF text-editor edits translated locally with Argos."""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import argostranslate.package
import argostranslate.translate
import fitz


def installed_translation(source: str, target: str):
    try:
        return argostranslate.translate.get_translation_from_codes(source, target)
    except Exception:
        return None


def install_language_path(source: str, target: str) -> None:
    if installed_translation(source, target) is not None:
        return

    argostranslate.package.update_package_index()
    available = argostranslate.package.get_available_packages()
    pairs = [(source, target)] if source == "en" or target == "en" else [(source, "en"), ("en", target)]
    for from_code, to_code in pairs:
        if installed_translation(from_code, to_code) is not None:
            continue
        package = next((item for item in available if item.from_code == from_code and item.to_code == to_code), None)
        if package is None:
            raise RuntimeError(f"Local translation does not have a {from_code.upper()} to {to_code.upper()} language model.")
        argostranslate.package.install_from_path(package.download())

    if installed_translation(source, target) is None:
        raise RuntimeError(f"Could not prepare the {source.upper()} to {target.upper()} translation model.")


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\u00a0", " ")).strip()


def translate_text(value: str, translator) -> str:
    original = normalized_text(value)
    if not original or not any(character.isalpha() for character in original):
        return original
    translated = normalized_text(translator.translate(original))
    letters = [character for character in original if character.isalpha()]
    if len(letters) > 1 and all(character.isupper() for character in letters):
        translated = translated.upper()
    return translated


def rgb_color(value: int) -> list[float]:
    return [
        ((value >> 16) & 255) / 255,
        ((value >> 8) & 255) / 255,
        (value & 255) / 255,
    ]


def pdf_rectangle(span: dict, page_height: float) -> list[float]:
    left, top, right, bottom = (float(value) for value in span["bbox"])
    return [left, page_height - bottom, right, page_height - top]


def build_edits(input_path: Path, source: str, target: str) -> list[dict]:
    install_language_path(source, target)
    translator = argostranslate.translate.get_translation_from_codes(source, target)
    document = fitz.open(input_path)
    edits = []

    for page_number, page in enumerate(document):
        occurrences: defaultdict[str, int] = defaultdict(int)
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    old_text = normalized_text(str(span.get("text", "")))
                    if not old_text or not any(character.isalpha() for character in old_text):
                        continue
                    new_text = translate_text(old_text, translator)
                    if not new_text or new_text == old_text:
                        continue
                    occurrence = occurrences[old_text]
                    occurrences[old_text] += 1
                    rectangle = pdf_rectangle(span, page.rect.height)
                    flags = int(span.get("flags", 0))
                    edits.append({
                        "kind": "text",
                        "id": f"translate-{page_number}-{len(edits)}",
                        "page": page_number,
                        "occurrence": occurrence,
                        "rect": rectangle,
                        "alignRect": rectangle,
                        "visualRect": rectangle,
                        "originalRect": rectangle,
                        "pageSize": [float(page.rect.width), float(page.rect.height)],
                        "fontSize": float(span.get("size", 0)),
                        "fontName": str(span.get("font", "")),
                        "bold": bool(flags & 16),
                        "italic": bool(flags & 2),
                        "fontChanged": False,
                        "boldChanged": False,
                        "italicChanged": False,
                        "moved": False,
                        "overlay": False,
                        "alignment": "",
                        "letterSpacing": 0,
                        "color": rgb_color(int(span.get("color", 0))),
                        "oldText": old_text,
                        "oldTextCandidates": [old_text, str(span.get("text", ""))],
                        "newText": new_text,
                    })

    document.close()
    if not edits:
        raise RuntimeError("This PDF has no selectable text to translate. Run OCR on scanned pages first.")
    return edits


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("Usage: translate-pdf-local.py INPUT.pdf EDITS.json SOURCE TARGET")
    edits = build_edits(Path(sys.argv[1]), sys.argv[3].lower(), sys.argv[4].lower())
    Path(sys.argv[2]).write_text(json.dumps({"edits": edits}, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
