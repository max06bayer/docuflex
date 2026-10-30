#!/usr/bin/env bash
# Turns a finished Linux package (the Tauri .deb or the Arch .pkg.tar.zst) into
# the Electron build: same offline resources, but the window runs in Chromium,
# which renders the editor far faster than WebKitGTK.
#
#   package-linux-electron.sh deb|arch INPUT_PACKAGE OUTPUT_DIR VERSION [FRONTEND_BUILD]
#
# FRONTEND_BUILD optionally replaces resources/frontend (a `npm run build` output
# made with DOCUFLEX_DESKTOP_ORIGIN=http://127.0.0.1:43127).
set -euo pipefail

FORMAT=${1:?Pass deb or arch.}
INPUT=$(realpath "${2:?Pass the input package.}")
OUTPUT_DIR=${3:?Pass the output directory.}
VERSION=${4:?Pass the version, for example 0.9.6.}
FRONTEND_BUILD=${5:-}
REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SHELL_SOURCE="$REPOSITORY_ROOT/desktop/electron-linux"
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT
ROOT="$WORK/root"
mkdir -p "$ROOT" "$OUTPUT_DIR"
OUTPUT_DIR=$(realpath "$OUTPUT_DIR")

case "$FORMAT" in
  deb)
    (cd "$WORK" && ar x "$INPUT")
    tar -xf "$WORK"/data.tar.* -C "$ROOT"
    ;;
  arch)
    bsdtar -xf "$INPUT" -C "$ROOT" --exclude .PKGINFO --exclude .MTREE --exclude .BUILDINFO --exclude .INSTALL
    ;;
  *)
    echo "Unknown format $FORMAT." >&2
    exit 1
    ;;
esac

RESOURCES="$ROOT/usr/lib/Docuflex/resources"
test -d "$RESOURCES/runtime"
if [ -n "$FRONTEND_BUILD" ]; then
  grep -q 'export const origin = "http://127.0.0.1:43127"' "$FRONTEND_BUILD/adapter-node.js"
  rm -rf "$RESOURCES/frontend"
  cp -r "$FRONTEND_BUILD" "$RESOURCES/frontend"
fi

# Electron's postinstall download is skipped by npm's script policy; run it directly.
npm ci --prefix "$SHELL_SOURCE" --no-audit --no-fund
node "$SHELL_SOURCE/node_modules/electron/install.js"

ELECTRON="$ROOT/usr/lib/Docuflex/electron"
rm -rf "$ELECTRON"
cp -a "$SHELL_SOURCE/node_modules/electron/dist" "$ELECTRON"
install -d "$ELECTRON/resources/app"
install -m644 "$SHELL_SOURCE/"{package.json,main.cjs,preload.cjs,icon.png} "$ELECTRON/resources/app/"
install -m644 "$REPOSITORY_ROOT/desktop/runtime/chrome.js" "$ELECTRON/resources/app/chrome.js"
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$ELECTRON/resources/app/package.json"
chmod 4755 "$ELECTRON/chrome-sandbox"

rm -f "$ROOT/usr/bin/docuflex-desktop" "$ROOT/usr/bin/docuflex-launcher"
install -Dm755 /dev/stdin "$ROOT/usr/bin/docuflex-desktop" <<'EOF'
#!/bin/sh
export DOCUFLEX_RESOURCES=/usr/lib/Docuflex/resources
exec /usr/lib/Docuflex/electron/electron "$@"
EOF
# The .deb's menu entry starts the old WebKit launcher.
ln -s docuflex-desktop "$ROOT/usr/bin/docuflex-launcher"

SIZE_KIB=$(du -sk "$ROOT/usr" | awk '{print $1}')

if [ "$FORMAT" = deb ]; then
  CONTROL="$WORK/control"
  mkdir -p "$CONTROL"
  cat > "$CONTROL/control" <<EOF
Package: docuflex
Version: $VERSION
Architecture: amd64
Installed-Size: $SIZE_KIB
Maintainer: Maximilian Bayer
Priority: optional
Depends: libgtk-3-0, libnss3, libgbm1, libasound2t64 | libasound2 (>= 1.1), libdrm2, libxkbcommon0
Description: Docuflex offline PDF editor
EOF
  (cd "$ROOT" && find usr -type f -print0 | sort -z | xargs -0 md5sum) > "$CONTROL/md5sums"
  printf '2.0\n' > "$WORK/debian-binary"
  tar --owner=0 --group=0 --numeric-owner -czf "$WORK/control.tar.gz" -C "$CONTROL" control md5sums
  tar --owner=0 --group=0 --numeric-owner -czf "$WORK/data.tar.gz" -C "$ROOT" usr
  OUTPUT="$OUTPUT_DIR/Docuflex_${VERSION}_amd64.deb"
  rm -f "$OUTPUT"
  (cd "$WORK" && ar rc "$OUTPUT" debian-binary control.tar.gz data.tar.gz)
else
  cat > "$ROOT/.PKGINFO" <<EOF
pkgname = docuflex
pkgbase = docuflex
pkgver = $VERSION-1
pkgdesc = Docuflex offline PDF editor
url = https://github.com/max06bayer/docuflex
builddate = $(date +%s)
packager = Docuflex
size = $((SIZE_KIB * 1024))
arch = x86_64
license = custom
depend = gtk3
depend = nss
depend = alsa-lib
depend = libayatana-appindicator
depend = librsvg
depend = poppler
depend = tesseract
EOF
  OUTPUT="$OUTPUT_DIR/docuflex-$VERSION-1-x86_64.pkg.tar.zst"
  rm -f "$OUTPUT"
  (cd "$ROOT" && bsdtar --zstd --uid 0 --gid 0 --uname root --gname root -cf "$OUTPUT" .PKGINFO usr)
fi
echo "$OUTPUT"
