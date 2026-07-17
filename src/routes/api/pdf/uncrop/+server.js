import { env } from '$env/dynamic/private';
import { MAX_PDF_JSON_REQUEST_BYTES, contentLengthExceeds } from '$lib/server/request-security.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, fetch }) {
  if (contentLengthExceeds(request, MAX_PDF_JSON_REQUEST_BYTES)) {
    return Response.json({ error: 'The PDF crop request is too large.' }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PDF_JSON_REQUEST_BYTES) {
    return Response.json({ error: 'The PDF crop request is too large.' }, { status: 413 });
  }

  const backendUrl = env.PDF_BACKEND_URL ?? 'http://127.0.0.1:8080';
  try {
    const response = await fetch(`${backendUrl}/uncrop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5 * 60_000)
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    console.error('PDF crop preparation failed:', error);
    return Response.json({ error: 'The PDF crop service is unavailable.' }, { status: 503 });
  }
}
