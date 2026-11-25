// Linux and Windows desktop shell. Tauri's system web views (WebKitGTK on
// Linux, WebView2 on Windows) render the editor slower and less predictably
// than a pinned Chromium; this shell runs the same local services and editor in
// Electron and answers the same commands as desktop/src-tauri.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const isWindows = process.platform === 'win32';
const FRONTEND_PORT = 43_127;
const BACKEND_PORT = 43_128;
const MAX_OPEN_PDF_BYTES = 230 * 1024 * 1024;
const EDITOR_URL = `http://127.0.0.1:${FRONTEND_PORT}/editor`;
const EDITOR_ORIGIN = new URL(EDITOR_URL).origin;
const LATEST_RELEASE_API = 'https://api.github.com/repos/max06bayer/docuflex/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/max06bayer/docuflex/releases/download/';

const resourceRoot = process.env.DOCUFLEX_RESOURCES
  ?? path.join(process.resourcesPath, 'docuflex', 'resources');
// Same log folders as the Tauri builds, so support instructions stay valid.
const logDirectory = path.join(
  isWindows
    ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
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
if (isWindows) {
  // Taskbar grouping and pinning use the installer's identity.
  app.setAppUserModelId('com.docuflex.editor');
}

// Interface size on top of the editor's own --ui-scale. Chromium already
// follows the Windows display scale (150 % on a typical 4K screen), which made
// the editor look larger than other Windows apps; start a step smaller there.
// Ctrl+= / Ctrl+- / Ctrl+0 change it and the choice is remembered.
const DEFAULT_INTERFACE_ZOOM = isWindows ? 0.9 : 1;
const settingsFile = () => path.join(app.getPath('userData'), 'shell-settings.json');

function readShellSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) ?? {}; } catch { return {}; }
}

/** @param {number} zoom */
function saveInterfaceZoom(zoom) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), `${JSON.stringify({ ...readShellSettings(), interfaceZoom: zoom }, null, 2)}\n`);
  } catch {}
}

function interfaceZoom() {
  const saved = Number(readShellSettings().interfaceZoom);
  return Number.isFinite(saved) && saved >= 0.5 && saved <= 2 ? saved : DEFAULT_INTERFACE_ZOOM;
}

/** Blocks the main thread briefly; only used while quitting. @param {number} milliseconds */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** @param {string[]} argv @param {string} cwd */
function pdfPathFromArguments(argv, cwd) {
  for (const argument of argv.slice(1)) {
    let candidate;
    if (argument.startsWith('file://')) {
      try { candidate = fileURLToPath(argument); } catch { continue; }
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
  if (isWindows) {
    // No console windows for the services. Quitting ends their process trees
    // (stopServices); leftovers of a crashed shell are cleared on next start.
    return spawn(executable, args, {
      cwd: resourceRoot, env: environment, stdio: ['ignore', output, output], windowsHide: true
    });
  }
  return spawn(
    '/bin/sh',
    [path.join(resourceRoot, 'runtime/supervise.sh'), String(process.pid), executable, ...args],
    { cwd: resourceRoot, env: environment, stdio: ['ignore', output, output] }
  );
}

/** Bundled tool paths. Windows keeps Poppler apart from Tesseract and uses .exe names. */
function toolPaths() {
  const runtime = (/** @type {string} */ ...parts) => path.join(resourceRoot, 'runtime', ...parts);
  if (isWindows) {
    return {
      runtime,
      java: runtime('java/bin/java.exe'),
      node: runtime('node/bin/node.exe'),
      python: runtime('python/python.exe'),
      office: runtime('office/program/soffice.com'),
      pdf2htmlEX: runtime('pdf2htmlEX/bin/pdf2htmlEX.exe'),
      pdftoppm: runtime('ocr/poppler/bin/pdftoppm.exe'),
      pdfunite: runtime('ocr/poppler/bin/pdfunite.exe'),
      tesseract: runtime('ocr/bin/tesseract.exe')
    };
  }
  return {
    runtime,
    java: runtime('java/bin/java'),
    node: runtime('node/bin/node'),
    python: runtime('python/bin/python3'),
    office: runtime('office/program/soffice'),
    pdf2htmlEX: runtime('pdf2htmlEX/bin/pdf2htmlEX'),
    pdftoppm: runtime('ocr/bin/pdftoppm'),
    pdfunite: runtime('ocr/bin/pdfunite'),
    tesseract: runtime('ocr/bin/tesseract')
  };
}

/** @param {number} port @returns {Promise<boolean>} */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(300);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Windows has no parent-death signal: if Docuflex crashed or was ended from
 * Task Manager, its Java and Node services keep running and hold the ports.
 * End only processes started from this installation's runtime folder.
 */
async function clearStaleWindowsServices() {
  if (!(await portInUse(BACKEND_PORT)) && !(await portInUse(FRONTEND_PORT))) return;
  const runtimeFolder = path.join(resourceRoot, 'runtime').replaceAll("'", "''");
  spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${runtimeFolder}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  ], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && ((await portInUse(BACKEND_PORT)) || (await portInUse(FRONTEND_PORT)))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function spawnServices() {
  const tools = toolPaths();
  const runtime = tools.runtime;
  const backend = supervised(
    tools.java,
    ['-cp', ['backend/out', 'backend/lib/pdfbox-app-3.0.8.jar'].join(path.delimiter), 'DocuflexPdfServer'],
    {
      PDF_BACKEND_HOST: '127.0.0.1',
      PDF_BACKEND_PORT: String(BACKEND_PORT),
      JAVA_TOOL_OPTIONS: '-Xms64m -XX:MaxRAMPercentage=50 -XX:+ExitOnOutOfMemoryError'
    },
    'pdf-backend'
  );
  const frontend = supervised(
    tools.node,
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
      DOCUFLEX_DISTRIBUTION: 'direct',
      // RLIMIT_NPROC counts every process of the KDE session user.
      DISABLE_DOCUMENT_PRLIMIT: '1',
      ADDRESS_HEADER: '',
      PROTOCOL_HEADER: '',
      HOST_HEADER: '',
      PDF2HTMLEX_BIN: tools.pdf2htmlEX,
      PDF2HTMLEX_DATA_DIR: runtime('pdf2htmlEX/share/pdf2htmlEX'),
      PDFTOPPM_BIN: tools.pdftoppm,
      PDFUNITE_BIN: tools.pdfunite,
      TESSERACT_BIN: tools.tesseract,
      TESSDATA_PREFIX: runtime('ocr/share/tessdata'),
      PDF_RENDER_BIN: tools.pdftoppm,
      PYTHONDONTWRITEBYTECODE: '1',
      ANALYTICS_ENABLED: 'false',
      DOCUMENT_CONVERTER_PYTHON: tools.python,
      DOCUMENT_CONVERTER_BIN: tools.office
    },
    'frontend'
  );
  services = [backend, frontend];
}

function stopServices() {
  if (isWindows) {
    // /T also ends their children (Office, Python and pdf2htmlEX conversions).
    for (const child of services) {
      if (child.pid && child.exitCode === null) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
    }
    services = [];
    return;
  }
  for (const child of services) {
    try { process.kill(/** @type {number} */ (child.pid), 'SIGTERM'); } catch {}
  }
  // Quitting must never hang on a helper; take down the supervised services too.
  const deadline = Date.now() + 3000;
  for (const child of services) {
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      sleepSync(25);
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

/** The release file this copy installs from. @param {string} name */
function wantedAsset(name) {
  if (isWindows) return name.endsWith('-setup.exe');
  return isArch() ? name.endsWith('.pkg.tar.zst') : name.endsWith('.deb');
}

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
    // The frontend prints through the web view, as with Tauri on Linux and Windows.
    throw new Error('unsupported');
  },
  async docuflex_update_check() {
    const current = app.getVersion();
    const release = JSON.parse(await fetchText(LATEST_RELEASE_API));
    const latest = String(release.tag_name ?? '').replace(/^v/, '');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const checksums = assets.find((/** @type {any} */ asset) => asset.name === 'SHA256SUMS.txt');
    const asset = assets.find((/** @type {any} */ candidate) => wantedAsset(String(candidate.name)));
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
    if (isWindows) {
      // The installer waits for Docuflex to close, installs silently and
      // starts the new version (--force-run).
      spawn(downloadedUpdate, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
      return;
    }
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
    // Windows: keeps the native border, shadow, Snap layouts and edge
    // resizing while the web header draws the title bar.
    thickFrame: true,
    show: false,
    backgroundColor: '#f8f8f8',
    icon: path.join(__dirname, isWindows ? 'icon.ico' : 'icon.png'),
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
  // The taskbar and Alt+Tab show "Docuflex", not the website's page title.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  const contents = mainWindow.webContents;
  // Ctrl+wheel and pinch zoom the PDF (PdfEditor.svelte), never the interface.
  void contents.setVisualZoomLevelLimits(1, 1);
  contents.on('did-finish-load', () => contents.setZoomFactor(interfaceZoom()));
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const current = contents.getZoomFactor();
    let next = null;
    if (input.key === '=' || input.key === '+') next = current + 0.05;
    else if (input.key === '-' || input.key === '_') next = current - 0.05;
    else if (input.key === '0' && !input.shift) next = DEFAULT_INTERFACE_ZOOM;
    if (next === null) return;
    event.preventDefault();
    next = Math.round(Math.min(1.5, Math.max(0.6, next)) * 100) / 100;
    contents.setZoomFactor(next);
    saveInterfaceZoom(next);
  });
  contents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.protocol === 'file:' && /\.pdf$/i.test(target.pathname)) {
      // A PDF dropped onto the window.
      event.preventDefault();
      pendingPdf = fileURLToPath(target);
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
  // `electron .` (development) puts the app folder in argv[1]. Not app.isPackaged:
  // the Linux packages run a binary named "electron", which Electron treats as
  // unpackaged even when installed.
  pendingPdf = pdfPathFromArguments(process.argv.slice(process.defaultApp ? 1 : 0), process.cwd());

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
      if (isWindows) await clearStaleWindowsServices();
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
