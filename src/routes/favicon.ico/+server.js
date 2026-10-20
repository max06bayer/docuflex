import icon from '$lib/assets/favicon.ico?inline';

// Served from a route because the static file server has no MIME type for
// .ico, and with nosniff an untyped icon may be ignored by crawlers.
const bytes = Buffer.from(icon.slice(icon.indexOf(',') + 1), 'base64');

/** @type {import('./$types').RequestHandler} */
export function GET() {
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/x-icon',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}
