#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  exit 0
fi

architecture="$(uname -m)"
if [[ "$architecture" != "x86_64" && "$architecture" != "amd64" ]]; then
  echo "pdf2htmlEX bundle supports Linux x86_64; found $architecture." >&2
  exit 1
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="$root_dir/.pdf2htmlex"
app_dir="$install_dir/squashfs-root"
app_image="$install_dir/pdf2htmlEX.AppImage"
download_url="https://github.com/pdf2htmlEX/pdf2htmlEX/releases/download/v0.18.8.rc1/pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.AppImage"
expected_sha256="11de2583a3abce5f141fd7fafb1fea2c67b15886e546d6b7675c600012e6ab8c"

if [[ -x "$app_dir/AppRun" ]]; then
  echo "pdf2htmlEX is already installed in the application image."
  exit 0
fi

mkdir -p "$install_dir"
curl --fail --location --silent --show-error "$download_url" --output "$app_image"
echo "$expected_sha256  $app_image" | sha256sum --check --status
chmod +x "$app_image"

(
  cd "$install_dir"
  ./pdf2htmlEX.AppImage --appimage-extract >/dev/null
)

test -x "$app_dir/AppRun"
rm -f "$app_image"
"$app_dir/AppRun" --version
