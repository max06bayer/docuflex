import { MEMORY_TOOLS, aiAvailable, runMemoryTool } from '#lib/server/ai.js';
import { isLocalRequest } from '#lib/server/mcp-bridge.js';
import { MCP_TOOLS, runTool } from '#lib/server/mcp-tools.js';

/** Longest tool text the model gets back; long page text is cut here. */
const MAX_TEXT = 60_000;

/** Runs a tool call from the AI chat through the same code as the MCP server. */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  if (!isLocalRequest(request, url) || !(await aiAvailable())) return new Response('Not found', { status: 404 });
  const body = await request.json().catch(() => null);
  const name = body?.name;
  if (MEMORY_TOOLS.some((tool) => tool.name === name)) {
    try {
      const result = await runMemoryTool(name, body.args && typeof body.args === 'object' ? body.args : {}, body.context);
      return Response.json({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (error) {
      return Response.json({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
    }
  }
  if (typeof name !== 'string' || !MCP_TOOLS.some((tool) => tool.name === name)) {
    return Response.json({ content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
  }
  try {
    const agent = typeof body.agent === 'string' && /^[\w-]{1,40}$/.test(body.agent) ? body.agent : 'chat';
    const result = await runTool(name, body.args && typeof body.args === 'object' ? body.args : {}, agent);
    for (const part of result.content) {
      if (part.type === 'text' && part.text.length > MAX_TEXT) part.text = `${part.text.slice(0, MAX_TEXT)}\n… (cut, ${part.text.length - MAX_TEXT} more characters)`;
    }
    return Response.json(result);
  } catch (error) {
    return Response.json({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
  }
}
