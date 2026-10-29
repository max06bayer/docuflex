import * as env from '$app/env/private';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logPrivateError } from '#lib/server/request-security.js';

export const TRANSLATION_LANGUAGE_CODES = new Set(['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ar', 'zh', 'ja', 'ko']);

/** Argos models, caches and the downloaded engine live here, outside the (read-only) app bundle. */
export const TRANSLATE_CACHE = join(homedir(), '.cache', 'docuflex');
const USER_RUNTIME = join(TRANSLATE_CACHE, 'translate-python');
/**
 * Where the language models live. The hosted server installs every model at build
 * time into <app>/.translate-data (scripts/install-translation-models.sh), so all
 * visitors translate through the server without downloading anything. The desktop
 * app and local runs keep using the per-user cache.
 */
const BUNDLED_DATA_HOME = join(process.cwd(), '.translate-data');
const DATA_HOME = env.DOCUFLEX_TRANSLATE_DATA?.trim()
  || (existsSync(join(BUNDLED_DATA_HOME, 'argos-translate', 'packages')) ? BUNDLED_DATA_HOME : join(TRANSLATE_CACHE, 'translate-data'));
const PACKAGE_DIRECTORY = join(DATA_HOME, 'argos-translate', 'packages');
const LOCAL_INDEX = join(DATA_HOME, 'argos-translate', 'index.json');
const DOWNLOAD_DIRECTORY = join(TRANSLATE_CACHE, 'translate-downloads');
const REMOTE_INDEX = 'https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json';
const ENGINE_PACKAGES = ['argostranslate==1.11.0', 'PyMuPDF==1.26.7'];
const STEP_TIMEOUT_MS = 30 * 60 * 1000;
/** Compressed size of the engine's wheels on macOS arm64; only used for the size hint before downloading. */
const ENGINE_DOWNLOAD_ESTIMATE = 210 * 1e6;

/**
 * @typedef {{ pair: string; phase: 'preparing' | 'downloading' | 'installing' | 'done' | 'failed'; received: number; total: number; bytesPerSecond: number; error: string }} DownloadState
 */

/** @type {DownloadState | null} */
let download = null;
/** @type {{ at: number; received: number }[]} */
let speedSamples = [];

/**
 * The desktop app ships Python without the ~1 GB translation engine and sets
 * this flag so it can be downloaded from the Translate panel. The hosted server
 * never installs the engine at runtime (scripts/install-python-document-tools.sh does).
 */
export function autoInstallEnabled() {
  return env.DOCUFLEX_TRANSLATE_AUTO_INSTALL === '1';
}

/** @param {string} directory */
async function hasRuntime(directory) {
  try {
    await access(join(directory, 'argostranslate', '__init__.py'), constants.R_OK);
    await access(join(directory, 'fitz', '__init__.py'), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<string | null>} */
export async function findRuntime() {
  const configured = env.LOCAL_TRANSLATE_PYTHONPATH?.trim();
  if (configured) return configured;
  for (const candidate of [join(process.cwd(), '.document-python'), USER_RUNTIME]) {
    if (await hasRuntime(candidate)) return candidate;
  }
  return null;
}

export async function pythonBinary() {
  const configured = env.DOCUMENT_CONVERTER_PYTHON?.trim();
  if (configured) return configured;
  for (const candidate of [
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
    '/opt/homebrew/bin/python3', '/opt/local/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'
  ]) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return 'python3';
}

/** The environment the translation script and model installs run with. @param {string} runtime */
export function translationEnvironment(runtime) {
  return {
    PYTHONPATH: [runtime, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    XDG_DATA_HOME: DATA_HOME,
    XDG_CACHE_HOME: join(TRANSLATE_CACHE, 'translate-cache'),
    XDG_CONFIG_HOME: join(TRANSLATE_CACHE, 'translate-config'),
    ARGOS_DEVICE_TYPE: 'cpu',
    ARGOS_STANZA_AVAILABLE: '0'
  };
}

/** Argos translates between non-English pairs through English. @param {string} source @param {string} target */
function modelPairs(source, target) {
  return source === 'en' || target === 'en' ? [[source, target]] : [[source, 'en'], ['en', target]];
}

async function installedModelPairs() {
  const pairs = new Set();
  let entries = [];
  try { entries = await readdir(PACKAGE_DIRECTORY); } catch { return pairs; }
  await Promise.all(entries.map(async (entry) => {
    try {
      const metadata = JSON.parse(await readFile(join(PACKAGE_DIRECTORY, entry, 'metadata.json'), 'utf8'));
      if (metadata.from_code && metadata.to_code) pairs.add(`${metadata.from_code}-${metadata.to_code}`);
    } catch {}
  }));
  return pairs;
}

/** @param {string} source @param {string} target @returns {Promise<string[][]>} */
export async function missingModels(source, target) {
  const installed = await installedModelPairs();
  return modelPairs(source, target).filter(([from, to]) => !installed.has(`${from}-${to}`));
}

/** @param {string} source @param {string} target */
export async function translationStatus(source, target) {
  const runtime = await findRuntime();
  const pair = `${source}-${target}`;
  const missing = TRANSLATION_LANGUAGE_CODES.has(source) && TRANSLATION_LANGUAGE_CODES.has(target) ? await missingModels(source, target) : [];
  const modelReady = Boolean(runtime) && !missing.length;
  return {
    engineReady: Boolean(runtime),
    modelReady,
    // The desktop translates on the user's own computer; the hosted build on its server.
    local: autoInstallEnabled(),
    downloadBytes: modelReady ? 0 : await estimatedDownloadBytes(missing, !runtime),
    // Without the engine only the desktop can fetch it; models can be fetched wherever the engine exists.
    canDownload: Boolean(runtime) || autoInstallEnabled(),
    download: download && (download.pair === pair || ['preparing', 'downloading', 'installing'].includes(download.phase))
      ? { ...download, bytesPerSecond: currentSpeed() }
      : null
  };
}

/** @type {Map<string, number>} */
const remoteSizes = new Map();

/** @param {string[][]} missing @param {boolean} needsEngine */
async function estimatedDownloadBytes(missing, needsEngine) {
  try {
    const index = missing.length ? await packageIndex(true) : [];
    const sizes = await Promise.all(missing.map(async ([from, to]) => {
      const url = index.find((item) => item.from_code === from && item.to_code === to)?.links?.[0];
      if (!url) return 0;
      if (!remoteSizes.has(url)) remoteSizes.set(url, await remoteSize(url));
      return remoteSizes.get(url) ?? 0;
    }));
    return sizes.reduce((sum, size) => sum + size, needsEngine ? ENGINE_DOWNLOAD_ESTIMATE : 0);
  } catch {
    return null;
  }
}

/** Starts downloading whatever this language pair still needs. @param {string} source @param {string} target */
export function startDownload(source, target) {
  if (download && ['preparing', 'downloading', 'installing'].includes(download.phase)) return;
  download = { pair: `${source}-${target}`, phase: 'preparing', received: 0, total: 0, bytesPerSecond: 0, error: '' };
  speedSamples = [];
  const state = download;
  runDownload(state, source, target).then(() => {
    state.phase = 'done';
  }, (error) => {
    logPrivateError(error, 'Translation model download');
    state.phase = 'failed';
    state.error = downloadErrorMessage(error);
  });
}

/** @param {unknown} error */
function downloadErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof DownloadError) return message;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return 'The download lost its internet connection. Check your connection and try again.';
  }
  if (/ENOSPC/i.test(message)) return 'There is not enough free disk space for the translation model.';
  if (/EACCES|EPERM/i.test(message)) return 'Docuflex is not allowed to write to ~/.cache/docuflex.';
  return 'The translation model could not be downloaded. Please try again.';
}

class DownloadError extends Error {}

function currentSpeed() {
  if (speedSamples.length < 2) return 0;
  const first = speedSamples[0];
  const last = speedSamples[speedSamples.length - 1];
  const seconds = (last.at - first.at) / 1000;
  return seconds > 0 ? Math.max(0, (last.received - first.received) / seconds) : 0;
}

/** @param {DownloadState} state */
function recordProgress(state) {
  const now = Date.now();
  speedSamples.push({ at: now, received: state.received });
  // A three-second window keeps the speed steady without lagging behind.
  while (speedSamples.length > 2 && now - speedSamples[0].at > 3000) speedSamples.shift();
}

/** @param {DownloadState} state @param {string} source @param {string} target */
async function runDownload(state, source, target) {
  await mkdir(DOWNLOAD_DIRECTORY, { recursive: true });
  const python = await pythonBinary();
  let runtime = await findRuntime();
  /** @type {{ url: string; sha256?: string; size: number; path: string }[]} */
  const files = [];
  /** @type {(() => Promise<void>) | null} */
  let installEngine = null;

  if (!runtime) {
    if (!autoInstallEnabled()) throw new DownloadError('The translation engine is not installed on this server.');
    const engine = await resolveEngineWheels(python);
    files.push(...engine.wheels);
    installEngine = engine.install;
  }

  const missing = await missingModels(source, target);
  if (missing.length) {
    const index = await packageIndex();
    for (const [from, to] of missing) {
      const entry = index.find((item) => item.from_code === from && item.to_code === to);
      const url = entry?.links?.[0];
      if (!url) throw new DownloadError(`There is no ${from.toUpperCase()} to ${to.toUpperCase()} model available for download.`);
      files.push({ url, size: 0, path: join(DOWNLOAD_DIRECTORY, `translate-${from}_${to}.argosmodel`) });
    }
  }

  await Promise.all(files.map(async (file) => {
    if (!file.size) file.size = await remoteSize(file.url);
  }));
  state.total = files.reduce((sum, file) => sum + file.size, 0);
  state.phase = 'downloading';
  recordProgress(state);

  for (const file of files) await downloadFile(file, state);

  state.phase = 'installing';
  if (installEngine) {
    await installEngine();
    runtime = USER_RUNTIME;
  }
  for (const file of files.filter((item) => item.path.endsWith('.argosmodel'))) {
    await mkdir(PACKAGE_DIRECTORY, { recursive: true });
    await run(python, ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', file.path, PACKAGE_DIRECTORY]);
    await rm(file.path, { force: true });
  }
  if ((await missingModels(source, target)).length) throw new DownloadError('The language model was downloaded but could not be installed.');
}

/** @type {any[] | null} */
let cachedIndex = null;

/** @param {boolean} [preferCached] @returns {Promise<any[]>} */
async function packageIndex(preferCached = false) {
  if (preferCached && cachedIndex) return cachedIndex;
  if (preferCached) {
    try { return (cachedIndex = JSON.parse(await readFile(LOCAL_INDEX, 'utf8'))); } catch {}
  }
  try {
    const response = await fetch(REMOTE_INDEX, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`index ${response.status}`);
    const text = await response.text();
    const index = JSON.parse(text);
    await mkdir(join(DATA_HOME, 'argos-translate'), { recursive: true });
    await writeFile(LOCAL_INDEX, text);
    return (cachedIndex = index);
  } catch (error) {
    try { return JSON.parse(await readFile(LOCAL_INDEX, 'utf8')); } catch {}
    throw error;
  }
}

/** @param {string} url */
async function remoteSize(url) {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  return Number(response.headers.get('content-length')) || 0;
}

/** @param {{ url: string; sha256?: string; size: number; path: string }} file @param {DownloadState} state */
async function downloadFile(file, state) {
  const response = await fetch(file.url, { redirect: 'follow', signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new DownloadError(`The download server answered with HTTP ${response.status}. Try again later.`);
  const hash = createHash('sha256');
  const partial = `${file.path}.partial`;
  const body = Readable.fromWeb(/** @type {any} */ (response.body));
  body.on('data', (chunk) => {
    hash.update(chunk);
    state.received += chunk.length;
    recordProgress(state);
  });
  await pipeline(body, createWriteStream(partial));
  if (file.sha256 && hash.digest('hex') !== file.sha256) {
    await rm(partial, { force: true });
    throw new DownloadError('A downloaded file was damaged in transit. Try again.');
  }
  await rename(partial, file.path);
}

/**
 * Lists the engine's wheels (with hashes) so they can be downloaded with progress,
 * then installed offline. The bundled Python has no pip; a throwaway venv bootstraps one.
 * @param {string} python
 */
async function resolveEngineWheels(python) {
  const installer = join(TRANSLATE_CACHE, 'translate-installer');
  const wheels = join(DOWNLOAD_DIRECTORY, 'wheels');
  const report = join(DOWNLOAD_DIRECTORY, 'engine-report.json');
  await Promise.all([rm(installer, { recursive: true, force: true }), rm(wheels, { recursive: true, force: true })]);
  await mkdir(wheels, { recursive: true });
  await run(python, ['-m', 'venv', installer]);
  const installerPython = process.platform === 'win32' ? join(installer, 'Scripts', 'python.exe') : join(installer, 'bin', 'python');
  // The desktop's Linux python3 is a wrapper that sets LD_LIBRARY_PATH for its
  // libpython; the venv links the real interpreter and skips that wrapper.
  const pythonLibrary = join(dirname(dirname(python)), 'lib');
  const installerEnv = process.platform === 'linux'
    ? { ...process.env, LD_LIBRARY_PATH: [pythonLibrary, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter) }
    : process.env;
  const pipOptions = ['--disable-pip-version-check', '--no-input', '--only-binary=:all:'];
  await run(installerPython, ['-m', 'pip', 'install', ...pipOptions, '--dry-run', '--ignore-installed', '--quiet', '--report', report, ...ENGINE_PACKAGES], installerEnv);
  const resolved = JSON.parse(await readFile(report, 'utf8'));
  const files = resolved.install.map((/** @type {any} */ item) => {
    const url = item.download_info.url;
    return { url, sha256: item.download_info.archive_info?.hashes?.sha256, size: 0, path: join(wheels, decodeURIComponent(url.split('/').pop().split('#')[0])) };
  });
  return {
    wheels: files,
    async install() {
      const staging = `${USER_RUNTIME}.partial`;
      await rm(staging, { recursive: true, force: true });
      try {
        await run(installerPython, ['-m', 'pip', 'install', ...pipOptions, '--no-index', '--find-links', wheels, '--target', staging, ...ENGINE_PACKAGES], installerEnv);
        if (!(await hasRuntime(staging))) throw new DownloadError('The translation engine install is incomplete. Try again.');
        await rm(USER_RUNTIME, { recursive: true, force: true });
        await rename(staging, USER_RUNTIME);
      } finally {
        await Promise.all([
          rm(staging, { recursive: true, force: true }),
          rm(installer, { recursive: true, force: true }),
          rm(wheels, { recursive: true, force: true }),
          rm(report, { force: true })
        ]);
      }
    }
  };
}

/** @param {string} binary @param {string[]} args */
function run(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorLog = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), STEP_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (errorLog.length < 64 * 1024) errorLog += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(undefined);
      else reject(new Error(errorLog.trim() || `${binary} stopped (${signal ?? `exit ${code}`}).`));
    });
  });
}
