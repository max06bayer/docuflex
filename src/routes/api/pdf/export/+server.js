import { env } from '$env/dynamic/private';
import { MAX_PDF_JSON_REQUEST_BYTES, contentLengthExceeds } from '$lib/server/request-security.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, fetch }) {
  if (contentLengthExceeds(request, MAX_PDF_JSON_REQUEST_BYTES)) {
    return Response.json({ error: 'The PDF export request is too large.' }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PDF_JSON_REQUEST_BYTES) {
    return Response.json({ error: 'The PDF export request is too large.' }, { status: 413 });
  }

  const backendUrl = env.PDF_BACKEND_URL ?? 'http://127.0.0.1:8080';
  try {
    const backendResponse = await fetch(`${backendUrl}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5 * 60_000)
    });
    const headers = new Headers();
    headers.set('Content-Type', backendResponse.headers.get('content-type') ?? 'application/pdf');
    headers.set('Cache-Control', 'no-store');
    const disposition = backendResponse.headers.get('content-disposition');
    if (disposition) headers.set('Content-Disposition', disposition);
    return new Response(backendResponse.body, { status: backendResponse.status, headers });
  } catch (error) {
    console.error('PDF backend export failed:', error);
    return Response.json(
      { error: 'The PDF export service is unavailable.' },
      { status: 503 }
    );
  }
}
