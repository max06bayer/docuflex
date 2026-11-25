// Gives the editor the same window.__TAURI__ surface the Tauri shell has, then
// runs the shared desktop chrome script (window controls, save bridge, PDF open).
const { contextBridge, ipcRenderer, webFrame } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** @type {Map<string, Set<(event: { event: string, payload: unknown }) => void>>} */
const listeners = new Map();
ipcRenderer.on('docuflex-event', (_event, name, payload) => {
  for (const handler of listeners.get(name) ?? []) handler({ event: name, payload });
});

contextBridge.exposeInMainWorld('__TAURI__', {
  core: {
    invoke: (/** @type {string} */ command, /** @type {unknown} */ args) =>
      ipcRenderer.invoke('docuflex-invoke', command, args).catch((error) => {
        // Tauri rejects with the command's error string; keep that contract.
        throw String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      })
  },
  event: {
    listen: async (/** @type {string} */ name, /** @type {(event: any) => void} */ handler) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(handler);
      return () => listeners.get(name)?.delete(handler);
    }
  }
});

const chromeScript = [
  path.join(__dirname, 'chrome.js'),
  path.join(__dirname, '..', 'runtime', 'chrome.js')
].find((candidate) => fs.existsSync(candidate));
if (chromeScript) {
  // Privileged injection: the editor's CSP has no 'unsafe-eval'.
  void webFrame.executeJavaScript(fs.readFileSync(chromeScript, 'utf8'));
}
