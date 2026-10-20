/** Languages the local translation engine supports (mirrors /api/translate). */
export const TRANSLATION_LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'German' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'it', label: 'Italian' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'nl', label: 'Dutch' },
  { id: 'pl', label: 'Polish' },
  { id: 'ru', label: 'Russian' },
  { id: 'uk', label: 'Ukrainian' },
  { id: 'ar', label: 'Arabic' },
  { id: 'zh', label: 'Chinese' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' }
];

const PREFERENCE_KEY = 'docuflex-translate-languages';

/** @param {string} language */
export function translationLanguageLabel(language) {
  return TRANSLATION_LANGUAGES.find((item) => item.id === language)?.label ?? language.toUpperCase();
}

/** The last language pair, or English into the browser's language (German when that is English too). */
export function preferredTranslationLanguages() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? 'null');
    if (isSupported(saved?.source) && isSupported(saved?.target) && saved.source !== saved.target) return saved;
  } catch {}
  const browser = typeof navigator === 'undefined' ? '' : navigator.language.slice(0, 2).toLowerCase();
  return { source: 'en', target: isSupported(browser) && browser !== 'en' ? browser : 'de' };
}

/** @param {string} source @param {string} target */
export function rememberTranslationLanguages(source, target) {
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ source, target })); } catch {}
}

/** @param {unknown} language */
function isSupported(language) {
  return typeof language === 'string' && TRANSLATION_LANGUAGES.some((item) => item.id === language);
}

/**
 * Sends a PDF to the local translation service.
 * @param {Blob} pdf @param {string} source @param {string} target @param {AbortSignal} [signal]
 * @returns {Promise<{ blob: Blob; missed: number }>}
 */
export async function translatePdf(pdf, source, target, signal) {
  const form = new FormData();
  form.set('file', pdf instanceof File ? pdf : new File([pdf], 'document.pdf', { type: 'application/pdf' }));
  form.set('sourceLanguage', source);
  form.set('targetLanguage', target);
  /** @type {Response} */
  let response;
  try {
    response = await fetch('/api/translate', { method: 'POST', body: form, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Could not reach the Docuflex server.');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `Translation failed (${response.status}).`);
  }
  return {
    blob: await response.blob(),
    missed: Number(response.headers.get('X-Docuflex-Missed-Runs')) || 0
  };
}

/**
 * @typedef {{ phase: 'preparing' | 'downloading' | 'installing' | 'done' | 'failed'; received: number; total: number; bytesPerSecond: number; error: string }} ModelDownload
 * @typedef {{ engineReady: boolean; modelReady: boolean; canDownload: boolean; local: boolean; downloadBytes: number | null; download: ModelDownload | null }} TranslationStatus
 */

/** @param {string} source @param {string} target @param {'GET' | 'POST'} [method] @returns {Promise<TranslationStatus>} */
export async function translationStatus(source, target, method = 'GET') {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(`/api/translate/runtime?source=${source}&target=${target}`, { method, cache: 'no-store' });
  } catch {
    throw new Error('Could not reach the Docuflex server.');
  }
  const status = await response.json().catch(() => null);
  if (!response.ok || !status || 'error' in status) throw new Error(status?.error ?? `Could not check the translation model (HTTP ${response.status}).`);
  return status;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Shows the app's error toast (rendered by DocuflexApp). @param {string} title @param {unknown} error */
export function showAppError(title, error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong.';
  window.dispatchEvent(new CustomEvent('docuflex:error', { detail: { title, message } }));
}
