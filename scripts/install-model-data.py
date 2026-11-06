#!/usr/bin/env python3
"""Extract a translation model as data, excluding scripts, native libraries and unsafe paths."""
import pathlib
import stat
import sys
import zipfile

BLOCKED = {'.py', '.pyc', '.pyo', '.pyd', '.pth', '.js', '.mjs', '.cjs', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm', '.pkl', '.pickle'}
MAGIC = {b'\x7fELF', b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}


def extract(archive, destination):
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len(entries) > 20000 or sum(e.file_size for e in entries) > 4 * 1024**3:
            raise ValueError('Model archive exceeds safe limits')
        # Validate every entry before writing any of it.
        for e in entries:
            p = pathlib.PurePosixPath(e.filename)
            if p.is_absolute() or '..' in p.parts or '\\' in e.filename or ':' in e.filename:
                raise ValueError('Unsafe model path')
            kind = stat.S_IFMT(e.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError('Model contains a special file')
            if p.suffix.lower() in BLOCKED:
                raise ValueError('Model contains executable code')
            target = destination.joinpath(*p.parts)
            for parent in [target, destination, *target.parents]:
                if parent == destination.parent:
                    break
                if parent.is_symlink():
                    raise ValueError('Model destination contains a symbolic link')
            if not e.is_dir():
                with z.open(e) as f:
                    header = f.read(4)
                if header in MAGIC or header[:2] == b'MZ':
                    raise ValueError('Model contains an executable binary')
        for e in entries:
            target = destination.joinpath(*pathlib.PurePosixPath(e.filename).parts)
            if e.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(e) as source, target.open('wb') as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)


if __name__ == '__main__':
    extract(sys.argv[1], sys.argv[2])
