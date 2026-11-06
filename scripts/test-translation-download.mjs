import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { translationDownload, openTranslationDownload, downloadTranslationModel, dismissTranslationDownload } from '../src/lib/translation-download.js';

test('translation popup confirms first, tracks progress, and finishes while hidden', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const windowBefore = globalThis.window;
  const fetchBefore = globalThis.fetch;
  globalThis.window = new EventTarget();
  const requests = [];
  const pending = [];
  let defer;
  const base = {engineReady:true, modelReady:false, canDownload:true, local:true, downloadBytes:100000000, download:null};
  globalThis.fetch = async (url, options) => {
    requests.push({url:String(url),method:options?.method});
    const value = pending.shift();
    if (value === 'wait') return await new Promise(resolve => {defer=resolve;});
    assert.ok(value, 'unexpected request');
    return Response.json(value);
  };
  try {
    pending.push(base);
    await openTranslationDownload('en','de');
    assert.equal(get(translationDownload).phase,'available');
    assert.ok(requests.every(request=>request.method==='GET'));
    pending.push({...base,download:{pair:'en-de',phase:'preparing'}}, {...base,download:{pair:'en-de',phase:'downloading',received:25000000,total:100000000,bytesPerSecond:5000000}});
    await downloadTranslationModel();
    assert.equal(requests.filter(request=>request.method==='POST').length,1);
    assert.equal(get(translationDownload).received,25000000);
    assert.equal(get(translationDownload).phase,'downloading');
    pending.push('wait');
    const poll = openTranslationDownload('en','de');
    dismissTranslationDownload();
    defer(Response.json({...base,modelReady:true,download:{pair:'en-de',phase:'done'}}));
    await poll;
    assert.equal(get(translationDownload).visible,false);
    assert.equal(get(translationDownload).phase,'ready');
    assert.match(get(translationDownload).label,/English.*German/);
  } finally {
    globalThis.fetch=fetchBefore;
    globalThis.window=windowBefore;
    t.mock.timers.reset();
  }
});
