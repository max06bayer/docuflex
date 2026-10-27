import { deleteOpenRouterKey, saveOpenRouterKey } from '#lib/server/ai.js';
import { isLocalRequest, mcpAvailable } from '#lib/server/mcp-bridge.js';

/** Saves or removes the OpenRouter key from Settings. Only this computer can reach it. */

/** @type {import('./$types').RequestHandler} */
export async function PUT({ request, url }) {
  if (!isLocalRequest(request, url) || !mcpAvailable()) return new Response(null, { status: 404 });
  const body = await request.json().catch(() => null);
  if (typeof body?.key !== 'string') return Response.json({ error: 'Paste an OpenRouter API key.' }, { status: 400 });
  try {
    await saveOpenRouterKey(body.key);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'The key could not be saved.' }, { status: 400 });
  }
  return Response.json({ ok: true });
}

/** @type {import('./$types').RequestHandler} */
export async function DELETE({ request, url }) {
  if (!isLocalRequest(request, url) || !mcpAvailable()) return new Response(null, { status: 404 });
  await deleteOpenRouterKey();
  return Response.json({ ok: true });
}
