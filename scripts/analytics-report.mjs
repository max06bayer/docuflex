#!/usr/bin/env node
// Prints a summary of the web analytics collected by src/lib/server/analytics.js.
// Usage: node scripts/analytics-report.mjs [--days 30] [--dir data/analytics]

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const days = Number(option('--days', '30'));
const dir = option('--dir', process.env.ANALYTICS_DATA_DIR || join(process.cwd(), 'data', 'analytics'));
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const records = [];
for (const file of (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.jsonl')).sort()) {
  const text = await readFile(join(dir, file), 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.ts >= since) records.push(record);
  }
}

if (!records.length) {
  console.log(`No analytics records in the last ${days} days (${dir}).`);
  process.exit(0);
}

const count = (items, key) => {
  const totals = new Map();
  for (const item of items) {
    const value = item[key] ?? 'unknown';
    totals.set(value, (totals.get(value) ?? 0) + 1);
  }
  return [...totals].sort((a, b) => b[1] - a[1]);
};
const share = (rows, total) => rows.map(([label, n]) => ({ label, visits: n, share: `${((n / total) * 100).toFixed(1)}%` }));
const top = (items, key, limit = 10) => share(count(items, key).slice(0, limit), items.length);

const pageviews = records.filter((r) => r.type === 'pageview');
const engagements = records.filter((r) => r.type === 'engagement');
const downloads = records.filter((r) => r.type === 'download');
const events = records.filter((r) => r.type === 'event');
const visitors = new Set(records.map((r) => `${r.ts.slice(0, 10)}|${r.visitor}`));
const averageSeconds = engagements.length
  ? engagements.reduce((sum, r) => sum + (r.ms ?? 0), 0) / engagements.length / 1000
  : 0;
const scrollSamples = engagements.filter((r) => typeof r.scroll === 'number');
const averageScroll = scrollSamples.length
  ? scrollSamples.reduce((sum, r) => sum + r.scroll, 0) / scrollSamples.length
  : 0;

console.log(`Docuflex web analytics — last ${days} days (${records.length} records)\n`);
console.log('Summary');
console.log(`  Page views:         ${pageviews.length}`);
console.log(`  Unique visitors:    ${visitors.size} (counted per day)`);
console.log(`  Avg. time on page:  ${averageSeconds.toFixed(1)} s`);
console.log(`  Avg. scroll depth:  ${averageScroll.toFixed(0)} %`);
console.log(`  Release downloads:  ${downloads.length}`);
console.log(`  Editor events:      ${events.length}\n`);

const table = (title, rows) => {
  console.log(title);
  if (!rows.length) console.log('  (none)');
  for (const row of rows) console.log(`  ${String(row.label).padEnd(28)} ${String(row.visits).padStart(7)}  ${row.share.padStart(7)}`);
  console.log('');
};

table('Top pages (page views)', top(pageviews, 'page'));
table('Referrers', top(pageviews, 'referrer'));
table('Countries', top(pageviews, 'country'));
table('Regions', top(pageviews.map((r) => ({ ...r, place: `${r.country} · ${r.region ?? 'unknown'}` })), 'place', 20));
table('Device types', top(pageviews, 'device'));
table('Operating systems', top(pageviews, 'os'));
table('Browsers', top(pageviews, 'browser'));
table('Languages', top(pageviews, 'language'));
table('Editor events', top(events, 'name'));
table('Tools opened in the editor', top(events.filter((r) => r.name === 'tool_open'), 'tool', 15));
table('Release downloads by OS', top(downloads, 'os'));

const hours = Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, '0')}:00 UTC`, n: 0 }));
for (const r of pageviews) hours[new Date(r.ts).getUTCHours()].n += 1;
table('Page views by hour (UTC)', hours.map((h) => ({ label: h.label, visits: h.n, share: `${((h.n / pageviews.length) * 100).toFixed(1)}%` })));
