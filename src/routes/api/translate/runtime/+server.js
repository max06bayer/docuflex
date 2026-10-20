import { TRANSLATION_LANGUAGE_CODES, startDownload, translationStatus } from '$lib/server/translate-runtime.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** @param {URLSearchParams | FormData} values */
function languagePair(values) {
  const source = String(values.get('source') ?? '').toLowerCase();
  const target = String(values.get('target') ?? '').toLowerCase();
  return TRANSLATION_LANGUAGE_CODES.has(source) && TRANSLATION_LANGUAGE_CODES.has(target) && source !== target ? { source, target } : null;
}

/** Whether the engine and this pair's model are installed, and any download progress. */
/** @type {import('./$types').RequestHandler} */
export async function GET({ url }) {
  const pair = languagePair(url.searchParams);
  if (!pair) return Response.json({ error: 'Choose two different supported languages.' }, { status: 400, headers: NO_STORE });
  return Response.json(await translationStatus(pair.source, pair.target), { headers: NO_STORE });
}

/** Starts downloading the engine and/or model for a pair; poll GET for progress. */
/** @type {import('./$types').RequestHandler} */
export async function POST({ url }) {
  const pair = languagePair(url.searchParams);
  if (!pair) return Response.json({ error: 'Choose two different supported languages.' }, { status: 400, headers: NO_STORE });
  const status = await translationStatus(pair.source, pair.target);
  if (!status.canDownload) return Response.json({ error: 'The translation engine is not installed on this server.' }, { status: 503, headers: NO_STORE });
  if (!status.modelReady) startDownload(pair.source, pair.target);
  return Response.json(await translationStatus(pair.source, pair.target), { status: 202, headers: NO_STORE });
}
