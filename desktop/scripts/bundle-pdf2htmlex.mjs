import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..');
const sourceRoot = join(desktopRoot, '.cache', 'pdf2htmlEX-src');
const converterRoot = join(sourceRoot, 'pdf2htmlEX');
const nativeBinary = join(converterRoot, 'build-macos-native', 'pdf2htmlEX');
const outputRoot = join(desktopRoot, 'vendor', 'pdf2htmlEX-macos-arm64');
const binRoot = join(outputRoot, 'bin');
const libRoot = join(outputRoot, 'lib');

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
  const output = run('otool', ['-L', path], { encoding: 'utf8' });
  return output
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
    join('/opt/homebrew/opt', name)
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Could not resolve ${reference} required by ${owner}`);
}

async function copyDylibClosure(binaryPath) {
  const queue = [binaryPath];
  const bundledByReference = new Map();
  const bundledFiles = [];
  while (queue.length) {
    const owner = queue.shift();
    for (const reference of dependencies(owner)) {
      if (isSystemDependency(reference)) continue;
      const resolved = await resolveDependency(reference, owner);
      const name = basename(resolved);
      if (bundledByReference.has(reference) || bundledFiles.some((file) => basename(file) === name)) {
        bundledByReference.set(reference, join(libRoot, name));
        continue;
      }
      const destination = join(libRoot, name);
      await cp(resolved, destination, { dereference: true });
      bundledByReference.set(reference, destination);
      bundledFiles.push(destination);
      queue.push(destination);
    }
  }

  for (const owner of [binaryPath, ...bundledFiles]) {
    const replacementPrefix = owner === binaryPath ? '@loader_path/../lib' : '@loader_path';
    for (const reference of dependencies(owner)) {
      if (isSystemDependency(reference)) continue;
      const destination = bundledByReference.get(reference) ?? join(libRoot, basename(reference));
      run('install_name_tool', ['-change', reference, `${replacementPrefix}/${basename(destination)}`, owner]);
    }
    if (owner !== binaryPath) run('install_name_tool', ['-id', `@rpath/${basename(owner)}`, owner]);
  }

  for (const file of [...bundledFiles, binaryPath]) {
    run('codesign', ['--force', '--sign', '-', file]);
  }
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The bundled converter currently targets Apple Silicon macOS.');
  }
  if (!(await exists(nativeBinary))) {
    throw new Error(`Build the native converter first; missing ${nativeBinary}`);
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(binRoot, { recursive: true });
  await mkdir(libRoot, { recursive: true });
  const bundledBinary = join(binRoot, 'pdf2htmlEX-native');
  await cp(nativeBinary, bundledBinary);
  await copyDylibClosure(bundledBinary);

  await cp(join(desktopRoot, 'runtime', 'pdf2htmlEX-wrapper.sh'), join(binRoot, 'pdf2htmlEX'));
  run('chmod', ['755', join(binRoot, 'pdf2htmlEX'), bundledBinary]);
  await cp(join(converterRoot, 'share'), join(outputRoot, 'share', 'pdf2htmlEX'), { recursive: true });
  await cp(join(converterRoot, '3rdparty', 'PDF.js', 'compatibility.js'), join(outputRoot, 'share', 'pdf2htmlEX', 'compatibility.js'));
  await cp(join(converterRoot, '3rdparty', 'PDF.js', 'compatibility.min.js'), join(outputRoot, 'share', 'pdf2htmlEX', 'compatibility.min.js'));
  await cp(join(sourceRoot, 'poppler-data', 'cMap'), join(outputRoot, 'share', 'pdf2htmlEX', 'poppler', 'cMap'), { recursive: true });
  await cp(join(sourceRoot, 'poppler-data', 'cidToUnicode'), join(outputRoot, 'share', 'pdf2htmlEX', 'poppler', 'cidToUnicode'), { recursive: true });
  await cp('/opt/homebrew/etc/fonts', join(outputRoot, 'etc', 'fonts'), { recursive: true, dereference: true });

  const licenseRoot = join(outputRoot, 'licenses');
  await mkdir(licenseRoot, { recursive: true });
  await cp(join(sourceRoot, 'fontforge', 'COPYING.gplv3'), join(licenseRoot, 'pdf2htmlEX-GPL-3.0.txt'));
  await cp(join(sourceRoot, 'poppler', 'COPYING'), join(licenseRoot, 'poppler-GPL-2.0.txt'));
  await cp(join(sourceRoot, 'fontforge', 'LICENSE'), join(licenseRoot, 'fontforge-license.txt'));
  await cp(join(sourceRoot, 'poppler-data', 'COPYING'), join(licenseRoot, 'poppler-data-license.txt'));
  await writeFile(join(outputRoot, 'SOURCE.txt'), await readFile(join(desktopRoot, 'runtime', 'pdf2htmlEX-SOURCE.txt')));
  run('chmod', ['-R', 'u+w', outputRoot]);
}

await main();
