#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" == "Linux" && "$(id -u)" == "0" ]]; then
  runtime_home="/tmp/docuflex-home"
  install -d -o 65532 -g 65532 "$runtime_home"
  profile_path="$(readlink -f /root/.nix-profile)"
  export PATH="$profile_path/bin:$PATH"
  export HOME="$runtime_home"
  exec setpriv \
    --reuid=65532 \
    --regid=65532 \
    --clear-groups \
    --no-new-privs \
    --inh-caps=-all \
    --ambient-caps=-all \
    --bounding-set=-all \
    node scripts/start-production.mjs
fi

exec node scripts/start-production.mjs
