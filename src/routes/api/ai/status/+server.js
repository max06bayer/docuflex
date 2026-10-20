import { AI_FALLBACK_MODEL, AI_MODEL, AI_MODELS, AI_TOOL_INFO, AI_WEB_TOOL_INFO, openRouterKeyHint } from '$lib/server/ai.js';
import { isLocalRequest, mcpAvailable } from '$lib/server/mcp-bridge.js';

/** Whether the AI chat can run here, and what the window needs to show it. */
/** @type {import('./$types').RequestHandler} */
export async function GET({ request, url }) {
  // configurable: this is the desktop app or local development, where a key can be saved in Settings.
  // Website: each visitor brings their own key, kept in their browser; the window decides availability.
  if (!isLocalRequest(request, url) || !mcpAvailable()) {
    return Response.json({ available: false, configurable: true, mode: 'web', keyHint: null, model: AI_MODEL, models: AI_MODELS, fallbackModel: AI_FALLBACK_MODEL, tools: AI_WEB_TOOL_INFO });
  }
  const keyHint = await openRouterKeyHint();
  if (!keyHint) return Response.json({ available: false, configurable: true, keyHint: null });
  return Response.json({ available: true, configurable: true, keyHint, model: AI_MODEL, models: AI_MODELS, fallbackModel: AI_FALLBACK_MODEL, tools: AI_TOOL_INFO });
}
