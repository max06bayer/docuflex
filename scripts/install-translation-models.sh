#!/usr/bin/env bash
# Installs every Argos translation model the hosted server needs, at build time,
# into <app>/.translate-data: each supported language to and from English (other
# pairs translate through English). The server finds them there at runtime, so
# visitors never wait for a model download.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$root_dir/.document-python"
data_dir="$root_dir/.translate-data"
python_bin="${DOCUMENT_CONVERTER_PYTHON:-python3}"
languages=(de es fr it pt nl pl ru uk ar zh ja ko)

mkdir -p "$data_dir"
XDG_DATA_HOME="$data_dir" \
XDG_CACHE_HOME="$root_dir/.translate-cache" \
XDG_CONFIG_HOME="$root_dir/.translate-config" \
PYTHONPATH="$runtime_dir${PYTHONPATH:+:$PYTHONPATH}" \
ARGOS_DEVICE_TYPE=cpu \
"$python_bin" - "${languages[@]}" <<'PY'
import sys
import argostranslate.package as package

languages = sys.argv[1:]
wanted = {(code, 'en') for code in languages} | {('en', code) for code in languages}
installed = {(p.from_code, p.to_code) for p in package.get_installed_packages()}
missing = wanted - installed
if not missing:
    print('All translation models are already installed.')
    sys.exit(0)
package.update_package_index()
available = {(p.from_code, p.to_code): p for p in package.get_available_packages()}
for pair in sorted(missing):
    candidate = available.get(pair)
    if candidate is None:
        print(f'No model for {pair[0]}->{pair[1]}; skipped.')
        continue
    print(f'Installing {pair[0]}->{pair[1]}')
    package.install_from_path(candidate.download())
installed = {(p.from_code, p.to_code) for p in package.get_installed_packages()}
still = sorted(wanted - installed)
print(f'{len(installed & wanted)} of {len(wanted)} models installed.' + (f' Missing: {still}' if still else ''))
PY
