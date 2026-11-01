import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { purgeAnalytics } from '../src/lib/server/retention.js';
test('analytics cleanup preserves the retention boundary, secrets and unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docuflex-retention-'));
  try {
    const names = ['events-2026-08-02.jsonl', 'events-2026-08-03.jsonl', 'events-2026-11-01.jsonl', '.visitor-secret', 'feedback-2026-01-01.jsonl', 'events-invalid.jsonl'];
    for (const name of names) await writeFile(join(directory, name), 'test');
    await purgeAnalytics(directory, new Date('2026-11-01T12:00:00Z'));
    assert.deepEqual((await readdir(directory)).sort(), names.filter(name => name !== names[0]).sort());
    await purgeAnalytics(join(directory, 'absent'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
