import { writable } from 'svelte/store';

/**
 * Desktop updates from the GitHub releases, driven by the native updater
 * (desktop/src-tauri/src/updater.rs). The website has no updater.
 *
 * @typedef {{ current: string; latest: string; available: boolean; releaseUrl: string }} UpdateInfo
 * @typedef {{ phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'; info: UpdateInfo | null; received: number; total: number; error: string; visible: boolean }} UpdateState
 */

/** @type {import('svelte/store').Writable<UpdateState>} */
export const update = writable({ phase: 'idle', info: null, received: 0, total: 0, error: '', visible: false });

function tauri() {
  return typeof window === 'undefined' ? null : /** @type {any} */ (window).__TAURI__ ?? null;
}

export function isDesktopApp() {
  return Boolean(tauri()?.core?.invoke);
}

/** @param {unknown} error */
function message(error) {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * Asks GitHub for a newer release. A newer one shows the update box; a manual
 * check (Settings' Update button) always opens it, also to say Docuflex is up
 * to date or GitHub is unreachable.
 * @param {{ manual?: boolean }} [options]
 */
export async function checkForUpdate({ manual = false } = {}) {
  const api = tauri();
  if (!api?.core?.invoke) return;
  let busy = false;
  update.update((state) => {
    busy = ['downloading', 'ready', 'installing'].includes(state.phase);
    return busy ? { ...state, visible: true } : { ...state, phase: 'checking', error: '', visible: manual };
  });
  if (busy) return;
  try {
    /** @type {UpdateInfo} */
    const info = await api.core.invoke('docuflex_update_check');
    update.set({ phase: info.available ? 'available' : 'current', info, received: 0, total: 0, error: '', visible: info.available || manual });
  } catch (error) {
    update.set({ phase: manual ? 'error' : 'idle', info: null, received: 0, total: 0, error: message(error), visible: manual });
  }
}

export async function downloadUpdate() {
  const api = tauri();
  if (!api?.core?.invoke) return;
  update.update((state) => ({ ...state, phase: 'downloading', received: 0, total: 0, error: '', visible: true }));
  const stop = await api.event?.listen?.('docuflex-update-progress', (/** @type {any} */ event) => {
    const { received, total } = event.payload ?? {};
    update.update((state) => (state.phase === 'downloading' ? { ...state, received, total } : state));
  });
  try {
    await api.core.invoke('docuflex_update_download');
    update.update((state) => ({ ...state, phase: 'ready', visible: true }));
  } catch (error) {
    update.update((state) => ({ ...state, phase: 'error', error: message(error), visible: true }));
  } finally {
    stop?.();
  }
}

export async function installUpdate() {
  const api = tauri();
  if (!api?.core?.invoke) return;
  update.update((state) => ({ ...state, phase: 'installing', visible: true }));
  try {
    // Docuflex quits here; the helper installs the new version and opens it.
    await api.core.invoke('docuflex_update_install');
  } catch (error) {
    update.update((state) => ({ ...state, phase: 'error', error: message(error), visible: true }));
  }
}

/** Hides the box; a download keeps going and the Settings button brings it back. */
export function dismissUpdate() {
  update.update((state) => ({ ...state, visible: false }));
}
