#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
export PYTHONPATH="$root_dir/.document-python${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
export DOCUMENT_CONVERTER_BIN="${DOCUMENT_CONVERTER_BIN:-$(command -v soffice)}"
export TESSERACT_BIN="${TESSERACT_BIN:-$(command -v tesseract)}"
export TESSDATA_PREFIX="${TESSDATA_PREFIX:-$root_dir/.ocr/tessdata}"
"$DOCUMENT_CONVERTER_BIN" --headless --version
"${DOCUMENT_CONVERTER_PYTHON:-python3}" scripts/test-editable-conversion.py
