import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(desktopRoot, 'vendor', 'ocr-macos-arm64');
const binRoot = join(outputRoot, 'bin');
const libRoot = join(outputRoot, 'lib');
const tessdataRoot = join(outputRoot, 'share', 'tessdata');
const tessdataSource = join(desktopRoot, '.cache', 'tessdata-fast-4.1.0');
const sourceBinaries = [
  '/opt/homebrew/bin/tesseract',
  '/opt/homebrew/bin/pdftoppm',
  '/opt/homebrew/bin/pdfunite'
];

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    encoding: options.encoding,
    stdio: options.stdio ?? (options.encoding ? ['ignore', 'pipe', 'inherit'] : 'inherit')
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function dependencies(path) {
  return run('otool', ['-L', path], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (compatibility version')[0])
    .filter(Boolean);
}

function isSystemDependency(path) {
  return path.startsWith('/System/Library/') || path.startsWith('/usr/lib/');
}

async function resolveDependency(reference, owner) {
  if (reference.startsWith('/') && await exists(reference)) return reference;
  const name = basename(reference);
  const candidates = [
    join(dirname(owner), name),
    join('/opt/homebrew/lib', name),
    join('/opt/homebrew/opt/poppler/lib', name),
    join('/opt/homebrew/opt/tesseract/lib', name),
    join('/opt/homebrew/opt/leptonica/lib', name)
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Could not resolve ${reference} required by ${owner}`);
}

async function bundleDylibs(binaries) {
  const queue = [...binaries];
  const bundledByReference = new Map();
  const bundledByName = new Map();
  while (queue.length) {
    const owner = queue.shift();
    for (const reference of dependencies(owner)) {
      if (isSystemDependency(reference)) continue;
      const resolved = await resolveDependency(reference, owner);
      const name = basename(resolved);
      if (bundledByName.has(name)) {
        bundledByReference.set(reference, bundledByName.get(name));
        continue;
      }
      const destination = join(libRoot, name);
      await cp(resolved, destination, { dereference: true });
      bundledByReference.set(reference, destination);
      bundledByName.set(name, destination);
      queue.push(destination);
    }
  }

  const dylibs = [...bundledByName.values()];
  for (const owner of [...binaries, ...dylibs]) {
    const replacementPrefix = binaries.includes(owner) ? '@loader_path/../lib' : '@loader_path';
    for (const reference of dependencies(owner)) {
      if (isSystemDependency(reference)) continue;
      const destination = bundledByReference.get(reference) ?? bundledByName.get(basename(reference));
      if (!destination) throw new Error(`Missing bundled dylib for ${reference}`);
      run('install_name_tool', ['-change', reference, `${replacementPrefix}/${basename(destination)}`, owner]);
    }
    if (!binaries.includes(owner)) run('install_name_tool', ['-id', `@rpath/${basename(owner)}`, owner]);
  }
  for (const file of [...dylibs, ...binaries]) run('codesign', ['--force', '--sign', '-', file]);
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The bundled OCR runtime currently targets Apple Silicon macOS.');
  }
  for (const binary of sourceBinaries) {
    if (!(await exists(binary))) throw new Error(`Missing native OCR tool: ${binary}`);
  }
  for (const language of ['eng', 'deu', 'osd']) {
    if (!(await exists(join(tessdataSource, `${language}.traineddata`)))) {
      throw new Error(`Missing pinned Tesseract data for ${language}.`);
    }
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(binRoot, { recursive: true });
  await mkdir(libRoot, { recursive: true });
  await mkdir(tessdataRoot, { recursive: true });
  const binaries = [];
  for (const source of sourceBinaries) {
    const destination = join(binRoot, basename(source));
    await cp(source, destination, { dereference: true });
    binaries.push(destination);
  }
  await bundleDylibs(binaries);
  for (const language of ['eng', 'deu', 'osd']) {
    await cp(join(tessdataSource, `${language}.traineddata`), join(tessdataRoot, `${language}.traineddata`));
  }
  await mkdir(join(tessdataRoot, 'configs'), { recursive: true });
  await cp('/opt/homebrew/share/tessdata/configs/pdf', join(tessdataRoot, 'configs', 'pdf'));
  await cp('/opt/homebrew/share/tessdata/pdf.ttf', join(tessdataRoot, 'pdf.ttf'));
  await writeFile(join(outputRoot, 'SOURCE.txt'), `Docuflex offline OCR runtime\n\nTesseract 5.5.2: https://github.com/tesseract-ocr/tesseract/tree/5.5.2\nPoppler 26.07.0: https://poppler.freedesktop.org/\nTesseract fast language data 4.1.0: https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0\n\nLanguage data SHA-256:\ndeu 19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d\neng 7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2\nosd 9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff\n`);
  run('chmod', ['-R', 'u+w', outputRoot]);
}

await main();
