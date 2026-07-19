#!/usr/bin/env bash
set -euo pipefail

DEB_ROOT=${1:?Pass the extracted Debian package root.}
OUTPUT_DIR=${2:?Pass the package output directory.}
REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DESKTOP_ROOT="$REPOSITORY_ROOT/desktop"
TAURI_ROOT="$DESKTOP_ROOT/src-tauri"
PACKAGE_ROOT=$(mktemp -d)
trap 'rm -rf -- "$PACKAGE_ROOT"' EXIT

RESOURCE_SOURCE=$(find "$DEB_ROOT/usr/lib" -mindepth 1 -maxdepth 1 -type d -print -quit)
test -n "$RESOURCE_SOURCE"
RESOURCE_NAME=$(basename "$RESOURCE_SOURCE")

rm -rf -- "$TAURI_ROOT/resources" "$DESKTOP_ROOT/dist"
mkdir -p "$TAURI_ROOT/resources" "$DESKTOP_ROOT/dist"
cp -a "$RESOURCE_SOURCE/." "$TAURI_ROOT/resources/"
printf '%s\n' '<!doctype html><html><body></body></html>' > "$DESKTOP_ROOT/dist/index.html"

npm ci --prefix "$DESKTOP_ROOT"
node "$DESKTOP_ROOT/node_modules/@tauri-apps/cli/tauri.js" icon \
  "$REPOSITORY_ROOT/public/macos-icon-iOS-Default-1024x1024@1x.png" \
  --output "$TAURI_ROOT/icons"
cargo build --release --manifest-path "$TAURI_ROOT/Cargo.toml"

install -Dm755 "$TAURI_ROOT/target/release/docuflex-desktop" \
  "$PACKAGE_ROOT/usr/bin/docuflex-desktop"
mkdir -p "$PACKAGE_ROOT/usr/lib/$RESOURCE_NAME"
cp -a "$RESOURCE_SOURCE/." "$PACKAGE_ROOT/usr/lib/$RESOURCE_NAME/"

# The Debian payload carries Ubuntu-compatible OCR binaries for AppImage and
# Debian users. A native Arch package must use current Arch Poppler/Tesseract
# binaries instead of mixing Ubuntu ELF dependencies with rolling libraries.
for tool in pdftoppm pdfunite tesseract; do
  install -Dm755 /dev/stdin \
    "$PACKAGE_ROOT/usr/lib/$RESOURCE_NAME/runtime/ocr/bin/$tool" <<EOF
#!/bin/sh
exec /usr/bin/$tool "\$@"
EOF
done

# pdf2htmlEX remains the checksum-pinned extracted AppImage build, but its
# launcher needs only the payload's legacy libxml2 soname on rolling Arch.
PDF2HTML_RUNTIME="$PACKAGE_ROOT/usr/lib/$RESOURCE_NAME/runtime/pdf2htmlEX"
mkdir -p "$PDF2HTML_RUNTIME/compat"
LIBXML_SOURCE=$(find "$PDF2HTML_RUNTIME/app" -type f -name 'libxml2.so.2*' -print -quit)
if [ -z "$LIBXML_SOURCE" ]; then
  echo 'Bundled pdf2htmlEX payload does not contain libxml2.so.2.' >&2
  exit 1
fi
cp -L "$LIBXML_SOURCE" "$PDF2HTML_RUNTIME/compat/libxml2.so.2"
install -Dm755 /dev/stdin \
  "$PDF2HTML_RUNTIME/bin/pdf2htmlEX" <<'EOF'
#!/bin/bash
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT="$SCRIPT_DIR/../app"
export APPDIR="$APP_ROOT"
export LD_LIBRARY_PATH="$SCRIPT_DIR/../compat${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

normalized_args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--embed" ] && [ "$#" -ge 2 ] && [ "$2" = "1" ]; then
    normalized_args+=(--embed-css 1 --embed-font 1 --embed-image 1 --embed-javascript 1 --embed-outline 1)
    shift 2
    continue
  fi
  normalized_args+=("$1")
  shift
done
exec "$APP_ROOT/AppRun" "${normalized_args[@]}"
EOF
install -Dm644 "$TAURI_ROOT/icons/128x128.png" \
  "$PACKAGE_ROOT/usr/share/icons/hicolor/128x128/apps/docuflex.png"
install -Dm644 /dev/stdin "$PACKAGE_ROOT/usr/share/applications/docuflex.desktop" <<'EOF'
[Desktop Entry]
Categories=Office;
Comment=Offline PDF editor
Exec=docuflex-desktop %F
Icon=docuflex
MimeType=application/pdf;
Name=Docuflex
StartupWMClass=docuflex-desktop
Terminal=false
Type=Application
EOF

PACKAGE_SIZE=$(du -sk "$PACKAGE_ROOT/usr" | awk '{print $1 * 1024}')
cat > "$PACKAGE_ROOT/.PKGINFO" <<EOF
pkgname = docuflex
pkgbase = docuflex
pkgver = 0.0.1-1
pkgdesc = Docuflex offline PDF editor
url = https://github.com/max06bayer/docuflex
builddate = $(date +%s)
packager = Docuflex GitHub Actions
size = $PACKAGE_SIZE
arch = x86_64
license = custom
depend = webkit2gtk-4.1
depend = gtk3
depend = libayatana-appindicator
depend = librsvg
depend = poppler
depend = tesseract
EOF

mkdir -p "$OUTPUT_DIR"
(cd "$PACKAGE_ROOT" && bsdtar --zstd -cf \
  "$OUTPUT_DIR/docuflex-0.0.1-1-x86_64.pkg.tar.zst" .PKGINFO usr)

ldd "$PACKAGE_ROOT/usr/bin/docuflex-desktop" | tee "$OUTPUT_DIR/docuflex-arch-ldd.txt"
if grep -q 'not found' "$OUTPUT_DIR/docuflex-arch-ldd.txt"; then
  echo 'Arch-built Docuflex has unresolved native libraries.' >&2
  exit 1
fi
