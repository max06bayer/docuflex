import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash, randomBytes } from 'node:crypto';

export const FEEDBACK_MAX_BYTES = 20_000;
const salt = randomBytes(32);
/** @type {Map<string, number>} */
const rates = new Map();
let rateHour = -1;
let total = 0;

/** Validates only the fields we deliberately send; no document, key or logs. @param {any} input */
export function validateFeedback(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter your feedback.');
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!message || message.length > 5000) throw new Error('Feedback must contain 1–5,000 characters.');
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Enter a valid email address, or leave it empty.');
  if (!['bug', 'idea', 'other'].includes(input.category)) throw new Error('Choose Bug, Idea or Other.');
  return { category: input.category, message, email, version: typeof input.version === 'string' ? input.version.slice(0, 40) : '', platform: input.platform === 'desktop' ? 'desktop' : 'web' };
}

/** Limits abuse in memory; addresses are never saved with feedback. @param {string} address */
export function feedbackAllowed(address) {
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== rateHour) { rates.clear(); rateHour = hour; total = 0; }
  const key = createHash('sha256').update(salt).update(address).digest('hex');
  const count = rates.get(key) ?? 0;
  if (count >= 10 || total >= 200) return false;
  rates.set(key, count + 1); total += 1;
  return true;
}

export const feedbackDirectory = () => process.env.DOCUFLEX_FEEDBACK_DIR || join(process.cwd(), 'data', 'feedback');
export async function purgeOldFeedback() {
  const directory = feedbackDirectory();
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  for (const file of await readdir(directory).catch(() => [])) {
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) await unlink(join(directory, file));
  }
}

/** @param {ReturnType<typeof validateFeedback>} feedback */
export async function saveFeedback(feedback) {
  const directory = feedbackDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = { id: randomUUID(), createdAt: new Date().toISOString(), ...feedback };
  await appendFile(join(directory, `${entry.createdAt.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry.id;
}
