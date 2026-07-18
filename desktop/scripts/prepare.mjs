import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..');
const tauriRoot = join(desktopRoot, 'src-tauri');
const resourcesRoot = join(tauriRoot, 'resources');
const cacheRoot = join(desktopRoot, '.cache');
const nodeVersion = 'v24.18.0';
const nodeArchiveName = `node-${nodeVersion}-darwin-arm64.tar.gz`;
const nodeDownloadBase = `https://nodejs.org/dist/${nodeVersion}`;

function run(binary, args, options = {}) {
  execFileSync(binary, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: 'inherit'
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

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

async function verifyNodeArchive(archivePath) {
  const checksumPath = join(cacheRoot, `SHASUMS256-${nodeVersion}.txt`);
  if (!(await exists(checksumPath))) {
    await download(`${nodeDownloadBase}/SHASUMS256.txt`, checksumPath);
  }
  const checksums = await readFile(checksumPath, 'utf8');
  const checksumLine = checksums.split('\n').find((line) => line.endsWith(`  ${nodeArchiveName}`));
  if (!checksumLine) throw new Error(`Node checksum is missing for ${nodeArchiveName}.`);
  const expected = checksumLine.split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  if (actual !== expected) throw new Error(`Node checksum failed for ${nodeArchiveName}.`);
}

async function prepareNodeRuntime() {
  const archivePath = join(cacheRoot, nodeArchiveName);
  if (!(await exists(archivePath))) {
    await download(`${nodeDownloadBase}/${nodeArchiveName}`, archivePath);
  }
  await verifyNodeArchive(archivePath);

  const extractionRoot = await mkdir(join(tmpdir(), `docuflex-node-${process.pid}`), { recursive: true }).then(() =>
    join(tmpdir(), `docuflex-node-${process.pid}`)
  );
  try {
    run('tar', ['-xzf', archivePath, '-C', extractionRoot]);
    const extractedNode = join(extractionRoot, `node-${nodeVersion}-darwin-arm64`);
    const bundledNode = join(resourcesRoot, 'runtime', 'node');
    await mkdir(join(bundledNode, 'bin'), { recursive: true });
    await cp(join(extractedNode, 'bin', 'node'), join(bundledNode, 'bin', 'node'));
    await cp(join(extractedNode, 'LICENSE'), join(bundledNode, 'LICENSE'));
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

function javaHome() {
  return execFileSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' }).trim();
}

async function prepareJavaRuntime() {
  const jdk = javaHome();
  const javaRuntime = join(resourcesRoot, 'runtime', 'java');
  run(join(jdk, 'bin', 'jlink'), [
    '--add-modules',
    'java.base,java.desktop,java.naming,java.prefs,java.sql,jdk.httpserver',
    '--strip-debug',
    '--no-header-files',
    '--no-man-pages',
    '--compress=2',
    '--output',
    javaRuntime
  ]);
  const legalDirectory = join(javaRuntime, 'legal');
  const expandedLegalDirectory = join(javaRuntime, 'legal-expanded');
  run('cp', ['-RL', legalDirectory, expandedLegalDirectory]);
  await rm(legalDirectory, { recursive: true, force: true });
  await rename(expandedLegalDirectory, legalDirectory);
  run('chmod', ['-R', 'u+rw', legalDirectory]);
}

async function preparePythonRuntime() {
  const source = process.env.DOCUFLEX_PYTHON_RUNTIME?.trim()
    || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python');
  const sourceLibrary = join(source, 'lib', 'python3.12');
  if (!(await exists(join(source, 'bin', 'python3.12'))) || !(await exists(sourceLibrary))) {
    throw new Error('Set DOCUFLEX_PYTHON_RUNTIME to the arm64 Python 3.12 runtime used for desktop conversion.');
  }

  const destination = join(resourcesRoot, 'runtime', 'python');
  await mkdir(join(destination, 'bin'), { recursive: true });
  await mkdir(join(destination, 'lib'), { recursive: true });
  await cp(join(source, 'bin', 'python3.12'), join(destination, 'bin', 'python3.12'));
  await cp(join(source, 'lib', 'libpython3.12.dylib'), join(destination, 'lib', 'libpython3.12.dylib'));
  await cp(sourceLibrary, join(destination, 'lib', 'python3.12'), {
    recursive: true,
    filter: (path) => !path.startsWith(join(sourceLibrary, 'site-packages'))
  });

  const sitePackages = join(destination, 'lib', 'python3.12', 'site-packages');
  const sourcePackages = join(sourceLibrary, 'site-packages');
  await mkdir(sitePackages, { recursive: true });
  for (const packageName of ['PIL', 'docx', 'et_xmlfile', 'lxml', 'openpyxl', 'pptx', 'typing_extensions.py', 'xlsxwriter']) {
    const packageSource = join(sourcePackages, packageName);
    if (!(await exists(packageSource))) throw new Error(`Desktop conversion dependency is missing: ${packageName}`);
    await cp(packageSource, join(sitePackages, packageName), { recursive: true });
  }
  await writeFile(join(destination, 'bin', 'python3'), '#!/bin/sh\nexec "$(dirname "$0")/python3.12" "$@"\n');
  run('chmod', ['+x', join(destination, 'bin', 'python3'), join(destination, 'bin', 'python3.12')]);
}

async function copyApplicationResources() {
  await cp(join(repositoryRoot, 'build'), join(resourcesRoot, 'frontend'), { recursive: true });
  await cp(join(repositoryRoot, 'backend', 'out'), join(resourcesRoot, 'backend', 'out'), { recursive: true });
  await cp(join(repositoryRoot, 'backend', 'lib'), join(resourcesRoot, 'backend', 'lib'), { recursive: true });
  await cp(join(repositoryRoot, 'backend', 'fonts'), join(resourcesRoot, 'backend', 'fonts'), { recursive: true });
  await mkdir(join(resourcesRoot, 'scripts'), { recursive: true });
  for (const file of await readdir(join(repositoryRoot, 'scripts'))) {
    if (!file.endsWith('.py')) continue;
    await cp(join(repositoryRoot, 'scripts', file), join(resourcesRoot, 'scripts', file));
  }
  await mkdir(join(resourcesRoot, 'runtime'), { recursive: true });
  await cp(join(desktopRoot, 'runtime', 'supervise.sh'), join(resourcesRoot, 'runtime', 'supervise.sh'));
  await cp(join(desktopRoot, 'runtime', 'soffice-shim.sh'), join(resourcesRoot, 'runtime', 'soffice-shim.sh'));
  run('chmod', ['+x', join(resourcesRoot, 'runtime', 'soffice-shim.sh')]);
  await cp(
    join(desktopRoot, 'vendor', 'pdf2htmlEX-macos-arm64'),
    join(resourcesRoot, 'runtime', 'pdf2htmlEX'),
    { recursive: true }
  );
  run('chmod', ['-R', 'u+w', join(resourcesRoot, 'runtime', 'pdf2htmlEX')]);
  await cp(
    join(desktopRoot, 'vendor', 'ocr-macos-arm64'),
    join(resourcesRoot, 'runtime', 'ocr'),
    { recursive: true }
  );
  run('chmod', ['-R', 'u+w', join(resourcesRoot, 'runtime', 'ocr')]);
}

async function generateMacIcon() {
  const source = join(repositoryRoot, 'public', 'macos-icon-iOS-Default-1024x1024@1x.png');
  const iconset = join(cacheRoot, 'Docuflex.iconset');
  const iconRoot = join(tauriRoot, 'icons');
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  await mkdir(iconRoot, { recursive: true });
  const parsedIcon = PNG.sync.read(await readFile(source));
  await writeFile(join(iconRoot, 'icon.png'), PNG.sync.write(parsedIcon, { colorType: 6, bitDepth: 8 }));

  const variants = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png']
  ];
  for (const [size, name] of variants) {
    run('sips', ['-z', String(size), String(size), source, '--out', join(iconset, name)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(iconRoot, 'icon.icns')]);
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('This desktop package currently targets Apple Silicon macOS.');
  }
  await mkdir(cacheRoot, { recursive: true });
  await rm(resourcesRoot, { recursive: true, force: true });
  await rm(join(tauriRoot, 'target', 'release', 'resources'), { recursive: true, force: true });
  await mkdir(resourcesRoot, { recursive: true });

  run('npm', ['run', 'build']);
  run('npm', ['run', 'backend:compile']);
  await copyApplicationResources();
  await prepareNodeRuntime();
  await prepareJavaRuntime();
  await preparePythonRuntime();
  await generateMacIcon();
}

await main();
