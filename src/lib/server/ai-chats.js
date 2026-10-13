import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Saved AI chats, one JSON file each in ~/.docuflex/ai-chats, so they survive
 * closing the panel and restarting the app. Page images are dropped before
 * saving; the window does that, and this module only stores and lists.
 */

const CHAT_DIRECTORY = join(homedir(), '.docuflex', 'ai-chats');
const MAX_CHAT_BYTES = 8 * 1024 * 1024;
const MAX_CHATS = 200;
const ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

/** @param {string} id */
function chatPath(id) {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid chat id.');
  return join(CHAT_DIRECTORY, `${id}.json`);
}

/** Newest first, without the messages. */
export async function listChats() {
  const files = await readdir(CHAT_DIRECTORY).catch(() => []);
  const chats = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const chat = JSON.parse(await readFile(join(CHAT_DIRECTORY, file), 'utf8'));
      chats.push({ id: chat.id, title: chat.title, document: chat.document ?? null, updatedAt: chat.updatedAt, createdAt: chat.createdAt });
    } catch {
      // Skip unreadable files.
    }
  }
  return chats.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

/** @param {string} id */
export async function readChat(id) {
  return JSON.parse(await readFile(chatPath(id), 'utf8'));
}

/** @param {any} chat */
export async function saveChat(chat) {
  const path = chatPath(String(chat?.id ?? ''));
  const body = JSON.stringify({
    id: chat.id,
    title: String(chat.title ?? 'Chat').slice(0, 120),
    document: typeof chat.document === 'string' ? chat.document : null,
    createdAt: chat.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: Array.isArray(chat.entries) ? chat.entries : [],
    history: Array.isArray(chat.history) ? chat.history : [],
    uncompactedFrom: Number.isInteger(chat.uncompactedFrom) ? chat.uncompactedFrom : null
  });
  if (body.length > MAX_CHAT_BYTES) throw new Error('This chat is too large to save.');
  await mkdir(CHAT_DIRECTORY, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
  // Keep the newest chats only.
  const chats = await listChats();
  for (const old of chats.slice(MAX_CHATS)) await rm(chatPath(old.id), { force: true }).catch(() => {});
}

/** @param {string} id */
export async function deleteChat(id) {
  await rm(chatPath(id), { force: true });
}
