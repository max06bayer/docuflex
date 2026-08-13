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
INSTALLED_RESOURCE_ROOT="$PACKAGE_ROOT/usr/lib/$RESOURCE_NAME"
if [ -d "$INSTALLED_RESOURCE_ROOT/resources/runtime" ]; then
  RUNTIME_ROOT="$INSTALLED_RESOURCE_ROOT/resources/runtime"
else
  RUNTIME_ROOT="$INSTALLED_RESOURCE_ROOT/runtime"
fi
test -d "$RUNTIME_ROOT"

# The Debian payload carries Ubuntu-compatible OCR binaries for AppImage and
# Debian users. A native Arch package must use current Arch Poppler/Tesseract
# binaries instead of mixing Ubuntu ELF dependencies with rolling libraries.
for tool in pdftoppm pdfunite; do
  install -Dm755 /dev/stdin \
    "$RUNTIME_ROOT/ocr/bin/$tool" <<EOF
#!/bin/sh
exec /usr/bin/$tool "\$@"
EOF
done
install -Dm755 /dev/stdin "$RUNTIME_ROOT/ocr/bin/tesseract" <<'EOF'
#!/bin/bash
set -eu
arguments=()
for argument in "$@"; do
  if [ "$argument" = "pdf" ]; then
    arguments+=(-c textonly_pdf=0)
  fi
  arguments+=("$argument")
done
exec /usr/bin/tesseract "${arguments[@]}"
EOF

# pdf2htmlEX remains the checksum-pinned extracted AppImage build. Copy only
# sonames absent from rolling Arch into an isolated compatibility directory;
# exposing the payload's whole Ubuntu library tree would conflict with host
# GTK/GLib while resolving too little breaks on legacy ICU/libxml sonames.
PDF2HTML_RUNTIME="$RUNTIME_ROOT/pdf2htmlEX"
mkdir -p "$PDF2HTML_RUNTIME/compat"
for pass in 1 2 3 4 5 6 7 8; do
  missing_libraries=$(LD_LIBRARY_PATH="$PDF2HTML_RUNTIME/compat" \
    ldd "$PDF2HTML_RUNTIME/app/AppRun" | awk '/=> not found/ { print $1 }')
  [ -n "$missing_libraries" ] || break
  while IFS= read -r library; do
    [ -n "$library" ] || continue
    library_source=$(find "$PDF2HTML_RUNTIME/app" -name "$library" -print -quit)
    if [ -z "$library_source" ]; then
      echo "Bundled pdf2htmlEX payload does not contain $library." >&2
      exit 1
    fi
    cp -L "$library_source" "$PDF2HTML_RUNTIME/compat/$library"
  done <<EOF
$missing_libraries
EOF
done
if LD_LIBRARY_PATH="$PDF2HTML_RUNTIME/compat" \
  ldd "$PDF2HTML_RUNTIME/app/AppRun" | grep -q '=> not found'; then
  echo 'Bundled pdf2htmlEX still has unresolved Arch compatibility libraries.' >&2
  exit 1
fi
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
"$PDF2HTML_RUNTIME/bin/pdf2htmlEX" --version >/dev/null
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
