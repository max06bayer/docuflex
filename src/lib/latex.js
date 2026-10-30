import { visitorKey } from '#lib/ai-web.js';

/**
 * The window side of the LaTeX pipeline (PDF Enhance and AI Translate): read
 * the pages, send them to /api/latex and follow its progress.
 */

// Shared with the AI chat, so every AI tool uses the model picked last.
export const MODEL_STORAGE_KEY = 'docuflex-ai-model';
const RENDER_SCALE = 1.5;

/** @typedef {{ engine: boolean; local: boolean; keyReady: boolean | null; qwenReady?: boolean; styles: { id: string; label: string }[]; matchStyle: { id: string; label: string }; maxPageImages: number; model: string; models: { id: string; name: string; short?: string; free?: boolean; local?: boolean; downloadable?: boolean; ready?: boolean }[] }} LatexStatus */
/** @typedef {{ stage: string; attempt?: number; round?: number; characters?: number; page?: number; pages?: number }} LatexProgress */

/** @returns {Promise<LatexStatus>} */
export async function latexStatus() {
  const response = await fetch('/api/latex');
  if (!response.ok) throw new Error('Could not reach Docuflex.');
  return response.json();
}

/** @param {LatexStatus | null} status */
export function latexKeyReady(status, model = '') {
  return status ? (status.local ? Boolean(model === 'ollama/qwen3.5:4b-q4_K_M' ? status.qwenReady : status.keyReady || (!model && status.qwenReady)) : Boolean(visitorKey())) : false;
}

/** The remembered model if it is still offered, otherwise the default. @param {LatexStatus} status */
export function storedLatexModel(status) {
  let saved = null;
  try {
    saved = localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {}
  return status.models.some((model) => model.id === saved) ? /** @type {string} */ (saved) : status.model;
}

/** @param {string} id */
export function rememberLatexModel(id) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, id);
  } catch {}
}

/** The short label on the progress bar. @param {LatexProgress | null} value */
export function describeLatexStage(value) {
  if (!value) return '';
  const round = value.round ? ` ${value.round}` : '';
  if (value.stage === 'resetting') return 'Retrying with fresh context…';
  if (value.stage === 'reading') return `Reading page ${value.page ?? 1} of ${value.pages ?? 1}…`;
  if (value.stage === 'sending') return 'Uploading pages…';
  if (value.stage === 'writing') return value.characters ? `Writing LaTeX · ${formatCount(value.characters)}` : 'AI is studying the pages…';
  if (value.stage === 'compiling') return value.round ? `Typesetting revision${round}…` : 'Typesetting…';
  if (value.stage === 'packages') return 'Fetching LaTeX packages…';
  if (value.stage === 'error') return 'Compile error, fixing…';
  if (value.stage === 'fixing') return value.characters ? `Fixing errors · ${formatCount(value.characters)}` : 'Fixing compile errors…';
  if (value.stage === 'reviewing') return `Comparing with original${round}…`;
  if (value.stage === 'refining') return value.characters ? `Refining layout · ${formatCount(value.characters)}` : `AI is comparing pages${round}…`;
  return 'Working…';
}

/** A sentence on what is happening right now, for the panel's info area. @param {LatexProgress | null} value */
export function explainLatexStage(value) {
  if (!value) return '';
  if (value.stage === 'resetting') return 'The local model reached its response limit. Discarding the unfinished draft and retrying with compact formatting.';
  if (value.stage === 'reading') return 'Rendering each page and reading its text and fonts, so the AI sees exactly what you see.';
  if (value.stage === 'sending') return 'Sending the page images and text to the AI model.';
  if (value.stage === 'writing') return value.characters ? 'The AI is writing the full LaTeX source: text, formulas, tables and vector figures.' : 'The AI reads every page before it starts writing. Large documents take a while.';
  if (value.stage === 'compiling' || value.stage === 'packages') return 'Compiling the LaTeX into a PDF on this computer.';
  if (value.stage === 'error' || value.stage === 'fixing') return 'The AI can replace just the broken sections of the TeX source, then recompile the document.';
  if (value.stage === 'reviewing') return 'Rendering the result so the AI can lay it next to the original page by page.';
  if (value.stage === 'refining') return 'The AI compares its pages with the original and fixes overlaps, fonts, sizes and spacing.';
  return '';
}

/** @param {number} characters */
function formatCount(characters) {
  return characters >= 1000 ? `${(characters / 1000).toFixed(1)}k chars` : `${characters} chars`;
}

/** @param {number} seconds */
export function formatElapsed(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Every page's text layer plus a JPEG render, which the model reads and LaTeX can crop figures from.
 * @param {File} file @param {number} imageLimit @param {AbortSignal} signal @param {(progress: LatexProgress) => void} onProgress
 */
async function readPages(file, imageLimit, signal, onProgress) {
  /** Embedded font names (e.g. ABCDEF+CMR10, Helvetica-Bold), which let the AI pick look-alike fonts. */
  const fonts = new Set();
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  try {
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      onProgress({ stage: 'reading', page: number, pages: document.numPages });
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      /** @type {{ text: string; image?: string; width?: number; height?: number }} */
      const entry = { text: text.replace(/[ \t]+\n/g, '\n').trim() };
      if (number <= imageLimit) {
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        entry.image = canvas.toDataURL('image/jpeg', 0.82);
        entry.width = canvas.width;
        entry.height = canvas.height;
        canvas.width = 0;
        canvas.height = 0;
        // Fonts are loaded once the page has rendered.
        for (const id of Object.keys(content.styles)) {
          try {
            const font = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
            const fontName = typeof font?.name === 'string' ? font.name : '';
            if (fontName) fonts.add(fontName.replace(/^[A-Z]{6}\+/, ''));
          } catch {}
        }
      }
      pages.push(entry);
      page.cleanup();
    }
    return { pages, fonts: [...fonts].slice(0, 40) };
  } finally {
    await task.destroy();
  }
}

/** A conversion that never compiled; its source is kept so it is not lost. */
export class LatexError extends Error {
  /** @param {string} message @param {string} tex */
  constructor(message, tex) {
    super(message);
    this.tex = tex;
  }
}

/**
 * Runs one conversion and returns the compiled PDF and its source.
 * @param {{ file: File; status: LatexStatus; model: string; style?: string; instructions?: string; translateTo?: string; outputName: string; signal: AbortSignal; onProgress: (progress: LatexProgress) => void }} options
 */
export async function runLatex({ file, status, model, style = 'auto', instructions = '', translateTo = '', outputName, signal, onProgress }) {
  const { pages, fonts } = await readPages(file, status.maxPageImages ?? 24, signal, onProgress);
  onProgress({ stage: 'sending' });
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  const key = status.local ? null : visitorKey();
  if (key) headers['x-openrouter-key'] = key;
  const response = await fetch('/api/latex', {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ pages, fonts, model, style, instructions, translateTo, name: file.name })
  });
  if (!response.ok || !response.body) {
    const details = await response.json().catch(() => null);
    throw new Error(details?.error ?? `Conversion failed (${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {any} */
  let final = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.done || event.error) final = event;
      else onProgress(event);
    }
  }
  if (!final) throw new Error('The conversion stopped unexpectedly.');
  if (final.error) throw new LatexError(final.error, final.tex ?? '');
  const bytes = Uint8Array.from(atob(final.pdfBase64), (character) => character.charCodeAt(0));
  return {
    file: new File([bytes], outputName, { type: 'application/pdf', lastModified: Date.now() }),
    tex: /** @type {string} */ (final.tex),
    attempts: /** @type {number} */ (final.attempts)
  };
}

/** Hands a file to the save panel (the desktop shell routes final exports through it). @param {Blob} blob @param {string} name */
export function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.dataset.docuflexFinalExport = 'true';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
