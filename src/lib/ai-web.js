/**
 * Website AI chat: each visitor's own OpenRouter key and notes, kept only in
 * their browser. The desktop app keeps using the key saved on the computer.
 */
export const AI_KEY_STORAGE = 'docuflex-openrouter-key';
const MEMORY_STORAGE = 'docuflex-ai-memory';
const CHATS_STORAGE = 'docuflex-ai-chats';

/** @returns {string | null} */
export function visitorKey() {
  try {
    return localStorage.getItem(AI_KEY_STORAGE)?.trim() || null;
  } catch {
    return null;
  }
}

/** Checks the key with OpenRouter, then keeps it in this browser. @param {string} key */
export async function saveVisitorKey(key) {
  const trimmed = key.trim();
  if (!/^\S{20,300}$/.test(trimmed)) throw new Error("That doesn't look like an OpenRouter API key.");
  let response = null;
  try {
    response = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${trimmed}` }, signal: AbortSignal.timeout(8000) });
  } catch {
    // Offline or blocked: keep the key; the chat reports a bad key when it is used.
  }
  if (response && (response.status === 401 || response.status === 403)) throw new Error('OpenRouter rejected this key.');
  localStorage.setItem(AI_KEY_STORAGE, trimmed);
}

export function removeVisitorKey() {
  try {
    localStorage.removeItem(AI_KEY_STORAGE);
  } catch {}
}

/** @param {string} storageKey @param {any} fallback */
function readJson(storageKey, fallback) {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} storageKey @param {any} value */
function writeJson(storageKey, value) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the chat keeps working without saving.
  }
}

/** @param {any} context */
const memoryKey = (context) => (typeof context?.active?.name === 'string' ? context.active.name : '');

/** Notes about the active document, sent with each chat request. @param {any} context */
export function visitorMemories(context) {
  return readJson(MEMORY_STORAGE, {})[memoryKey(context)] ?? [];
}

/** remember / forget, the same results the desktop server returns. @param {string} name @param {Record<string, any>} args @param {any} context */
export function runVisitorMemoryTool(name, args, context) {
  const key = memoryKey(context);
  const label = key || 'chats without a document';
  const data = readJson(MEMORY_STORAGE, {});
  /** @type {{ text: string; at: string }[]} */
  const notes = data[key] ?? [];
  if (name === 'remember') {
    const note = String(args.note ?? '').trim().slice(0, 500);
    if (!note) throw new Error('note is empty.');
    if (notes.some((entry) => entry.text === note)) return { saved: false, note: 'This note is already saved.', notes: notes.length };
    data[key] = [...notes, { text: note, at: new Date().toISOString() }].slice(-30);
    writeJson(MEMORY_STORAGE, data);
    return { saved: true, document: label, notes: data[key].length };
  }
  if (args.all) {
    delete data[key];
    writeJson(MEMORY_STORAGE, data);
    return { forgotten: notes.length, document: label };
  }
  const index = Number(args.number) - 1;
  if (!(index >= 0 && index < notes.length)) throw new Error(`There is no note ${args.number}. This document has ${notes.length} notes.`);
  data[key] = notes.filter((_, position) => position !== index);
  writeJson(MEMORY_STORAGE, data);
  return { forgotten: 1, document: label, notes: data[key].length };
}

/** Saved chats in this browser (newest first, at most 30). */
export function listVisitorChats() {
  /** @type {any[]} */
  const chats = readJson(CHATS_STORAGE, []);
  return chats.map(({ id, title, createdAt, updatedAt, document }) => ({ id, title, createdAt, updatedAt, document }));
}

/** @param {string} id */
export function readVisitorChat(id) {
  const chat = readJson(CHATS_STORAGE, []).find((/** @type {any} */ entry) => entry.id === id);
  if (!chat) throw new Error('Chat not found.');
  return chat;
}

/** @param {any} chat */
export function saveVisitorChat(chat) {
  /** @type {any[]} */
  const chats = readJson(CHATS_STORAGE, []).filter((/** @type {any} */ entry) => entry.id !== chat.id);
  writeJson(CHATS_STORAGE, [{ ...chat, updatedAt: new Date().toISOString() }, ...chats].slice(0, 30));
}

/** @param {string} id */
export function deleteVisitorChat(id) {
  writeJson(CHATS_STORAGE, readJson(CHATS_STORAGE, []).filter((/** @type {any} */ entry) => entry.id !== id));
}

/** Lets the visitor pick a PDF; must run inside a click (the approval button). @returns {Promise<File | null>} */
export function pickPdf() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** @param {File | Blob} file */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** @param {string} base64 @param {string} name */
export function downloadPdf(base64, name) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
