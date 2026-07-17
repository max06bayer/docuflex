#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$root_dir/.document-python"
python_bin="${DOCUMENT_CONVERTER_PYTHON:-python3}"

if [[ -f "$runtime_dir/argostranslate/__init__.py" && -f "$runtime_dir/fitz/__init__.py" ]]; then
  echo "Python document tools are already installed."
  exit 0
fi

pip_command=()
if "$python_bin" -m pip --version >/dev/null 2>&1; then
  pip_command=("$python_bin" -m pip)
elif command -v pip3 >/dev/null 2>&1; then
  pip_command=(pip3)
elif command -v pip >/dev/null 2>&1; then
  pip_command=(pip)
else
  echo "A Python pip executable is required to install document tools." >&2
  exit 1
fi

"${pip_command[@]}" install \
  --disable-pip-version-check \
  --no-input \
  --only-binary=:all: \
  --target "$runtime_dir" \
  'argostranslate==1.11.0' \
  'PyMuPDF==1.26.7'

test -f "$runtime_dir/argostranslate/__init__.py"
test -f "$runtime_dir/fitz/__init__.py"
