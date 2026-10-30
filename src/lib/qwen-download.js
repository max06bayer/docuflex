import { get, writable } from 'svelte/store';
export const QWEN_MODEL_ID = 'ollama/qwen3.5:4b-q4_K_M';
/** @typedef {{visible: boolean; phase: string; status: string; received: number; total: number; error: string; ready: boolean}} DownloadState */
/** @type {import('svelte/store').Writable<DownloadState>} */
export const qwenDownload = writable({ visible: false, phase: 'available', status: '', received: 0, total: 0, error: '', ready: false });
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

/** @param {any} status */
function apply(status) {
  const previouslyReady = get(qwenDownload).ready;
  qwenDownload.update((state) => ({ ...state, ...status, ready: Boolean(status.ready), phase: status.ready ? 'ready' : status.phase || 'available' }));
  if (status.ready && !previouslyReady) {
    try { localStorage.setItem('docuflex-ai-model', QWEN_MODEL_ID); } catch {}
    window.dispatchEvent(new CustomEvent('docuflex:qwen-ready'));
  }
}
async function poll() {
  clearTimeout(timer);
  try {
    const response = await fetch('/api/ai/local-model', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not check the model download.');
    apply(await response.json());
    if (get(qwenDownload).phase === 'downloading') timer = setTimeout(poll, 750);
  } catch (error) {
    qwenDownload.update((state) => ({ ...state, phase: 'error', error: error instanceof Error ? error.message : 'The local service is unavailable.' }));
  }
}
export async function openQwenDownload() {
  qwenDownload.update((state) => ({ ...state, visible: true }));
  await poll();
}
export async function downloadQwen() {
  qwenDownload.update((state) => ({ ...state, phase: 'downloading', status: 'Starting…', error: '', visible: true }));
  try {
    const response = await fetch('/api/ai/local-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The download could not be started.');
    apply(result);
    await poll();
  } catch (error) {
    qwenDownload.update((state) => ({ ...state, phase: 'error', error: error instanceof Error ? error.message : 'The download could not be started.' }));
  }
}
export function dismissQwenDownload() { qwenDownload.update((state) => ({ ...state, visible: false })); }
export async function pauseQwenDownload() {
  await fetch('/api/ai/local-model', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  await poll();
}
