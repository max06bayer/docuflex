import { openRouterKeyHint, visitorKey } from '$lib/server/ai.js';
import { LATEX_STYLES, MATCH_STYLE, MAX_PAGE_IMAGES, convertToLatex, latexModels, tectonicPath } from '$lib/server/latex.js';
import { isLocalRequest, mcpAvailable } from '$lib/server/mcp-bridge.js';

/** Whether PDF to LaTeX can run here: the engine, a key, and the models and styles to pick from. */
/** @type {import('./$types').RequestHandler} */
export async function GET({ request, url }) {
  const local = isLocalRequest(request, url) && mcpAvailable();
  const engine = Boolean(await tectonicPath());
  return Response.json({
    engine,
    local,
    // The website uses the visitor's key from their browser; the window knows whether it has one.
    keyReady: local ? Boolean(await openRouterKeyHint()) : null,
    styles: LATEX_STYLES.map(({ id, label }) => ({ id, label })),
    matchStyle: MATCH_STYLE,
    maxPageImages: MAX_PAGE_IMAGES,
    ...latexModels()
  });
}

/**
 * Runs one conversion. The answer is newline-delimited JSON: progress events,
 * then { done: true, pdfBase64, tex } or { error }.
 */
/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  const local = isLocalRequest(request, url) && mcpAvailable();
  const key = local ? null : visitorKey(request.headers.get('x-openrouter-key'));
  if (!local && !key) return Response.json({ error: 'Add your OpenRouter API key in Settings.' }, { status: 401 });
  if (!(await tectonicPath())) return Response.json({ error: 'The LaTeX engine is not installed here.' }, { status: 503 });
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.pages) || !body.pages.length) return Response.json({ error: 'Send { pages: [...] }.' }, { status: 400 });
  const pages = body.pages.slice(0, 200).map((/** @type {any} */ page, /** @type {number} */ index) => ({
    text: typeof page?.text === 'string' ? page.text : '',
    image: index < MAX_PAGE_IMAGES && typeof page?.image === 'string' && page.image.startsWith('data:image/jpeg;base64,') ? page.image : null,
    width: Number(page?.width) || undefined,
    height: Number(page?.height) || undefined
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      /** @param {Record<string, any>} event */
      const send = (event) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {}
      };
      try {
        const result = await convertToLatex({
          pages,
          model: typeof body.model === 'string' ? body.model : '',
          style: typeof body.style === 'string' ? body.style : 'auto',
          instructions: typeof body.instructions === 'string' ? body.instructions.slice(0, 2000) : '',
          name: typeof body.name === 'string' ? body.name.slice(0, 200) : '',
          translateTo: typeof body.translateTo === 'string' ? body.translateTo.slice(0, 60) : '',
          fonts: Array.isArray(body.fonts) ? body.fonts.filter((/** @type {unknown} */ font) => typeof font === 'string').slice(0, 40).map((/** @type {string} */ font) => font.slice(0, 80)) : [],
          key,
          signal: request.signal,
          onEvent: send
        });
        send({ done: true, attempts: result.attempts, pdfBase64: result.pdf.toString('base64'), tex: result.tex });
      } catch (failure) {
        if (!request.signal.aborted) {
          send({ error: failure instanceof Error ? failure.message : 'Could not convert this PDF.', tex: /** @type {any} */ (failure)?.tex });
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
}
