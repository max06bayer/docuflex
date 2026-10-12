#!/usr/bin/env node
// Keeps the local GeoIP database (DB-IP "IP to City Lite", CC BY 4.0) current.
// Only the monthly database file is downloaded; visitor IPs are never sent anywhere.
// Usage: node scripts/update-geoip.mjs [--force]

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

const MAX_AGE_MS = 30 * 86_400_000;

export const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || join(process.cwd(), 'data', 'geoip', 'dbip-city-lite.mmdb');

/** @param {Date} date */
function monthTag(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** @param {{ force?: boolean }} [options] */
export async function updateGeoip({ force = false } = {}) {
  const current = await stat(GEOIP_DB_PATH).catch(() => null);
  if (!force && current && Date.now() - current.mtimeMs < MAX_AGE_MS) return false;

  await mkdir(dirname(GEOIP_DB_PATH), { recursive: true });
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  for (const tag of [monthTag(now), monthTag(previous)]) {
    const response = await fetch(`https://download.db-ip.com/free/dbip-city-lite-${tag}.mmdb.gz`);
    if (!response.ok || !response.body) continue;
    const temporary = `${GEOIP_DB_PATH}.download`;
    try {
      await pipeline(Readable.fromWeb(/** @type {any} */ (response.body)), createGunzip(), createWriteStream(temporary, { mode: 0o600 }));
      await rename(temporary, GEOIP_DB_PATH);
      console.log(`GeoIP database updated (DB-IP City Lite ${tag}).`);
      return true;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  throw new Error('No DB-IP City Lite database was available for this or the previous month.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  updateGeoip({ force: process.argv.includes('--force') }).catch((error) => {
    console.error('GeoIP update failed:', error);
    process.exitCode = 1;
  });
}
