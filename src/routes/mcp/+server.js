import { isLocalRequest, mcpAvailable, mcpEnabled } from '#lib/server/mcp-bridge.js';
import { MCP_INSTRUCTIONS, MCP_TOOLS, runTool } from '#lib/server/mcp-tools.js';

/**
 * Docuflex MCP server (Streamable HTTP transport, JSON responses).
 * Local only: available in the desktop app and local development, and only
 * for requests from this machine.
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'docuflex', title: 'Docuflex PDF Editor', version: '1.0.0' };

/** @param {unknown} id @param {unknown} result */
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
/** @param {unknown} id @param {number} code @param {string} message */
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** @param {any} message */
async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return fail(message?.id, -32600, 'Invalid request.');
  }
  const { id, method, params } = message;
  // Notifications (no id) get no response.
  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return ok(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: MCP_INSTRUCTIONS
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !MCP_TOOLS.some((tool) => tool.name === name)) {
        return fail(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        return ok(id, await runTool(name, params?.arguments ?? {}));
      } catch (error) {
        // Tool failures are results the model can read and react to.
        return ok(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

/** @param {Request} request @param {URL} url */
function guard(request, url) {
  if (!mcpAvailable() || !isLocalRequest(request, url)) return new Response('Not found', { status: 404 });
  if (!mcpEnabled()) {
    return Response.json(fail(null, -32000, 'The Docuflex MCP server is turned off. Turn it on in Docuflex (MCP button in the top bar).'), { status: 503 });
  }
  return null;
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  const blocked = guard(request, url);
  if (blocked) return blocked;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(fail(null, -32700, 'Parse error.'), { status: 400 });
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handleMessage))).filter(Boolean);
    return responses.length ? Response.json(responses) : new Response(null, { status: 202 });
  }
  const response = await handleMessage(body);
  return response ? Response.json(response) : new Response(null, { status: 202 });
}

/** No server-initiated stream: every response comes back on its POST. */
/** @type {import('./$types').RequestHandler} */
export function GET({ request, url }) {
  const blocked = guard(request, url);
  if (blocked) return blocked;
  return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
}

/** @type {import('./$types').RequestHandler} */
export function DELETE({ request, url }) {
  const blocked = guard(request, url);
  if (blocked) return blocked;
  return new Response(null, { status: 204 });
}
