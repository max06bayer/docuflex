import { writable, get } from 'svelte/store';

// Version this whenever recipients, purposes or the disclosure materially change.
// Existing API keys do not imply permission.
export const CLOUD_AI_DISCLOSURE_VERSION = '2026-11-01';
export const CLOUD_AI_PERMISSION_KEY = 'docuflex-cloud-ai-permission';
function readPermission() {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(CLOUD_AI_PERMISSION_KEY) === CLOUD_AI_DISCLOSURE_VERSION; }
  catch { return false; }
}
export const cloudAiAllowed = writable(readPermission());

/** Persist only an affirmative versioned choice, never any document data. @param {boolean} allowed */
export function setCloudAiPermission(allowed) {
  cloudAiAllowed.set(allowed);
  try {
    if (allowed) localStorage.setItem(CLOUD_AI_PERMISSION_KEY, CLOUD_AI_DISCLOSURE_VERSION);
    else localStorage.removeItem(CLOUD_AI_PERMISSION_KEY);
  } catch { /* Storage blocked: permission lasts only in this window. */ }
}
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key === CLOUD_AI_PERMISSION_KEY || event.key === null) cloudAiAllowed.set(readPermission());
});
/** @type {Promise<boolean> | null} */
let pending = null;

/** One shared, remembered permission for every cloud feature; local Qwen bypasses it.
 * @param {string} model @returns {Promise<boolean>}
 */
export function requestCloudAiPermission(model) {
  if (model === 'ollama/qwen3.5:4b-q4_K_M' || get(cloudAiAllowed)) return Promise.resolve(true);
  if (pending) return pending;
  pending = showDisclosure().catch(() => false).finally(() => { pending = null; });
  return pending;
}

async function showDisclosure() {
  if (typeof document === 'undefined') return false;
  const [{ mount, unmount }, { default: Panel }] = await Promise.all([import('svelte'), import('#lib/CloudAiDisclosure.svelte')]);
  return new Promise((resolve) => {
    const host = document.createElement('div');
    // The editor shell owns the app's UI zoom. Mount beside its existing
    // popups so the disclosure uses exactly the same scale and coordinates.
    (document.querySelector('.editor-shell') || document.body).append(host);
    let completed = false;
    const panel = mount(Panel, { target: host, props: { onChoose: (/** @type {boolean} */ allowed) => {
      if (completed) return;
      completed = true;
      setCloudAiPermission(allowed);
      void unmount(panel).then(() => host.remove());
      resolve(allowed);
    } } });
  });
}

export function revokeCloudAiPermission() { setCloudAiPermission(false); }
