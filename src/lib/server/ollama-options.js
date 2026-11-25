/** PDF generation needs room for an entire document, separately from tool-based chat. */
export function qwenOptions(toolCount = 0, document = false, repair = false) {
  return {
    think: !document && toolCount > 0,
    // Drop the document's prompt cache after completion, including output-limit failures.
    keep_alive: document ? 0 : '5m',
    options: { num_ctx: document ? 32768 : 16384, num_predict: document ? (repair ? 2048 : 16384) : toolCount ? 8192 : 4096, temperature: 0.2 }
  };
}
