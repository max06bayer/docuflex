#!/usr/bin/env python3
"""Report the complete missing-library set before the costly AppImage build."""
import os
from pathlib import Path
import subprocess
import sys

office = Path(sys.argv[1]).resolve()
java = office.parent / 'java' / 'lib'
environment = dict(os.environ)
environment['LD_LIBRARY_PATH'] = ':'.join(filter(None, (
    str(java), str(java / 'server'), environment.get('LD_LIBRARY_PATH', ''))))
missing = []
count = 0
for path in sorted(office.rglob('*')):
    if not path.is_file():
        continue
    with path.open('rb') as stream:
        if stream.read(4) != b'\x7fELF':
            continue
    count += 1
    result = subprocess.run(['ldd', str(path)], env=environment, capture_output=True, text=True, timeout=20)
    unresolved = [line.strip() for line in (result.stdout + result.stderr).splitlines() if 'not found' in line]
    if unresolved:
        missing.append(f'{path.relative_to(office)}: ' + '; '.join(unresolved))
if missing:
    print('Unresolved bundled Office libraries:\n' + '\n'.join(missing), file=sys.stderr)
    sys.exit(1)
print(f'All dependencies resolve for {count} bundled Office ELF files.')
