#!/bin/sh
set -eu
program_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export SAL_USE_VCLPLUGIN=svp
exec "$program_root/soffice-vendor" "$@"
