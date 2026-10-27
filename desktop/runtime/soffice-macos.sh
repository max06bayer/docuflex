#!/bin/sh
set -eu
runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$runtime_root/LibreOffice.app/Contents/MacOS/soffice" "$@"
