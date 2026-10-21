import { env } from '$env/dynamic/private';

/**
 * The PDF's original font as installed where the backend runs (in the desktop
 * app, the user's computer). The editor uses it for characters the embedded
 * subset lacks, exactly like the export does; 404 when it is not installed.
 * @type {import('./$types').RequestHandler}
 */
export async function GET({ url, fetch }) {
  const name = url.searchParams.get('name') ?? '';
  if (!/^[A-Za-z0-9+_.,-]{1,128}$/.test(name)) {
    return Response.json({ error: 'Invalid font name.' }, { status: 400 });
  }

  const backendUrl = env.PDF_BACKEND_URL ?? 'http://127.0.0.1:8080';
  try {
    const response = await fetch(`${backendUrl}/installed-font?name=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) return new Response(null, { status: response.status });
    return new Response(response.body, {
      status: 200,
      headers: { 'Content-Type': 'font/ttf', 'Cache-Control': 'private, max-age=3600' }
    });
  } catch (error) {
    console.error('PDF backend installed font lookup failed:', error);
    return new Response(null, { status: 503 });
  }
}
