import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import maxmind from 'maxmind';
import * as env from '$app/env/private';

/*
 * Cookie-free web analytics for the landing page, the web editor and release
 * downloads. The desktop app never calls these functions.
 *
 * Privacy measures:
 * - The IP address is never written to disk. It is used in memory only, to
 *   look up country and region in a local GeoIP database (no external
 *   service) and to compute the daily visitor hash.
 * - Visitors are counted with a daily salted hash, so the same visitor is
 *   counted once per day without storing an identifier that persists.
 * - No cookies, localStorage or fingerprinting are used on the client.
 */

const ENABLED = env.ANALYTICS_ENABLED !== 'false';
const DATA_DIR = env.ANALYTICS_DATA_DIR || join(process.cwd(), 'data', 'analytics');
const SECRET_FILE = join(DATA_DIR, '.visitor-secret');
// IP-to-city database in MaxMind DB format, e.g. DB-IP "IP to City Lite"
// (CC BY 4.0). Only country and region are read from it; city is ignored.
const GEOIP_DB_PATH = env.GEOIP_DB_PATH || join(process.cwd(), 'data', 'geoip', 'dbip-city-lite.mmdb');

const BOT_PATTERN = /bot|crawl|spider|slurp|headless|preview|facebookexternalhit|curl|wget|python|go-http|monitor|uptime|lighthouse/i;

/** @type {Set<string>} */
const knownDirectories = new Set();
/** @type {Promise<import('maxmind').Reader<any> | null> | undefined} */
let geoReader;
/** @type {Promise<string> | undefined} */
let secret;

export const ANALYTICS_ENABLED = ENABLED;

/** @param {string | null | undefined} userAgent */
export function isBot(userAgent) {
  return !userAgent || BOT_PATTERN.test(userAgent);
}

/**
 * The hashing secret comes from ANALYTICS_SECRET, or is generated once and kept
 * next to the data so visitor counts survive restarts.
 */
function visitorSecret() {
  secret ??= (async () => {
    if (env.ANALYTICS_SECRET) return env.ANALYTICS_SECRET;
    try {
      return (await readFile(SECRET_FILE, 'utf8')).trim();
    } catch {
      const created = randomBytes(32).toString('hex');
      try {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(SECRET_FILE, created, { mode: 0o600, flag: 'wx' });
        return created;
      } catch {
        // Another request created it first, or the directory is read-only.
        return (await readFile(SECRET_FILE, 'utf8').catch(() => created)).trim();
      }
    }
  })();
  return secret;
}

/** @param {string} address @param {string} userAgent @param {string} day */
async function dailyVisitorHash(address, userAgent, day) {
  return createHash('sha256').update(`${await visitorSecret()}|${day}|${address}|${userAgent}`).digest('hex').slice(0, 24);
}

function openGeoReader() {
  geoReader ??= maxmind.open(GEOIP_DB_PATH, { watchForUpdates: true }).catch((error) => {
    console.warn(`GeoIP database unavailable at ${GEOIP_DB_PATH}; locations are recorded as unknown.`, error.code ?? error.message);
    return null;
  });
  return geoReader;
}

/**
 * Resolves country and region for an address without storing the address.
 * @param {string} address
 */
export async function locate(address) {
  const unknown = { country: 'unknown', region: 'unknown' };
  if (!maxmind.validate(address)) return unknown;
  const reader = await openGeoReader();
  const result = reader?.get(address);
  if (!result) return unknown;
  return {
    country: result.country?.iso_code ?? 'unknown',
    region: (result.subdivisions?.[0]?.names?.en ?? 'unknown').slice(0, 80)
  };
}

/** @param {string | null} referer */
function refererHost(referer) {
  if (!referer) return 'direct';
  try {
    return new URL(referer).host.slice(0, 120) || 'direct';
  } catch {
    return 'direct';
  }
}

/**
 * Builds the stored record from the request. Only the fields below are kept.
 * @param {{ request: Request; address: string; type: string; page?: string; name?: string; tool?: string; ms?: number; scroll?: number; pageView?: string; language?: string; referrer?: string }} input
 */
export async function buildRecord({ request, address, type, page, name, tool, ms, scroll, pageView, language, referrer }) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const userAgent = request.headers.get('user-agent') ?? '';
  /** @type {Record<string, any>} */
  const record = {
    ts: now.toISOString(),
    type,
    page: (page ?? '/').slice(0, 120),
    visitor: await dailyVisitorHash(address, userAgent, day),
    ...(await locate(address)),
    referrer: referrer ?? refererHost(request.headers.get('referer')),
    language: (language ?? request.headers.get('accept-language')?.split(',')[0] ?? 'unknown').slice(0, 16),
    ...describeUserAgent(userAgent),
    pageView: (pageView ?? '').slice(0, 40)
  };
  if (name !== undefined) record.name = name;
  if (tool !== undefined) record.tool = tool;
  if (ms !== undefined) record.ms = ms;
  if (scroll !== undefined) record.scroll = scroll;
  return record;
}

/** @param {string} userAgent */
export function describeUserAgent(userAgent) {
  const ua = userAgent;
  let device = 'desktop';
  if (/ipad|tablet/i.test(ua)) device = 'tablet';
  else if (/mobi|iphone|android.*mobile/i.test(ua)) device = 'mobile';

  let os = 'other';
  if (/windows/i.test(ua)) os = 'windows';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'ios';
  else if (/android/i.test(ua)) os = 'android';
  else if (/cros/i.test(ua)) os = 'chromeos';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macos';
  else if (/linux/i.test(ua)) os = 'linux';

  let browser = 'other';
  if (/edg\//i.test(ua)) browser = 'edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'opera';
  else if (/samsungbrowser/i.test(ua)) browser = 'samsung';
  else if (/firefox|fxios/i.test(ua)) browser = 'firefox';
  else if (/chrome|crios/i.test(ua)) browser = 'chrome';
  else if (/safari/i.test(ua)) browser = 'safari';

  return { device, os, browser };
}

/** @param {Record<string, any>} record */
export async function writeRecord(record) {
  if (!ENABLED) return;
  if (!knownDirectories.has(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
    knownDirectories.add(DATA_DIR);
  }
  const file = join(DATA_DIR, `events-${record.ts.slice(0, 10)}.jsonl`);
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
