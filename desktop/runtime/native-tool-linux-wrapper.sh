#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TOOL_NAME=${0##*/}
export LD_LIBRARY_PATH="$SCRIPT_DIR/../lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$SCRIPT_DIR/$TOOL_NAME-native" "$@"
