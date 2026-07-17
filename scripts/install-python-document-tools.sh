#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$root_dir/.document-python"
python_bin="${DOCUMENT_CONVERTER_PYTHON:-python3}"

if [[ -f "$runtime_dir/argostranslate/__init__.py" && -f "$runtime_dir/fitz/__init__.py" ]]; then
  echo "Python document tools are already installed."
  exit 0
fi

"$python_bin" -m pip install \
  --disable-pip-version-check \
  --no-input \
  --only-binary=:all: \
  --target "$runtime_dir" \
  'argostranslate==1.11.0' \
  'PyMuPDF==1.26.7'

test -f "$runtime_dir/argostranslate/__init__.py"
test -f "$runtime_dir/fitz/__init__.py"
