"""Extract checksum-verified Ollama archives into a new private staging directory."""
import os
import pathlib
import stat
import sys
import tarfile
import zipfile

root = pathlib.Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=True)

def destination(name):
    if '\\' in name or ':' in name:
        raise ValueError('Unsafe archive path')
    path = (root / name).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Archive path escapes its destination')
    return path

if sys.argv[1] == 'zip':
    with zipfile.ZipFile(sys.argv[3]) as archive:
        for member in archive.infolist():
            destination(member.filename)
            if stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError('ZIP symlinks are not supported')
        archive.extractall(root)
elif sys.argv[1] == 'tar':
    with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
        for member in archive:
            destination(member.name)
            archive.extract(member, root, filter='data')
else:
    raise ValueError('Unsupported archive type')
