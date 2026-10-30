// Linux desktop shell. Tauri uses WebKitGTK on Linux, which renders the editor
// far slower than Chromium; this shell runs the same local services and editor
// in Electron and answers the same commands as desktop/src-tauri.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const FRONTEND_PORT = 43_127;
const BACKEND_PORT = 43_128;
const MAX_OPEN_PDF_BYTES = 230 * 1024 * 1024;
const EDITOR_URL = `http://127.0.0.1:${FRONTEND_PORT}/editor`;
const EDITOR_ORIGIN = new URL(EDITOR_URL).origin;
const LATEST_RELEASE_API = 'https://api.github.com/repos/max06bayer/docuflex/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/max06bayer/docuflex/releases/download/';

const resourceRoot = process.env.DOCUFLEX_RESOURCES
  ?? path.join(process.resourcesPath, 'docuflex', 'resources');
const logDirectory = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'com.docuflex.editor',
  'logs'
);

/** @type {import('node:child_process').ChildProcess[]} */
let services = [];
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {string | null} */
let pendingPdf = null;
/** @type {{ name: string, url: string, size: number, checksumsUrl: string | null } | null} */
let updateAsset = null;
/** @type {string | null} */
let downloadedUpdate = null;

// MCP agents drive the editor while the window is behind their terminal.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setName('Docuflex');

/** @param {string[]} argv @param {string} cwd */
function pdfPathFromArguments(argv, cwd) {
  for (const argument of argv.slice(1)) {
    let candidate;
    if (argument.startsWith('file://')) {
      try { candidate = new URL(argument).pathname; } catch { continue; }
      candidate = decodeURIComponent(candidate);
    } else if (argument.startsWith('-')) {
      continue;
    } else {
      candidate = path.resolve(cwd, argument);
    }
    if (/\.pdf$/i.test(candidate) && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return candidate;
    }
  }
  return null;
}

function notifyPendingPdf() {
  mainWindow?.webContents
    .executeJavaScript("window.dispatchEvent(new Event('docuflex-native-open-pdf'))")
    .catch(() => {});
}

/** @param {string} name */
function logStream(name) {
  fs.mkdirSync(logDirectory, { recursive: true });
  return fs.openSync(path.join(logDirectory, `${name}.log`), 'w');
}

/** @param {string} executable @param {string[]} args @param {Record<string, string>} env @param {string} log */
function supervised(executable, args, env, log) {
  const environment = { ...process.env, ...env };
  // Electron and AppImage library paths must not leak into the bundled runtimes.
  for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PYTHONHOME', 'PYTHONPATH', 'ELECTRON_RUN_AS_NODE']) {
    delete environment[key];
  }
  const output = logStream(log);
  return spawn(
    '/bin/sh',
    [path.join(resourceRoot, 'runtime/supervise.sh'), String(process.pid), executable, ...args],
    { cwd: resourceRoot, env: environment, stdio: ['ignore', output, output] }
  );
}

function spawnServices() {
  const runtime = (/** @type {string} */ ...parts) => path.join(resourceRoot, 'runtime', ...parts);
  const backend = supervised(
    runtime('java/bin/java'),
    ['-cp', 'backend/out:backend/lib/pdfbox-app-3.0.8.jar', 'DocuflexPdfServer'],
    {
      PDF_BACKEND_HOST: '127.0.0.1',
      PDF_BACKEND_PORT: String(BACKEND_PORT),
      JAVA_TOOL_OPTIONS: '-Xms64m -XX:MaxRAMPercentage=50 -XX:+ExitOnOutOfMemoryError'
    },
    'pdf-backend'
  );
  const frontend = supervised(
    runtime('node/bin/node'),
    ['frontend/index.js'],
    {
      HOST: '127.0.0.1',
      PORT: String(FRONTEND_PORT),
      ORIGIN: EDITOR_ORIGIN,
      PDF_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      BODY_SIZE_LIMIT: String(MAX_OPEN_PDF_BYTES),
      // Event streams (MCP bridge, AI chat) would hold graceful shutdown for 30 s.
      SHUTDOWN_TIMEOUT: '1',
      DOCUFLEX_MCP: '1',
      DOCUFLEX_TRANSLATE_AUTO_INSTALL: '1',
      // RLIMIT_NPROC counts every process of the KDE session user.
      DISABLE_DOCUMENT_PRLIMIT: '1',
      ADDRESS_HEADER: '',
      PROTOCOL_HEADER: '',
      HOST_HEADER: '',
      PDF2HTMLEX_BIN: runtime('pdf2htmlEX/bin/pdf2htmlEX'),
      PDF2HTMLEX_DATA_DIR: runtime('pdf2htmlEX/share/pdf2htmlEX'),
      PDFTOPPM_BIN: runtime('ocr/bin/pdftoppm'),
      PDFUNITE_BIN: runtime('ocr/bin/pdfunite'),
      TESSERACT_BIN: runtime('ocr/bin/tesseract'),
      TESSDATA_PREFIX: runtime('ocr/share/tessdata'),
      PDF_RENDER_BIN: runtime('ocr/bin/pdftoppm'),
      PYTHONDONTWRITEBYTECODE: '1',
      ANALYTICS_ENABLED: 'false',
      DOCUMENT_CONVERTER_PYTHON: runtime('python/bin/python3'),
      DOCUMENT_CONVERTER_BIN: runtime('office/program/soffice')
    },
    'frontend'
  );
  services = [backend, frontend];
}

function stopServices() {
  for (const child of services) {
    try { process.kill(/** @type {number} */ (child.pid), 'SIGTERM'); } catch {}
  }
  // Quitting must never hang on a helper; take down the supervised services too.
  const deadline = Date.now() + 3000;
  for (const child of services) {
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      spawnSync('/bin/sleep', ['0.025']);
    }
    if (child.exitCode === null && child.signalCode === null) {
      spawnSync('/usr/bin/pkill', ['-KILL', '-P', String(child.pid)]);
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  services = [];
}

/** @param {number} port @param {string} route */
function serviceReady(port, route) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, timeout: 500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

/** @param {string} name */
function logTail(name) {
  try {
    const text = fs.readFileSync(path.join(logDirectory, `${name}.log`), 'utf8').slice(-4000);
    return text.trim() ? text : 'log is empty';
  } catch {
    return 'log unavailable';
  }
}

async function waitForServices() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await serviceReady(BACKEND_PORT, '/health') && await serviceReady(FRONTEND_PORT, '/editor')) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(
    `Docuflex local services did not start within 60 seconds.\nLogs: ${logDirectory}\n\n`
      + `[pdf-backend]\n${logTail('pdf-backend')}\n\n[frontend]\n${logTail('frontend')}`
  );
}

/** @param {string} suggestedName */
async function chooseSaveDestination(suggestedName) {
  const result = await dialog.showSaveDialog(/** @type {BrowserWindow} */ (mainWindow), {
    defaultPath: path.basename(suggestedName || 'document.pdf')
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}

/** @param {string} url @param {string} [accept] */
function fetchText(url, accept = 'application/vnd.github+json') {
  return fetch(url, {
    headers: { 'User-Agent': 'Docuflex-Updater', Accept: accept },
    signal: AbortSignal.timeout(20_000)
  }).then((response) => {
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    return response.text();
  });
}

/** @param {string} latest @param {string} current */
function isNewer(latest, current) {
  const parts = (/** @type {string} */ version) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

/** @param {string} value */
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const isArch = () => fs.existsSync('/usr/bin/pacman');

/** @type {Record<string, (event: Electron.IpcMainInvokeEvent, args: any) => unknown>} */
const commands = {
  take_pending_pdf() {
    const file = pendingPdf;
    pendingPdf = null;
    if (!file) return null;
    const size = fs.statSync(file).size;
    if (size === 0 || size > MAX_OPEN_PDF_BYTES) throw new Error('The selected PDF is empty or too large.');
    const bytes = fs.readFileSync(file);
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The selected file is not a valid PDF.');
    return { name: path.basename(file), base64: bytes.toString('base64'), path: file };
  },
  start_window_drag() {
    // Dragging uses -webkit-app-region from chrome.js in Chromium.
  },
  async docuflex_save_prompt(_event, { suggestedName, base64 }) {
    const destination = await chooseSaveDestination(suggestedName);
    if (!destination) throw new Error('cancelled');
    fs.writeFileSync(destination, Buffer.from(base64, 'base64'));
    return destination;
  },
  docuflex_save_overwrite(_event, { path: destination, base64 }) {
    fs.writeFileSync(destination, Buffer.from(base64, 'base64'));
  },
  docuflex_print_pdf() {
    // The frontend prints through the web view, as with Tauri on Linux.
    throw new Error('unsupported');
  },
  async docuflex_update_check() {
    const current = app.getVersion();
    const release = JSON.parse(await fetchText(LATEST_RELEASE_API));
    const latest = String(release.tag_name ?? '').replace(/^v/, '');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const checksums = assets.find((/** @type {any} */ asset) => asset.name === 'SHA256SUMS.txt');
    const wanted = (/** @type {string} */ name) => (isArch() ? name.endsWith('.pkg.tar.zst') : name.endsWith('.deb'));
    const asset = assets.find((/** @type {any} */ candidate) => wanted(String(candidate.name)));
    updateAsset = asset && String(asset.browser_download_url).startsWith(DOWNLOAD_PREFIX)
      ? {
          name: asset.name,
          url: asset.browser_download_url,
          size: Number(asset.size) || 0,
          checksumsUrl: checksums?.browser_download_url ?? null
        }
      : null;
    return {
      current,
      latest,
      available: Boolean(latest) && isNewer(latest, current) && Boolean(updateAsset),
      releaseUrl: String(release.html_url ?? '')
    };
  },
  async docuflex_update_download(event) {
    const asset = updateAsset;
    if (!asset) throw new Error('Check for updates first.');
    const directory = path.join(os.tmpdir(), 'docuflex-update');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, asset.name);
    const progress = (/** @type {number} */ received) =>
      event.sender.send('docuflex-event', 'docuflex-update-progress', { received, total: asset.size });
    const response = await fetch(asset.url, { headers: { 'User-Agent': 'Docuflex-Updater' } });
    if (!response.ok || !response.body) {
      throw new Error('The download failed. Check your internet connection and try again.');
    }
    const output = fs.createWriteStream(destination);
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
      if (Date.now() - lastReport > 150) {
        lastReport = Date.now();
        progress(received);
      }
    }
    await new Promise((resolve, reject) => output.end((/** @type {any} */ error) => (error ? reject(error) : resolve(null))));
    progress(asset.size);
    if (asset.checksumsUrl) {
      const sums = await fetchText(asset.checksumsUrl, 'text/plain');
      const expected = sums.split('\n').map((line) => line.trim().split(/\s+/))
        .find(([, name]) => name?.replace(/^\*/, '') === asset.name)?.[0]?.toLowerCase();
      if (!expected) throw new Error('The release has no checksum for this download.');
      if (hash.digest('hex') !== expected) {
        fs.rmSync(destination, { force: true });
        throw new Error('The download is damaged (checksum mismatch). Please try again.');
      }
    }
    downloadedUpdate = destination;
  },
  docuflex_update_install() {
    if (!downloadedUpdate) throw new Error('Download the update first.');
    const install = isArch()
      ? `pkexec pacman -U --noconfirm ${shellQuote(downloadedUpdate)}`
      : `pkexec apt-get install -y ${shellQuote(downloadedUpdate)}`;
    const script = path.join(path.dirname(downloadedUpdate), 'install-update.sh');
    fs.writeFileSync(
      script,
      `#!/bin/sh\nwhile kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done\n${install}\nexec docuflex-desktop\n`
    );
    // Its own session, so quitting Docuflex does not take it down.
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }
};

ipcMain.handle('docuflex-invoke', async (event, command, args) => {
  if (new URL(event.senderFrame?.url ?? 'about:blank').origin !== EDITOR_ORIGIN) {
    throw new Error('Docuflex commands are only available to the editor.');
  }
  const handler = commands[command];
  if (!handler) throw new Error(`Unknown command ${command}.`);
  return handler(event, args ?? {});
});

/** @param {string} action */
function windowAction(action) {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  else if (action === 'close') mainWindow.close();
  else if (action === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Docuflex',
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    center: true,
    frame: false,
    show: false,
    backgroundColor: '#f8f8f8',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload reads chrome.js from disk.
      sandbox: false,
      backgroundThrottling: false
    }
  });
  mainWindow.setMenu(null);

  const contents = mainWindow.webContents;
  contents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.protocol === 'file:' && /\.pdf$/i.test(target.pathname)) {
      // A PDF dropped onto the window.
      event.preventDefault();
      pendingPdf = decodeURIComponent(target.pathname);
      notifyPendingPdf();
      return;
    }
    if (target.origin === EDITOR_ORIGIN && target.pathname.startsWith('/__docuflex/window/')) {
      event.preventDefault();
      windowAction(target.pathname.slice('/__docuflex/window/'.length));
      return;
    }
    if (!(target.origin === EDITOR_ORIGIN && target.pathname === '/editor')) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.session.on('will-download', (_event, item) => {
    // Matches Tauri's native save dialog for browser downloads.
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
  });
  if (process.env.DOCUFLEX_PAGE_LOAD_MARKER) {
    contents.on('did-finish-load', () => {
      if (new URL(contents.getURL()).pathname === '/editor') {
        fs.writeFileSync(/** @type {string} */ (process.env.DOCUFLEX_PAGE_LOAD_MARKER), 'editor-loaded\n');
      }
    });
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(EDITOR_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  pendingPdf = pdfPathFromArguments(process.argv.slice(app.isPackaged ? 0 : 1), process.cwd());

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const file = pdfPathFromArguments(argv, workingDirectory);
    if (file) {
      pendingPdf = file;
      notifyPendingPdf();
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      spawnServices();
      await waitForServices();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      fs.mkdirSync(logDirectory, { recursive: true });
      fs.writeFileSync(path.join(logDirectory, 'startup.log'), `${message}\n`);
      dialog.showErrorBox('Docuflex could not start', message);
      stopServices();
      app.exit(1);
      return;
    }
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', stopServices);
}
