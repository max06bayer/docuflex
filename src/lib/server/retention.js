import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Deletes only dated analytics event files older than the retention window.
 * @param {string} directory @param {Date} [now]
 */
export async function purgeAnalytics(directory, now = new Date()) {
  const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  for (const file of await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
    const match = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
    if (match && match[1] < cutoff) await unlink(join(directory, file));
  }
}
