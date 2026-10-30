import { qwenOptions } from '#lib/server/ollama-options.js';
import { readOllamaEvents, qwenCompletionStream } from '#lib/server/ollama-stream.js';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { mcpAvailable } from '#lib/server/mcp-bridge.js';

export const QWEN_MODEL_ID = 'ollama/qwen3.5:4b-q4_K_M';
export const QWEN_TAG = 'qwen3.5:4b-q4_K_M';
export const QWEN_MODEL = { id: QWEN_MODEL_ID, name: 'Qwen 3.5 4B', short: 'Qwen 3.5 4B', local: true, downloadable: true };
const root = join(homedir(), '.docuflex', 'ollama');
const modelsDirectory = join(root, 'models');
const manifestPath = join(modelsDirectory, 'manifests', 'registry.ollama.ai', 'library', 'qwen3.5', '4b-q4_K_M');
/** @type {{ child: import('node:child_process').ChildProcess | null; url: string; starting: Promise<string> | null; download: { phase: string; status: string; received: number; total: number; error: string }; task: Promise<void> | null; abort: AbortController | null; shutdownInstalled?: boolean }} */
const state = /** @type {any} */ (globalThis).__docuflexOllama ??= { child: null, url: '', starting: null, download: { phase: 'available', status: '', received: 0, total: 0, error: '' }, task: null, abort: null };

// SvelteKit closes its listener on SIGTERM but leaves the process alive while
// child handles exist. Stop our supervisor too, so its Ollama child and runners
// cannot outlive the app or keep a model in memory across launches.
if (!state.shutdownInstalled) {
  state.shutdownInstalled = true;
  const stop = () => { state.abort?.abort(); state.child?.kill('SIGTERM'); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('exit', stop);
  process.once('sveltekit:shutdown', stop);
}

async function runtimePath() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !mcpAvailable()) return null;
  for (const path of [resolve('runtime/ollama/ollama'), resolve('desktop/src-tauri/resources/runtime/ollama/ollama')]) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  return null;
}
export async function qwenSupported() { return Boolean(await runtimePath()); }

/** Only inspect files. Status, opening a picker, and app startup never start Ollama or load a model. */
export async function qwenInstalled() {
  if (process.platform !== 'darwin' || !mcpAvailable()) return false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const layers = [manifest.config, ...(manifest.layers ?? [])];
    if (!layers.length || !manifest.layers?.length) return false;
    for (const layer of layers) {
      if (!/^sha256:[a-f0-9]{64}$/.test(layer?.digest)) return false;
      if ((await stat(join(modelsDirectory, 'blobs', layer.digest.replace(':', '-')))).size !== layer.size) return false;
    }
    return true;
  } catch { return false; }
}
export async function qwenStatus() {
  const supported = await qwenSupported();
  const ready = supported && await qwenInstalled();
  const loaded = state.url ? await fetch(`${state.url}/api/ps`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json()).then((data) => Boolean(data.models?.length)).catch(() => false) : false;
  return { supported, ready, runtimeRunning: Boolean(state.child), loaded, model: QWEN_TAG, ...state.download, phase: ready && !state.task ? 'ready' : state.download.phase };
}

/** Private, app-owned daemon on an ephemeral loopback port; it is never the user's Ollama service. */
export async function ensureOllama() {
  if (state.child && state.url) return state.url;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const binary = await runtimePath();
    if (!binary) throw new Error('The local Qwen runtime is unavailable in this build.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const port = await new Promise((resolvePort, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = /** @type {import('node:net').AddressInfo} */ (server.address());
        server.close((error) => error ? reject(error) : resolvePort(address.port));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const supervisor = [resolve('runtime/supervise.sh'), resolve('desktop/runtime/supervise.sh')];
    let watch = '';
    for (const path of supervisor) { try { await access(path); watch = path; break; } catch {} }
    if (!watch) throw new Error('The local model process supervisor is missing.');
    const child = spawn('/bin/sh', [watch, String(process.pid), binary, 'serve'], {
      cwd: resolve(binary, '..'), stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: modelsDirectory, OLLAMA_NO_CLOUD: '1', OLLAMA_CONTEXT_LENGTH: '16384', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_KEEP_ALIVE: '5m' }
    });
    state.child = child;
    let launchError = '';
    child.on('error', (error) => { launchError = error.message; });
    child.stderr?.on('data', () => {}); // No document content in persistent runtime logs.
    child.once('close', () => { if (state.child === child) { state.child = null; state.url = ''; } });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error(launchError || 'The local Qwen runtime stopped during startup.');
      if (await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false)) {
        state.url = base;
        return base;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    child.kill();
    throw new Error('The local Qwen runtime did not start.');
  })();
  try { return await state.starting; } finally { state.starting = null; }
}

/** One shared download; closing the popup does not cancel it. No inference during a pull. */
export function startQwenDownload() {
  if (state.task) return;
  state.abort = new AbortController();
  state.download = { phase: 'downloading', status: 'Starting the local runtime…', received: 0, total: 0, error: '' };
  state.task = (async () => {
    try {
      if (await qwenInstalled()) { state.download.phase = 'ready'; return; }
      const base = await ensureOllama();
      const layers = new Map();
      const response = await fetch(`${base}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: QWEN_TAG, stream: true }), signal: state.abort?.signal });
      await readOllamaEvents(response, (event) => {
        if (event.digest && event.total) layers.set(event.digest, { total: event.total, completed: event.completed ?? 0 });
        state.download.status = event.status || 'Downloading…';
        state.download.total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
        state.download.received = [...layers.values()].reduce((sum, layer) => sum + Math.min(layer.completed, layer.total), 0);
      });
      if (!(await qwenInstalled())) throw new Error('The download did not finish. Try again to resume it.');
      state.download.phase = 'ready'; state.download.status = 'Downloaded. Loads when you send a message.';
    } catch (error) {
      state.download.phase = 'error';
      state.download.error = state.abort?.signal.aborted ? 'Download paused. Choose Download to resume.' : error instanceof Error ? error.message : 'The model could not be downloaded.';
    } finally { state.task = null; state.abort = null; }
  })();
}
export function cancelQwenDownload() { state.abort?.abort(); }

/** @param {any[]} messages */
function ollamaMessages(messages) {
  const toolNames = new Map();
  return messages.map((message) => {
    for (const call of message.tool_calls ?? []) { if (call.id) toolNames.set(call.id, call.function.name); }
    const toolName = message.name || toolNames.get(message.tool_call_id);
    const content = typeof message.content === 'string' ? message.content : (message.content ?? []).filter((/** @type {any} */ part) => part.type === 'text').map((/** @type {any} */ part) => part.text).join('\n');
    const images = Array.isArray(message.content) ? message.content.filter((/** @type {any} */ part) => part.type === 'image_url').map((/** @type {any} */ part) => {
      const image = part.image_url?.url?.match(/^data:image\/(?:png|jpeg|webp);base64,(.+)$/s);
      if (!image) throw new Error('Local Qwen accepts attached image data, not external image URLs.');
      return image[1];
    }) : [];
    return { role: message.role, content, ...(images.length ? { images } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((/** @type {any} */ call) => ({ function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments } })) } : {}), ...(toolName ? { tool_name: toolName } : {}) };
  });
}

/** Native Ollama chat mapped to the existing OpenAI-style agent stream; every tool remains available.
 * @param {any[]} messages @param {any[]} tools @param {AbortSignal} signal @param {{ document?: boolean; repair?: boolean }} [settings]
 */
export async function qwenChat(messages, tools, signal, settings = {}) {
  if (!(await qwenInstalled())) throw new Error('Download Qwen 3.5 4B from the model selector first.');
  const base = await ensureOllama();
  const abort = new AbortController();
  const localMessages = ollamaMessages(messages);
  console.info('[qwen] request', JSON.stringify({ messages: localMessages.length, images: localMessages.reduce((total, message) => total + (message.images?.length || 0), 0) }));
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, abort.signal]),
    body: JSON.stringify({ model: QWEN_TAG, messages: localMessages, ...(tools.length ? { tools } : {}), stream: true, ...qwenOptions(tools.length, settings.document, settings.repair) })
  });
  if (!response.ok) { const error = await response.json().catch(() => null); throw new Error(error?.error || `Local Qwen failed (${response.status}).`); }
  return qwenCompletionStream(response, signal, () => abort.abort());
}
