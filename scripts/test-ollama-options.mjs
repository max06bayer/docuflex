import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qwenOptions } from '../src/lib/server/ollama-options.js';
test('PDF Enhance has four times the output space, more context, and releases the runner', () => {
  const document = qwenOptions(0, true);
  assert.equal(document.options.num_predict, 16384);
  assert.equal(document.options.num_ctx, 32768);
  assert.equal(document.keep_alive, 0);
  assert.equal(document.think, false);
});
test('tool chat keeps reasoning and its existing allocation', () => {
  const chat = qwenOptions(5);
  assert.equal(chat.think, true);
  assert.equal(chat.keep_alive, '5m');
  assert.equal(chat.options.num_predict, 8192);
  assert.equal(chat.options.num_ctx, 16384);
});
test('compile repairs use a small patch budget while preserving context and unloading', () => {
  const repair = qwenOptions(0, true, true);
  assert.equal(repair.options.num_predict, 2048);
  assert.equal(repair.options.num_ctx, 32768);
  assert.equal(repair.think, false);
  assert.equal(repair.keep_alive, 0);
});
