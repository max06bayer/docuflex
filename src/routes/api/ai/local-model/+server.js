import { isLocalRequest, mcpAvailable } from '#lib/server/mcp-bridge.js';
import { qwenStatus, qwenSupported, startQwenDownload, cancelQwenDownload } from '#lib/server/ollama.js';
/** @param {Request} request @param {URL} url */
const allowed = (request, url) => isLocalRequest(request, url) && mcpAvailable();
/** @type {import('./$types').RequestHandler} */
export async function GET({ request, url }) {
  if (!allowed(request, url)) return new Response('Not found', { status: 404 });
  return Response.json(await qwenStatus(), { headers: { 'Cache-Control': 'no-store' } });
}
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  if (!allowed(request, url)) return new Response('Not found', { status: 404 });
  if (!(await qwenSupported())) return Response.json({ error: 'Qwen is unavailable in this build.' }, { status: 503 });
  startQwenDownload();
  return Response.json(await qwenStatus());
}
/** @type {import('./$types').RequestHandler} */
export async function DELETE({ request, url }) {
  if (!allowed(request, url)) return new Response('Not found', { status: 404 });
  cancelQwenDownload();
  return Response.json({ paused: true });
}
