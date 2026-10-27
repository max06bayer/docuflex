import { isLocalRequest, mcpAvailable, mcpStatus, setMcpEnabled } from '#lib/server/mcp-bridge.js';
import { MCP_TOOLS } from '#lib/server/mcp-tools.js';

/** @param {URL} url */
function describe(url) {
  return { ...mcpStatus(), url: `${url.origin}/mcp`, toolCount: MCP_TOOLS.length };
}

/** @type {import('./$types').RequestHandler} */
export function GET({ request, url }) {
  if (!mcpAvailable() || !isLocalRequest(request, url)) return Response.json({ available: false });
  return Response.json(describe(url));
}

/** Turns the MCP server on or off from the MCP window. */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  if (!mcpAvailable() || !isLocalRequest(request, url)) return Response.json({ available: false }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') return Response.json({ error: 'Send { enabled: boolean }.' }, { status: 400 });
  setMcpEnabled(body.enabled);
  return Response.json(describe(url));
}
