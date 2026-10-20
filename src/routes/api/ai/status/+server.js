import { AI_FALLBACK_MODEL, AI_MODEL, AI_MODELS, AI_TOOL_INFO, openRouterKeyHint } from '$lib/server/ai.js';
import { isLocalRequest, mcpAvailable } from '$lib/server/mcp-bridge.js';

/** Whether the AI chat can run here, and what the window needs to show it. */
/** @type {import('./$types').RequestHandler} */
export async function GET({ request, url }) {
  // configurable: this is the desktop app or local development, where a key can be saved in Settings.
  if (!isLocalRequest(request, url) || !mcpAvailable()) return Response.json({ available: false, configurable: false });
  const keyHint = await openRouterKeyHint();
  if (!keyHint) return Response.json({ available: false, configurable: true, keyHint: null });
  return Response.json({ available: true, configurable: true, keyHint, model: AI_MODEL, models: AI_MODELS, fallbackModel: AI_FALLBACK_MODEL, tools: AI_TOOL_INFO });
}
