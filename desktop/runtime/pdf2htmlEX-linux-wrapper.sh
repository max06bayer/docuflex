#!/bin/bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT="$SCRIPT_DIR/../app"

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
