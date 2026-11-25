import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatDocument, chatDocumentPrompt, MAX_CHAT_TEXT } from '../src/lib/chat-attachments.js';

test('text and source attachments preserve their names and content', async () => {
  const document = await readChatDocument(new File(['hello\nworld'], 'notes.txt'), true);
  assert.deepEqual(document, { name: 'notes.txt', text: 'hello\nworld' });
  assert.match(chatDocumentPrompt([document]), /Attached file: "notes.txt"\n<attachment>\nhello\nworld/);
});
test('binary, empty and unsupported attachments explain rejection', async () => {
  await assert.rejects(readChatDocument(new File(['a\0b'], 'bad.txt'), true), /binary data/);
  await assert.rejects(readChatDocument(new File([], 'empty.txt'), true), /empty/);
  await assert.rejects(readChatDocument(new File(['binary'], 'archive.zip'), true), /Use a PDF/);
});
test('large text is explicitly truncated and oversized files are rejected', async () => {
  const document = await readChatDocument(new File(['a'.repeat(MAX_CHAT_TEXT + 100)], 'large.md'), true);
  assert.match(document.text, /\[Attachment truncated/);
  await assert.rejects(readChatDocument(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'huge.txt'), true), /20 MB/);
});
test('Office files never upload to a conversion service on the website', async () => {
  await assert.rejects(readChatDocument(new File(['office'], 'file.docx'), false), /desktop app/);
});
