import { aiAvailable, streamCompletion, visitorKey, visitorMemories } from '#lib/server/ai.js';
import { isLocalRequest, mcpAvailable } from '#lib/server/mcp-bridge.js';

/**
 * One model turn of the AI chat. The window runs the agent loop: it sends the
 * conversation, gets the streamed answer (OpenAI-style server-sent events
 * straight from OpenRouter), runs any tool calls and asks again.
 */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  // The desktop app and local development use the key saved on this computer.
  // Website visitors send their own key with each request; it is used for this call only.
  const local = isLocalRequest(request, url) && mcpAvailable();
  /** @type {{ key: string; memories: { text: string; at: string }[] } | null} */
  let web = null;
  if (local) {
    if (!(await aiAvailable())) return new Response('Not found', { status: 404 });
  }
  const body = await request.json().catch(() => null);
  if (!local) {
    const key = visitorKey(request.headers.get('x-openrouter-key'));
    if (!key) return Response.json({ error: 'Add your OpenRouter API key in Settings.' }, { status: 401 });
    web = { key, memories: visitorMemories(body?.memories) };
  }
  if (!Array.isArray(body?.messages)) return Response.json({ error: 'Send { messages: [...] }.' }, { status: 400 });

  /** @type {Response} */
  let upstream;
  try {
    const subagent = body.subagent && Number.isInteger(body.subagent.page) ? { page: body.subagent.page, region: body.subagent.region ?? null } : null;
    upstream = await streamCompletion(body.messages, body.context, request.signal, subagent, typeof body.model === 'string' ? body.model : undefined, web);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not reach the AI service.' }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const details = await upstream.json().catch(() => null);
    const message = details?.error?.message || `The AI service answered with HTTP ${upstream.status}.`;
    return Response.json({ error: message }, { status: upstream.status === 401 ? 401 : 502 });
  }
  return new Response(upstream.body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }
  });
}
