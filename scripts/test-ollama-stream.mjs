import assert from 'node:assert/strict';
import test from 'node:test';
import { qwenCompletionStream } from '../src/lib/server/ollama-stream.js';
const native = (events) => new Response(events.map((event) => JSON.stringify(event)).join('\n'));
const read = (events) => qwenCompletionStream(native(events), new AbortController().signal).text();

test('valid tool arguments pass through unchanged, with usage and a completed stream', async () => {
  const args = { page: 8, points: [{ x: 20, y: 30 }, { x: 40, y: 50 }] };
  const text = await read([{ message: { tool_calls: [{ function: { name: 'draw', arguments: args } }] } }, { done: true, done_reason: 'stop', eval_count: 50 }]);
  const event = JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  assert.deepEqual(JSON.parse(event.choices[0].delta.tool_calls[0].function.arguments), args);
  assert.ok(text.includes('data: [DONE]'));
  assert.ok(!text.includes('"error"'));
});
test('an empty model completion explains the incomplete task instead of succeeding silently', async () => {
  const text = await read([{ message: { content: '' }, done: true, done_reason: 'stop' }]);
  assert.match(text, /returned no answer or tool action/);
  assert.ok(!text.includes('data: [DONE]'));
});
test('a token limit is visible even when partial text was generated', async () => {
  const text = await read([{ message: { content: 'Starting the drawing' } }, { done: true, done_reason: 'length', eval_count: 4096 }]);
  assert.match(text, /Starting the drawing/);
  assert.match(text, /output limit/);
  assert.ok(!text.includes('data: [DONE]'));
});
test('EOF without a final model event does not count as a completed task', async () => {
  const text = await read([{ message: { content: 'Partial answer' } }]);
  assert.match(text, /stream ended unexpectedly/);
  assert.ok(!text.includes('data: [DONE]'));
});
test('split UTF-8 and a final line without newline preserve text', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ message: { content: 'Grüße 🦄' } }) + '\n' + JSON.stringify({ done: true, done_reason: 'stop' }));
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
  const text = await qwenCompletionStream(response, new AbortController().signal).text();
  assert.match(text, /Grüße 🦄/);
  assert.ok(text.includes('data: [DONE]'));
});
test('closing the response cancels the owned upstream request', async () => {
  let upstream;
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { upstream = controller; } }));
  const mapped = qwenCompletionStream(response, new AbortController().signal, () => { cancelled = true; upstream.close(); });
  await mapped.body.cancel();
  assert.equal(cancelled, true);
});

test('streams provider thinking separately from the final answer', async () => {
  const text=await read([{message:{thinking:'Considering the task'}},{message:{content:'12'}},{done:true,done_reason:'stop'}]);
  const chunks=text.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
  assert.equal(chunks[0].choices[0].delta.reasoning,'Considering the task');
  assert.equal(chunks[1].choices[0].delta.content,'12');
  assert.ok(!chunks[0].choices[0].delta.content);
});
