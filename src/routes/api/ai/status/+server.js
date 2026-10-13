import { AI_FALLBACK_MODEL, AI_MODEL, AI_TOOL_INFO, aiAvailable } from '$lib/server/ai.js';
import { isLocalRequest } from '$lib/server/mcp-bridge.js';

/** Whether the AI chat can run here, and what the window needs to show it. */
/** @type {import('./$types').RequestHandler} */
export async function GET({ request, url }) {
  if (!isLocalRequest(request, url) || !(await aiAvailable())) return Response.json({ available: false });
  return Response.json({ available: true, model: AI_MODEL, fallbackModel: AI_FALLBACK_MODEL, tools: AI_TOOL_INFO });
}
