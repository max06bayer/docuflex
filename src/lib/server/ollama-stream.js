/** Read Ollama JSON lines, including split UTF-8 and an unterminated last line.
 * @param {Response} response @param {(value: any) => void} event
 */
export async function readOllamaEvents(response, event) {
  if (!response.ok || !response.body) throw new Error(`The local model service answered with HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (/** @type {string} */ line) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.error) throw new Error(value.error);
    event(value);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { emit(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    }
    emit(buffer + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Map native replies to the agent stream and reject incomplete/empty model turns.
 * Logs finish metadata only, never prompts, document text, images, or arguments.
 * @param {Response} response @param {AbortSignal} signal @param {() => void} [onCancel]
 */
export function qwenCompletionStream(response, signal, onCancel = () => {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      let callsSeen = 0;
      let characters = 0;
      let completed = false;
      const emit = (/** @type {any} */ value) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      try {
        await readOllamaEvents(response, (event) => {
          const message = event.message ?? {};
          if (typeof message.content === 'string') characters += message.content.trim().length;
          const calls = (message.tool_calls ?? []).map((/** @type {any} */ call) => ({ index: callsSeen++, id: `qwen_${crypto.randomUUID()}`, type: 'function', function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments ?? {}) } }));
          if (event.done) {
            completed = true;
            console.info('[qwen] completion', JSON.stringify({ reason: event.done_reason ?? 'unknown', inputTokens: event.prompt_eval_count ?? 0, outputTokens: event.eval_count ?? 0, toolCalls: callsSeen, characters }));
          }
          emit({ choices: [{ delta: { ...(message.content ? { content: message.content } : {}), ...(message.thinking ? { reasoning: message.thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, ...(event.done ? { finish_reason: event.done_reason === 'length' ? 'length' : callsSeen ? 'tool_calls' : 'stop' } : {}) }], ...(event.done ? { usage: { prompt_tokens: event.prompt_eval_count ?? 0, completion_tokens: event.eval_count ?? 0, total_tokens: (event.prompt_eval_count ?? 0) + (event.eval_count ?? 0), cost: 0 } } : {}) });
          if (event.done_reason === 'length') throw new Error('Qwen reached its output limit before finishing. The task is incomplete. Ask it to continue with a smaller step.');
        });
        if (!completed) throw new Error('The local model stream ended unexpectedly. The task is incomplete; your existing edits are kept.');
        if (!characters && !callsSeen) throw new Error('Qwen returned no answer or tool action. The task is incomplete; your existing edits are kept.');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (error) {
        if (!signal.aborted && !cancelled) {
          const message = error instanceof Error ? error.message : 'Local Qwen failed.';
          console.warn('[qwen] incomplete turn:', message);
          try { emit({ error: { message } }); } catch {}
        }
      } finally { try { controller.close(); } catch {} }
    },
    cancel() { cancelled = true; onCancel(); }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
}
