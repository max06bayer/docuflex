import { validateFeedback, FEEDBACK_MAX_BYTES } from '#lib/server/feedback.js';

/** Desktop requests are relayed to the central receiver; local storage is never reported as sent. */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Send JSON.' }, { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: 'Enter your feedback.' }, { status: 400 });
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > FEEDBACK_MAX_BYTES) { await reader.cancel(); return Response.json({ error: 'Your feedback is too long.' }, { status: 413 }); }
    chunks.push(value);
  }
  let feedback;
  try { feedback = validateFeedback(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { return Response.json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : error instanceof Error ? error.message : 'Check your feedback.' }, { status: 400 }); }
  try {
    const response = await fetch('https://docuflex.eu/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feedback),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]), redirect: 'error'
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.id) return Response.json({ error: result?.error || 'Could not send your feedback. Please try again.' }, { status: response.status === 429 ? 429 : 502 });
    return Response.json({ id: result.id }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Could not reach the Docuflex server. Your message is still here; please try again when online.' }, { status: 502 });
  }
}
