import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..');
const tauriRoot = join(desktopRoot, 'src-tauri');
const distRoot = join(desktopRoot, 'dist');
const resourcesRoot = join(tauriRoot, 'resources');
const cacheRoot = join(desktopRoot, '.cache');
const nodeVersion = 'v24.18.0';
const supportedTargets = new Set(['darwin-arm64', 'win32-x64', 'linux-x64']);
const target = `${process.platform}-${process.arch}`;
const nodePlatform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win' : 'linux';
const nodeExtension = process.platform === 'win32' ? 'zip' : 'tar.xz';
const nodeArchiveName = `node-${nodeVersion}-${nodePlatform}-${process.arch}.${nodeExtension}`;
const nodeDownloadBase = `https://nodejs.org/dist/${nodeVersion}`;

function run(binary, args, options = {}) {
  execFileSync(binary, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? 'inherit'
  });
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run desktop staging through npm so npm_execpath is available.');
  run(process.execPath, [npmCli, ...args], options);
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
  if (!response.ok || !response.body) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

async function verifyNodeArchive(archivePath) {
  const checksumPath = join(cacheRoot, `SHASUMS256-${nodeVersion}.txt`);
  if (!(await exists(checksumPath))) await download(`${nodeDownloadBase}/SHASUMS256.txt`, checksumPath);
  const checksums = await readFile(checksumPath, 'utf8');
  const checksumLine = checksums.split('\n').find((line) => line.endsWith(`  ${nodeArchiveName}`));
  if (!checksumLine) throw new Error(`Node checksum is missing for ${nodeArchiveName}.`);
  const expected = checksumLine.split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  if (actual !== expected) throw new Error(`Node checksum failed for ${nodeArchiveName}.`);
}

async function prepareNodeRuntime() {
  const archivePath = join(cacheRoot, nodeArchiveName);
  if (!(await exists(archivePath))) await download(`${nodeDownloadBase}/${nodeArchiveName}`, archivePath);
  await verifyNodeArchive(archivePath);
  const extractionRoot = join(tmpdir(), `docuflex-node-${process.pid}`);
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true });
  try {
    run('tar', ['-xf', archivePath, '-C', extractionRoot]);
    const extractedNode = join(extractionRoot, `node-${nodeVersion}-${nodePlatform}-${process.arch}`);
    const bundledNode = join(resourcesRoot, 'runtime', 'node');
    await mkdir(join(bundledNode, 'bin'), { recursive: true });
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    await cp(join(extractedNode, nodeName === 'node.exe' ? nodeName : 'bin/node'), join(bundledNode, 'bin', nodeName));
    await cp(join(extractedNode, 'LICENSE'), join(bundledNode, 'LICENSE'));
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

function javaHome() {
  if (process.env.JAVA_HOME?.trim()) return process.env.JAVA_HOME.trim();
  if (process.platform === 'darwin') {
    return execFileSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' }).trim();
  }
  throw new Error('JAVA_HOME must point to a JDK 17 runtime on Windows and Linux.');
}

async function prepareJavaRuntime() {
  const jdk = javaHome();
  const javaRuntime = join(resourcesRoot, 'runtime', 'java');
  const jlink = join(jdk, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink');
  run(jlink, [
    '--add-modules',
    'java.base,java.desktop,java.naming,java.prefs,java.sql,jdk.httpserver',
    '--strip-debug',
    '--no-header-files',
    '--no-man-pages',
    '--compress=2',
    '--output',
    javaRuntime
  ]);
  if (process.platform === 'darwin') {
    const legalDirectory = join(javaRuntime, 'legal');
    const expandedLegalDirectory = join(javaRuntime, 'legal-expanded');
    run('cp', ['-RL', legalDirectory, expandedLegalDirectory]);
    await rm(legalDirectory, { recursive: true, force: true });
    await rename(expandedLegalDirectory, legalDirectory);
    run('chmod', ['-R', 'u+rw', legalDirectory]);
  }
}

async function preparePythonRuntime() {
  const configured = process.env.DOCUFLEX_PYTHON_RUNTIME?.trim();
  const source = configured || (process.platform === 'darwin'
    ? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python')
    : '');
  if (!source || !(await exists(source))) {
    throw new Error('DOCUFLEX_PYTHON_RUNTIME must point to a self-contained native Python 3.12 runtime.');
  }
  const destination = join(resourcesRoot, 'runtime', 'python');
  if (process.platform === 'darwin' && !configured) {
    const sourceLibrary = join(source, 'lib', 'python3.12');
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
  } else {
    await cp(source, destination, { recursive: true, dereference: process.platform === 'win32' });
  }
  const executable = process.platform === 'win32'
    ? join(destination, 'python.exe')
    : join(destination, 'bin', 'python3');
  if (!(await exists(executable))) throw new Error(`Bundled Python executable is missing: ${executable}`);
  run(executable, ['-c', 'import PIL, docx, lxml, openpyxl, pptx, xlsxwriter'], { cwd: destination });
}

async function copyRuntime(name, environmentName, fallback) {
  const configured = process.env[environmentName]?.trim();
  const source = configured || fallback;
  if (!source || !(await exists(source))) {
    throw new Error(`${environmentName} must point to the prepared native ${name} runtime for ${target}.`);
  }
  await cp(source, join(resourcesRoot, 'runtime', name), { recursive: true, dereference: true });
}

async function copyApplicationResources() {
  await cp(join(repositoryRoot, 'build'), join(resourcesRoot, 'frontend'), { recursive: true });
  await cp(join(repositoryRoot, 'backend', 'out'), join(resourcesRoot, 'backend', 'out'), { recursive: true });
  await cp(join(repositoryRoot, 'backend', 'lib'), join(resourcesRoot, 'backend', 'lib'), { recursive: true });
  await cp(join(repositoryRoot, 'backend', 'fonts'), join(resourcesRoot, 'backend', 'fonts'), { recursive: true });
  await mkdir(join(resourcesRoot, 'scripts'), { recursive: true });
  for (const file of await readdir(join(repositoryRoot, 'scripts'))) {
    if (file.endsWith('.py')) await cp(join(repositoryRoot, 'scripts', file), join(resourcesRoot, 'scripts', file));
  }
  await mkdir(join(resourcesRoot, 'runtime'), { recursive: true });
  if (process.platform === 'win32') {
    await cp(join(desktopRoot, 'runtime', 'supervise.ps1'), join(resourcesRoot, 'runtime', 'supervise.ps1'));
  } else {
    await cp(join(desktopRoot, 'runtime', 'supervise.sh'), join(resourcesRoot, 'runtime', 'supervise.sh'));
  }

  const macPdfRuntime = process.platform === 'darwin' ? join(desktopRoot, 'vendor', 'pdf2htmlEX-macos-arm64') : '';
  const macOcrRuntime = process.platform === 'darwin' ? join(desktopRoot, 'vendor', 'ocr-macos-arm64') : '';
  await copyRuntime('pdf2htmlEX', 'DOCUFLEX_PDF2HTMLEX_RUNTIME', macPdfRuntime);
  await copyRuntime('ocr', 'DOCUFLEX_OCR_RUNTIME', macOcrRuntime);

  if (process.platform === 'darwin' && !process.env.DOCUFLEX_OFFICE_RUNTIME?.trim()) {
    const officeBin = join(resourcesRoot, 'runtime', 'office', 'bin');
    await mkdir(officeBin, { recursive: true });
    await cp(join(desktopRoot, 'runtime', 'soffice-shim.sh'), join(officeBin, 'soffice'));
  } else {
    await copyRuntime('office', 'DOCUFLEX_OFFICE_RUNTIME', '');
  }

  if (process.platform !== 'win32') {
    run('chmod', ['-R', 'u+rwX', join(resourcesRoot, 'runtime')]);
    for (const executable of [
      join(resourcesRoot, 'runtime', 'supervise.sh'),
      join(resourcesRoot, 'runtime', 'office', 'bin', 'soffice'),
      join(resourcesRoot, 'runtime', 'office', 'program', 'soffice'),
      join(resourcesRoot, 'runtime', 'pdf2htmlEX', 'bin', 'pdf2htmlEX'),
      join(resourcesRoot, 'runtime', 'ocr', 'bin', 'pdftoppm'),
      join(resourcesRoot, 'runtime', 'ocr', 'bin', 'pdfunite'),
      join(resourcesRoot, 'runtime', 'ocr', 'bin', 'tesseract')
    ]) {
      if (await exists(executable)) run('chmod', ['+x', executable]);
    }
  }
}

async function generateIcons() {
  const source = join(repositoryRoot, 'public', 'macos-icon-iOS-Default-1024x1024@1x.png');
  const iconRoot = join(tauriRoot, 'icons');
  await rm(iconRoot, { recursive: true, force: true });
  const tauriCli = join(desktopRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  run(process.execPath, [tauriCli, 'icon', source, '--output', iconRoot], { cwd: desktopRoot });
}

async function writeRuntimeManifest() {
  const manifest = {
    target,
    generatedAt: new Date().toISOString(),
    node: nodeVersion,
    java: '17 (jlink)',
    python: '3.12',
    pdf2htmlEX: process.platform === 'win32' ? '0.14.6 native static' : '0.18.8.rc1',
    ocr: 'Tesseract with eng, deu, and osd data',
    offline: true
  };
  await writeFile(join(resourcesRoot, 'RUNTIME.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeDesktopShell() {
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  await writeFile(join(distRoot, 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Docuflex</title>
  </head>
  <body></body>
</html>
`);
}

async function main() {
  if (!supportedTargets.has(target)) throw new Error(`Unsupported desktop build target: ${target}`);
  await mkdir(cacheRoot, { recursive: true });
  await rm(resourcesRoot, { recursive: true, force: true });
  await rm(join(tauriRoot, 'target', 'release', 'resources'), { recursive: true, force: true });
  await mkdir(resourcesRoot, { recursive: true });

  runNpm(['run', 'build']);
  runNpm(['run', 'backend:compile']);
  await copyApplicationResources();
  await prepareNodeRuntime();
  await prepareJavaRuntime();
  await preparePythonRuntime();
  await generateIcons();
  await writeRuntimeManifest();
  await writeDesktopShell();
}

await main();
