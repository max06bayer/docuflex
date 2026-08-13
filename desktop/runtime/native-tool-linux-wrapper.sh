#!/bin/bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TOOL_NAME=${0##*/}
export LD_LIBRARY_PATH="$SCRIPT_DIR/../lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [ "$TOOL_NAME" = "tesseract" ]; then
  arguments=()
  for argument in "$@"; do
    if [ "$argument" = "pdf" ]; then
      arguments+=(-c textonly_pdf=0)
    fi
    arguments+=("$argument")
  done
  exec "$SCRIPT_DIR/$TOOL_NAME-native" "${arguments[@]}"
fi
exec "$SCRIPT_DIR/$TOOL_NAME-native" "$@"
