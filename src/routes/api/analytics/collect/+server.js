import { ANALYTICS_ENABLED, buildRecord, isBot, writeRecord } from '#lib/server/analytics.js';

const MAX_BODY_BYTES = 2048;
const EVENT_NAMES = new Set(['tool_open', 'export', 'file_open']);
const TYPES = new Set(['pageview', 'engagement', 'event']);
const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, getClientAddress }) {
  if (!ANALYTICS_ENABLED || isBot(request.headers.get('user-agent'))) {
    return new Response(null, { status: 204 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || !TYPES.has(payload.type)) {
    return new Response(null, { status: 400 });
  }
  if (payload.type === 'event' && !EVENT_NAMES.has(payload.name)) {
    return new Response(null, { status: 400 });
  }

  const page = typeof payload.page === 'string' && payload.page.startsWith('/')
    ? payload.page.split('?')[0].split('#')[0]
    : '/';
  const ms = Number.isFinite(payload.ms) ? Math.min(Math.max(Math.round(payload.ms), 0), 86_400_000) : undefined;
  const scroll = Number.isFinite(payload.scroll) ? Math.min(Math.max(Math.round(payload.scroll), 0), 100) : undefined;

  await writeRecord(
    await buildRecord({
      request,
      address: getClientAddress(),
      type: payload.type,
      page,
      name: payload.type === 'event' ? payload.name : undefined,
      tool: typeof payload.tool === 'string' ? payload.tool.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) : undefined,
      ms,
      scroll,
      pageView: typeof payload.pv === 'string' ? payload.pv.slice(0, 40) : undefined,
      language: typeof payload.lang === 'string' ? payload.lang : undefined,
      // The page's own document.referrer (host only); the request's Referer
      // header would just name the Docuflex page that sent this beacon.
      referrer: typeof payload.ref === 'string' && HOST_PATTERN.test(payload.ref) ? payload.ref.slice(0, 120).toLowerCase() : 'direct'
    })
  );
  return new Response(null, { status: 204 });
}
