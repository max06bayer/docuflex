#!/usr/bin/env python3
"""Build Docuflex PDF text-editor edits translated locally with Argos.

Text is translated a paragraph at a time rather than one text run at a time:
wrapped lines are joined, translated together (so the model sees whole
sentences), and the translation is then spread back over the original runs in
proportion to their length so each line keeps its position and styling.
"""

from __future__ import annotations

import json
import re
import sys
import traceback
from collections import defaultdict
from pathlib import Path

import argostranslate.package
import argostranslate.translate
import fitz

SENTENCE_END = re.compile(r"[.!?:;…)\]\"'»”]$")
# A wrapped line is at least this share of the widest line in its block.
WRAPPED_LINE_RATIO = 0.6


def installed_translation(source: str, target: str):
    try:
        return argostranslate.translate.get_translation_from_codes(source, target)
    except Exception:
        return None


def install_language_path(source: str, target: str) -> None:
    if installed_translation(source, target) is not None:
        return

    try:
        argostranslate.package.update_package_index()
    except Exception as error:
        raise RuntimeError(
            f"Could not download the {source.upper()} to {target.upper()} language model. Check your internet connection and try again."
        ) from error
    available = argostranslate.package.get_available_packages()
    pairs = [(source, target)] if source == "en" or target == "en" else [(source, "en"), ("en", target)]
    for from_code, to_code in pairs:
        if installed_translation(from_code, to_code) is not None:
            continue
        package = next((item for item in available if item.from_code == from_code and item.to_code == to_code), None)
        if package is None:
            raise RuntimeError(f"Local translation does not have a {from_code.upper()} to {to_code.upper()} language model.")
        try:
            argostranslate.package.install_from_path(package.download())
        except Exception as error:
            raise RuntimeError(
                f"Could not download the {from_code.upper()} to {to_code.upper()} language model. Check your internet connection and try again."
            ) from error

    if installed_translation(source, target) is None:
        raise RuntimeError(f"Could not prepare the {source.upper()} to {target.upper()} translation model.")


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace(" ", " ")).strip()


CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_translation(value: str) -> str:
    # Models occasionally echo control characters; they are not drawable text.
    return normalized_text(CONTROL_CHARACTERS.sub("", value))


def has_letters(value: str) -> bool:
    return any(character.isalpha() for character in value)


def is_all_caps(value: str) -> bool:
    letters = [character for character in value if character.isalpha()]
    return len(letters) > 1 and all(character.isupper() for character in letters)


class Translator:
    def __init__(self, translation):
        self.translation = translation
        self.cache: dict[str, str] = {}

    def translate(self, value: str) -> str:
        original = normalized_text(value)
        if not original or not has_letters(original):
            return original
        if original not in self.cache:
            translated = clean_translation(self.translation.translate(original))
            self.cache[original] = translated.upper() if is_all_caps(original) else translated
        return self.cache[original]


def rgb_color(value: int) -> list[float]:
    return [
        ((value >> 16) & 255) / 255,
        ((value >> 8) & 255) / 255,
        (value & 255) / 255,
    ]


def pdf_rectangle(span: dict, page_height: float) -> list[float]:
    left, top, right, bottom = (float(value) for value in span["bbox"])
    return [left, page_height - bottom, right, page_height - top]


def line_spans(line: dict) -> list[dict]:
    return [span for span in line.get("spans", []) if normalized_text(str(span.get("text", "")))]


def line_text(spans: list[dict]) -> str:
    return normalized_text(" ".join(str(span.get("text", "")) for span in spans))


def paragraphs(block: dict) -> list[list[list[dict]]]:
    """Groups a text block's lines into paragraphs of wrapped lines."""
    lines = [spans for spans in (line_spans(line) for line in block.get("lines", [])) if spans]
    if not lines:
        return []
    widths = [float(spans[-1]["bbox"][2]) - float(spans[0]["bbox"][0]) for spans in lines]
    widest = max(widths) or 1.0
    groups = [[lines[0]]]
    for index in range(1, len(lines)):
        previous = line_text(lines[index - 1])
        wraps = (
            widths[index - 1] >= widest * WRAPPED_LINE_RATIO
            and (previous.endswith("-") or not SENTENCE_END.search(previous))
            and abs(float(lines[index][0].get("size", 0)) - float(lines[index - 1][0].get("size", 0))) < 0.6
        )
        if wraps:
            groups[-1].append(lines[index])
        else:
            groups.append([lines[index]])
    return groups


def join_lines(lines: list[str]) -> str:
    text = ""
    for line in lines:
        if text.endswith("-") and line[:1].islower():
            text = text[:-1] + line
        else:
            text = f"{text} {line}" if text else line
    return text


def distribute(words: list[str], weights: list[int]) -> list[str] | None:
    """Splits words over slots in proportion to each slot's original length."""
    if len(words) < len(weights):
        return None
    total_weight = sum(weights) or 1
    total_chars = sum(len(word) + 1 for word in words)
    chunks: list[str] = []
    start = 0
    consumed_weight = 0
    for index, weight in enumerate(weights):
        remaining_slots = len(weights) - index - 1
        if remaining_slots == 0:
            end = len(words)
        else:
            consumed_weight += weight
            goal = total_chars * consumed_weight / total_weight
            end = start + 1
            running = sum(len(word) + 1 for word in words[:end])
            while end < len(words) - remaining_slots and running + (len(words[end]) + 1) / 2 <= goal:
                running += len(words[end]) + 1
                end += 1
        chunks.append(" ".join(words[start:end]))
        start = end
    return chunks


def translated_runs(group: list[list[dict]], translator: Translator) -> list[tuple[dict, str]]:
    spans = [span for line in group for span in line]
    if len(group) == 1 and len(spans) == 1:
        return [(spans[0], translator.translate(str(spans[0].get("text", ""))))]

    paragraph = join_lines([line_text(line) for line in group])
    if not has_letters(paragraph):
        return []
    words = translator.translate(paragraph).split(" ")
    chunks = distribute(words, [max(1, len(normalized_text(str(span.get("text", ""))))) for span in spans])
    if chunks is None:
        return [(span, translator.translate(str(span.get("text", "")))) for span in spans]
    return list(zip(spans, chunks))


def build_edits(input_path: Path, source: str, target: str) -> list[dict]:
    install_language_path(source, target)
    translation = installed_translation(source, target)
    if translation is None:
        raise RuntimeError(f"The {source.upper()} to {target.upper()} language model is not installed. Download it first.")
    translator = Translator(translation)
    try:
        document = fitz.open(input_path)
    except Exception as error:
        raise RuntimeError("This PDF is damaged or uses a format that can't be read.") from error
    if document.needs_pass:
        raise RuntimeError("This PDF is password protected. Unlock it before translating.")
    edits = []
    found_text = False

    for page_number, page in enumerate(document):
        occurrences: defaultdict[str, int] = defaultdict(int)
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for group in paragraphs(block):
                for span, new_text in translated_runs(group, translator):
                    raw_text = str(span.get("text", ""))
                    old_text = normalized_text(raw_text)
                    if not old_text:
                        continue
                    # Count every run, translated or not, so occurrence indexes match the editor's.
                    occurrence = occurrences[old_text]
                    occurrences[old_text] += 1
                    if not has_letters(old_text):
                        continue
                    found_text = True
                    if not new_text or new_text == old_text:
                        continue
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
                        "oldTextCandidates": [old_text, raw_text],
                        "newText": new_text,
                    })

    document.close()
    if not found_text:
        raise RuntimeError("This PDF has no selectable text to translate. Run OCR on scanned pages first.")
    if not edits:
        raise RuntimeError("The text in this PDF already appears to be in the target language.")
    return edits


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("Usage: translate-pdf-local.py INPUT.pdf EDITS.json SOURCE TARGET")
    try:
        edits = build_edits(Path(sys.argv[1]), sys.argv[3].lower(), sys.argv[4].lower())
    except RuntimeError as error:
        # The route shows this line to the user as the reason.
        print(f"DOCUFLEX_ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
    except MemoryError:
        print("DOCUFLEX_ERROR: This PDF needs more memory to translate than is available.", file=sys.stderr)
        raise SystemExit(2)
    except Exception as error:
        traceback.print_exc()
        reason = f"{type(error).__name__}: {error}".replace("\n", " ")
        print(f"DOCUFLEX_CRASH: {reason}", file=sys.stderr)
        raise SystemExit(3)
    Path(sys.argv[2]).write_text(json.dumps({"edits": edits}, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
