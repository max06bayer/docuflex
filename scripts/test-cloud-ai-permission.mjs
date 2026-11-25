import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { CLOUD_AI_DISCLOSURE_VERSION, CLOUD_AI_PERMISSION_KEY, setCloudAiPermission, cloudAiAllowed, requestCloudAiPermission, revokeCloudAiPermission } from '../src/lib/cloud-ai-permission.js';
test('local Qwen never needs cloud permission; a missing UI cannot silently grant it', async () => {
  revokeCloudAiPermission();
  assert.equal(await requestCloudAiPermission('ollama/qwen3.5:4b-q4_K_M'), true);
  assert.equal(get(cloudAiAllowed), false);
  assert.equal(await requestCloudAiPermission('cloud/model'), false);
  cloudAiAllowed.set(true);
  assert.equal(await requestCloudAiPermission('cloud/model'), true);
  revokeCloudAiPermission();
  assert.equal(await requestCloudAiPermission('cloud/model'), false);
});

test('one versioned permission is shared by cloud models and removed on revocation', async () => {
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  try {
    setCloudAiPermission(true);
    assert.equal(data.get(CLOUD_AI_PERMISSION_KEY), CLOUD_AI_DISCLOSURE_VERSION);
    assert.equal(await requestCloudAiPermission('cloud/chat-model'), true);
    assert.equal(await requestCloudAiPermission('cloud/translation-model'), true);
    assert.equal(await requestCloudAiPermission('cloud/enhance-model'), true);
    revokeCloudAiPermission();
    assert.equal(data.has(CLOUD_AI_PERMISSION_KEY), false);
    assert.equal(await requestCloudAiPermission('cloud/chat-model'), false);
  } finally { delete globalThis.localStorage; revokeCloudAiPermission(); }
});
