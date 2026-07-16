import { env } from '$env/dynamic/private';

const MAX_REQUEST_BYTES = 150 * 1024 * 1024;

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, fetch }) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'The page operation request is too large.' }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'The page operation request is too large.' }, { status: 413 });
  }

  const backendUrl = env.PDF_BACKEND_URL ?? 'http://127.0.0.1:8080';
  try {
    const response = await fetch(`${backendUrl}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/pdf',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    console.error('PDF page operation failed:', error);
    return Response.json({ error: 'The PDF page service is unavailable.' }, { status: 503 });
  }
}
