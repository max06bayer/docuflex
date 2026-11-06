/** Stream a document response without retaining or replaying model reasoning. */
export class LatexOutputLimitError extends Error {
  constructor(planning = false) { super(planning ? 'The model reached its planning limit before writing.' : 'The model reached its output limit before finishing.'); }
}

/** MiMo has a thinking switch, rather than a strict reasoning token budget.
 * Preserve normal planning; only a bounded recovery turns optional thinking off.
 * @param {string} model @param {boolean} repair @param {boolean} [retry]
 */
export function documentCompletionOptions(model, repair, retry = false) {
  const mimo = model.startsWith('xiaomi/mimo-');
  return {
    max_tokens: repair ? 2048 : mimo ? 64000 : 32000,
    reasoning: mimo && retry ? { enabled: false } : retry ? { effort: 'low' } : { max_tokens: repair ? 1024 : 4096 }
  };
}

/** @param {Response} response
 * @param {(characters: number) => void} onProgress
 * @param {(characters: number) => void} onReasoning
 * @param {(details: Record<string, any>) => void} [onSummary]
 * @param {number} [maxPlanningCharacters] A visible-text guard, not an exact token counter.
 */
export async function readDocumentCompletion(response, onProgress, onReasoning, onSummary = () => {}, maxPlanningCharacters = Infinity) {
  if (!response.body) throw new Error('The AI service returned no response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoningCharacters = 0;
  let reportedText = 0;
  let reportedReasoning = 0;
  let finish = '';
  let done = false;
  /** @type {Record<string, any> | undefined} */
  let usage;
  /** @type {string | undefined} */
  let model;
  /** @type {string | undefined} */
  let provider;
  /** @param {string} line */
  function consume(line) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { done = true; return; }
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.error) throw new Error(event.error.message || 'The AI service failed.');
    model = event.model || model;
    provider = event.provider || provider;
    usage = event.usage || usage;
    const choice = event.choices?.[0];
    const delta = choice?.delta;
    // The terminal event can carry the last text as well as its finish reason.
    if (typeof delta?.content === 'string') text += delta.content;
    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (typeof reasoning === 'string') reasoningCharacters += reasoning.length;
    else if (Array.isArray(delta?.reasoning_details)) {
      for (const part of delta.reasoning_details) reasoningCharacters += (part.text || part.summary || '').length;
    }
    if (!text.length && reasoningCharacters >= maxPlanningCharacters) {
      onSummary({ model, provider, finish: 'planning_limit', characters: 0, reasoningCharacters, usage });
      throw new LatexOutputLimitError(true);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (text.length && (reportedText === 0 || text.length - reportedText >= 400)) {
      reportedText = text.length; onProgress(text.length);
    } else if (!text.length && reasoningCharacters - reportedReasoning >= 400) {
      reportedReasoning = reasoningCharacters; onReasoning(reasoningCharacters);
    }
  }
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer.trim());
    onSummary({ model, provider, finish, characters: text.length, reasoningCharacters, usage });
    if (finish === 'length') throw new LatexOutputLimitError();
    if (!finish && !done) throw new Error('The AI response stopped before it finished. Try again.');
    if (!text.trim()) throw new Error('The AI returned no LaTeX text. Try again.');
    onProgress(text.length);
    return text;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
