#!/bin/bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT="$SCRIPT_DIR/../app"

# AppRun is itself dynamically linked. On rolling distributions the host may
# no longer provide compatibility sonames such as libxml2.so.2, so activate
# the extracted AppImage libraries before starting it.
for library_dir in \
  "$APP_ROOT/usr/lib/x86_64-linux-gnu" \
  "$APP_ROOT/usr/lib" \
  "$APP_ROOT/lib/x86_64-linux-gnu" \
  "$APP_ROOT/lib"; do
  if [ -d "$library_dir" ]; then
    LD_LIBRARY_PATH="$library_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
done
export LD_LIBRARY_PATH

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

export APPDIR="$APP_ROOT"
exec "$APP_ROOT/AppRun" "${normalized_args[@]}"
