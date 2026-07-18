#!/bin/sh

# WebKitGTK reads these during shared-library initialization, before the
# Tauri/Rust entry point can run. Keep them in this outer launcher.
: "${WEBKIT_DISABLE_DMABUF_RENDERER:=1}"
: "${WEBKIT_DISABLE_COMPOSITING_MODE:=1}"
export WEBKIT_DISABLE_DMABUF_RENDERER WEBKIT_DISABLE_COMPOSITING_MODE

if [ -n "${DOCUFLEX_LAUNCHER_MARKER:-}" ]; then
  printf 'dmabuf=%s\ncompositing=%s\n' \
    "$WEBKIT_DISABLE_DMABUF_RENDERER" \
    "$WEBKIT_DISABLE_COMPOSITING_MODE" > "$DOCUFLEX_LAUNCHER_MARKER"
fi

exec docuflex-desktop "$@"
