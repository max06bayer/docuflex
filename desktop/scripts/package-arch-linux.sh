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
EOF

mkdir -p "$OUTPUT_DIR"
(cd "$PACKAGE_ROOT" && bsdtar --zstd -cf \
  "$OUTPUT_DIR/docuflex-0.0.1-1-x86_64.pkg.tar.zst" .PKGINFO usr)

ldd "$PACKAGE_ROOT/usr/bin/docuflex-desktop" | tee "$OUTPUT_DIR/docuflex-arch-ldd.txt"
if grep -q 'not found' "$OUTPUT_DIR/docuflex-arch-ldd.txt"; then
  echo 'Arch-built Docuflex has unresolved native libraries.' >&2
  exit 1
fi
