import { env } from '$env/dynamic/private';

const KIB = 1024;
const MIB = 1024 * KIB;

export const MAX_DOCUMENT_BYTES = 150 * MIB;
export const MAX_PDF_JSON_REQUEST_BYTES = 225 * MIB;
export const MAX_TRANSLATION_BYTES = 30 * MIB;
export const MAX_GENERATED_BYTES = 300 * MIB;

const API_POLICIES = new Map([
  ['/api/compress', { group: 'native', concurrency: 2, requests: 18, windowMs: 10 * 60_000 }],
  ['/api/convert', { group: 'native', concurrency: 2, requests: 18, windowMs: 10 * 60_000 }],
  ['/api/flatten', { group: 'native', concurrency: 2, requests: 18, windowMs: 10 * 60_000 }],
  ['/api/pdf/convert', { group: 'native', concurrency: 2, requests: 18, windowMs: 10 * 60_000 }],
  ['/api/pdf/ocr', { group: 'ocr', concurrency: 1, requests: 10, windowMs: 10 * 60_000 }],
  ['/api/translate', { group: 'translate', concurrency: 1, requests: 8, windowMs: 30 * 60_000 }],
  ['/api/pdf/decrypt', { group: 'pdfbox', concurrency: 4, requests: 90, windowMs: 5 * 60_000 }],
  ['/api/pdf/edit', { group: 'pdfbox', concurrency: 4, requests: 90, windowMs: 5 * 60_000 }],
  ['/api/pdf/export', { group: 'pdfbox', concurrency: 4, requests: 90, windowMs: 5 * 60_000 }],
  ['/api/pdf/fonts', { group: 'pdfbox', concurrency: 4, requests: 90, windowMs: 5 * 60_000 }],
  ['/api/pdf/pages', { group: 'pdfbox', concurrency: 4, requests: 90, windowMs: 5 * 60_000 }],
  ['/api/pdf/uncrop', { group: 'pdfbox', concurrency: 4, requests: 90, windowMs: 5 * 60_000 }]
]);

/** @type {Map<string, number[]>} */
const requestWindows = new Map();
/** @type {Map<string, number>} */
const activeGroups = new Map();
let lastCleanup = 0;

/**
 * @param {string} pathname
 * @param {string} clientAddress
 */
export function enterProtectedRoute(pathname, clientAddress) {
  const policy = API_POLICIES.get(pathname);
  if (!policy) return { release: () => {} };

  const now = Date.now();
  cleanupWindows(now);
  const key = `${clientAddress || 'unknown'}:${pathname}`;
  const previous = requestWindows.get(key) ?? [];
  const recent = previous.filter((timestamp) => timestamp > now - policy.windowMs);
  if (recent.length >= configuredLimit(pathname, policy.requests)) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + policy.windowMs - now) / 1000));
    return { response: securityError(429, 'Too many document requests. Please wait and try again.', retryAfter) };
  }
  recent.push(now);
  requestWindows.set(key, recent);

  const maximumConcurrency = configuredConcurrency(policy.group, policy.concurrency);
  const active = activeGroups.get(policy.group) ?? 0;
  if (active >= maximumConcurrency) {
    return { response: securityError(429, 'The document service is busy. Please try again shortly.', 5) };
  }
  activeGroups.set(policy.group, active + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const current = activeGroups.get(policy.group) ?? 1;
      if (current <= 1) activeGroups.delete(policy.group);
      else activeGroups.set(policy.group, current - 1);
    }
  };
}

/** @param {Request} request */
export function rejectsCrossSiteMutation(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return true;
  const origin = request.headers.get('origin');
  return Boolean(origin && origin !== new URL(request.url).origin);
}

/** @param {Response} response @param {URL} url */
export function applySecurityHeaders(response, url) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; "
      + "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:"
  );
  if (url.protocol === 'https:' || env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (url.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
}

/** @param {unknown} error @param {string} context */
export function logPrivateError(error, context) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  console.error(`[${context}] ${id}`, error);
  return id;
}

/** @param {unknown} error @param {string} context @param {string} message @param {number} [status] */
export function privateFailure(error, context, message, status = 503) {
  const reference = logPrivateError(error, context);
  return Response.json({ error: message, reference }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** @param {Request} request */
export async function safeFormData(request) {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/** @param {number} status @param {string} message @param {number} [retryAfter] */
export function securityError(status, message, retryAfter) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (retryAfter) headers.set('Retry-After', String(retryAfter));
  return Response.json({ error: message }, { status, headers });
}

/** @param {Request} request @param {number} maximumBytes */
export function contentLengthExceeds(request, maximumBytes) {
  const raw = request.headers.get('content-length');
  if (!raw) return false;
  if (!/^\d+$/.test(raw)) return true;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length < 0 || length > maximumBytes;
}

/** @param {Uint8Array | ArrayBuffer | Buffer} bytes */
export function isPdf(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength < 5) return false;
  return view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46 && view[4] === 0x2d;
}

/** @param {Uint8Array | ArrayBuffer | Buffer} bytes */
export function isZip(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.byteLength >= 4 && view[0] === 0x50 && view[1] === 0x4b && [0x03, 0x05, 0x07].includes(view[2]) && [0x04, 0x06, 0x08].includes(view[3]);
}

/** @param {Uint8Array | ArrayBuffer | Buffer} bytes */
export function isOleCompound(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return view.byteLength >= signature.length && signature.every((value, index) => view[index] === value);
}

/** @param {number} now */
function cleanupWindows(now) {
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  const oldestRelevant = now - 30 * 60_000;
  for (const [key, timestamps] of requestWindows) {
    const recent = timestamps.filter((timestamp) => timestamp > oldestRelevant);
    if (recent.length) requestWindows.set(key, recent);
    else requestWindows.delete(key);
  }
}

/** @param {string} pathname @param {number} fallback */
function configuredLimit(pathname, fallback) {
  const key = `RATE_LIMIT_${pathname.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toUpperCase()}`;
  return positiveInteger(env[key], fallback);
}

/** @param {string} group @param {number} fallback */
function configuredConcurrency(group, fallback) {
  return positiveInteger(env[`DOCUMENT_CONCURRENCY_${group.toUpperCase()}`], fallback);
}

/** @param {string | undefined} value @param {number} fallback */
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
