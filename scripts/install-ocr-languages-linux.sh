#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Skipping OCR language installation outside Linux."
  exit 0
fi

readonly TESSDATA_DIR="${TESSDATA_PREFIX:-$(pwd)/.ocr/tessdata}"
readonly TESSDATA_BASE_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0"

mkdir -p "$TESSDATA_DIR"

# OCRmyPDF and Tesseract also need the small renderer/config files shipped
# beside the language data. Copy the immutable Nix installation first, then
# add the languages Docuflex supports to our writable runtime directory.
system_tessdata="$(tesseract --list-langs 2>&1 | sed -n 's/^List of available languages in "\(.*\)".*/\1/p' | head -n 1)"
if [[ -n "$system_tessdata" && -d "$system_tessdata" ]]; then
  cp -R "$system_tessdata"/. "$TESSDATA_DIR"/
fi

install_language() {
  local language="$1"
  local expected_sha256="$2"
  local destination="$TESSDATA_DIR/$language.traineddata"
  local temporary="$destination.download"

  if [[ -f "$destination" ]] && echo "$expected_sha256  $destination" | sha256sum --check --status; then
    echo "OCR language $language is already installed."
    return
  fi

  curl --fail --location --retry 3 --silent --show-error \
    "$TESSDATA_BASE_URL/$language.traineddata" \
    --output "$temporary"
  echo "$expected_sha256  $temporary" | sha256sum --check --status
  mv "$temporary" "$destination"
  echo "Installed OCR language $language."
}

install_language eng 7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2
install_language deu 19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d
install_language osd 9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff
