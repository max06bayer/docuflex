#!/bin/bash
set -euo pipefail

RUNTIME_ROOT=${1:?Pass the Linux runtime output directory.}
case "$RUNTIME_ROOT" in
  */desktop/.native-runtime/linux) ;;
  *) echo "Refusing unexpected runtime output path: $RUNTIME_ROOT" >&2; exit 2 ;;
esac

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  curl libarchive-tools libreoffice-writer pax-utils poppler-utils \
  tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng tesseract-ocr-osd

rm -rf -- "$RUNTIME_ROOT"
mkdir -p "$RUNTIME_ROOT/pdf2htmlEX/bin" "$RUNTIME_ROOT/pdf2htmlEX/share" \
  "$RUNTIME_ROOT/ocr/bin" "$RUNTIME_ROOT/ocr/lib" "$RUNTIME_ROOT/ocr/share/tessdata" \
  "$RUNTIME_ROOT/office"

PDF2HTMLEX_URL=https://github.com/pdf2htmlEX/pdf2htmlEX/releases/download/v0.18.8.rc1/pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.AppImage
PDF2HTMLEX_SHA256=11de2583a3abce5f141fd7fafb1fea2c67b15886e546d6b7675c600012e6ab8c
PDF2HTMLEX_IMAGE="$RUNTIME_ROOT/pdf2htmlEX.AppImage"
curl -L --fail --retry 3 "$PDF2HTMLEX_URL" -o "$PDF2HTMLEX_IMAGE"
echo "$PDF2HTMLEX_SHA256  $PDF2HTMLEX_IMAGE" | sha256sum --check --strict
chmod +x "$PDF2HTMLEX_IMAGE"
EXTRACT_ROOT="$RUNTIME_ROOT/pdf2htmlEX-extract"
mkdir -p "$EXTRACT_ROOT"
(cd "$EXTRACT_ROOT" && "$PDF2HTMLEX_IMAGE" --appimage-extract >/dev/null)
mv "$EXTRACT_ROOT/squashfs-root" "$RUNTIME_ROOT/pdf2htmlEX/app"
cp -a "$RUNTIME_ROOT/pdf2htmlEX/app/usr/local/share/pdf2htmlEX" "$RUNTIME_ROOT/pdf2htmlEX/share/pdf2htmlEX"
cp desktop/runtime/pdf2htmlEX-linux-wrapper.sh "$RUNTIME_ROOT/pdf2htmlEX/bin/pdf2htmlEX"
chmod +x "$RUNTIME_ROOT/pdf2htmlEX/bin/pdf2htmlEX"
cat > "$RUNTIME_ROOT/pdf2htmlEX/SOURCE.txt" <<'EOF'
Linux x86_64 pdf2htmlEX 0.18.8.rc1 official Ubuntu focal AppImage.
Source: https://github.com/pdf2htmlEX/pdf2htmlEX/tree/v0.18.8.rc1
Archive SHA-256: 11de2583a3abce5f141fd7fafb1fea2c67b15886e546d6b7675c600012e6ab8c
EOF
rm -rf -- "$EXTRACT_ROOT" "$PDF2HTMLEX_IMAGE"

copy_elf_dependencies() {
  local executable=$1
  while IFS= read -r library; do
    case "$library" in
      /lib/*|/lib64/*|/usr/lib/*)
        cp -L -n "$library" "$RUNTIME_ROOT/ocr/lib/$(basename "$library")" || true
        ;;
    esac
  done < <(lddtree -l "$executable")
}

for tool in pdftoppm pdfunite tesseract; do
  source_path=$(command -v "$tool")
  cp -L "$source_path" "$RUNTIME_ROOT/ocr/bin/$tool-native"
  cp desktop/runtime/native-tool-linux-wrapper.sh "$RUNTIME_ROOT/ocr/bin/$tool"
  chmod +x "$RUNTIME_ROOT/ocr/bin/$tool" "$RUNTIME_ROOT/ocr/bin/$tool-native"
  copy_elf_dependencies "$source_path"
done

for data in eng deu osd; do
  source_data=$(find /usr/share -path "*/tessdata/$data.traineddata" -print -quit)
  test -n "$source_data"
  cp "$source_data" "$RUNTIME_ROOT/ocr/share/tessdata/$data.traineddata"
done
mkdir -p "$RUNTIME_ROOT/ocr/licenses"
for package in poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu tesseract-ocr-osd; do
  if [ -f "/usr/share/doc/$package/copyright" ]; then
    cp "/usr/share/doc/$package/copyright" "$RUNTIME_ROOT/ocr/licenses/$package-copyright.txt"
  fi
done

# Dereference Ubuntu's links into /usr/share/libreoffice so the packaged
# runtime remains self-contained after it leaves the build machine.
cp -aL /usr/lib/libreoffice/. "$RUNTIME_ROOT/office/"
chmod +x "$RUNTIME_ROOT/office/program/soffice" "$RUNTIME_ROOT/office/program/soffice.bin"

cat > "$RUNTIME_ROOT/ocr/SOURCE.txt" <<'EOF'
Linux x86_64 native runtime prepared on Ubuntu 22.04.
OCR: Ubuntu native Tesseract and Poppler packages with English, German, and OSD data.
EOF
cat > "$RUNTIME_ROOT/office/SOURCE.txt" <<'EOF'
Linux x86_64 native LibreOffice Writer runtime prepared from the Ubuntu 22.04 package.
EOF
