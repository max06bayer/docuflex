#!/bin/bash

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_BINARY="$SCRIPT_DIR/pdf2htmlEX-native"

# The web endpoint historically passes the Linux AppImage shorthand `--embed 1`.
# Upstream 0.18.8 uses the explicit embed flags instead, so normalize that one
# argument here without changing the website implementation.
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

exec "$NATIVE_BINARY" "${normalized_args[@]}"
