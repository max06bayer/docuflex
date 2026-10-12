import { acknowledgeAppCall, isLocalRequest, markClientAlive, mcpAvailable, openAppStream, resolveAppCall } from '$lib/server/mcp-bridge.js';

/** The Docuflex window subscribes here to receive MCP tool calls. */
/** @type {import('./$types').RequestHandler} */
export function GET({ request, url }) {
  if (!mcpAvailable() || !isLocalRequest(request, url)) return new Response('Not found', { status: 404 });
  return new Response(openAppStream(), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    }
  });
}

/**
 * Messages from the window: { type: 'alive' } heartbeats, { type: 'ack' }
 * when a call arrives, and the call's result (type 'result' or omitted).
 */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  if (!mcpAvailable() || !isLocalRequest(request, url)) return new Response('Not found', { status: 404 });
  const message = await request.json().catch(() => null);
  if (!message || typeof message !== 'object') return Response.json({ error: 'Invalid message.' }, { status: 400 });
  if (message.type === 'alive') return Response.json({ known: markClientAlive(message.clientId) });
  if (typeof message.id !== 'string') return Response.json({ error: 'Invalid message.' }, { status: 400 });
  if (message.type === 'ack') return Response.json({ pending: acknowledgeAppCall(message.id, message.clientId) });
  return Response.json({ delivered: resolveAppCall(message) });
}
