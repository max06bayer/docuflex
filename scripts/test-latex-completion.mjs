import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentCompletionOptions,readDocumentCompletion,LatexOutputLimitError} from '../src/lib/server/latex-completion.js';
const event = obj => `data: ${JSON.stringify(obj)}\n\n`;
function response(source, size = 7) {
  const bytes = new TextEncoder().encode(source);
  let at=0;
  return new Response(new ReadableStream({pull(c){if(at>=bytes.length)c.close();else{c.enqueue(bytes.slice(at,at+size));at+=size;}}}));
}
const ignore=()=>{};
test('MiMo retains normal planning and disables it only for bounded recovery',()=>{
  assert.deepEqual(documentCompletionOptions('xiaomi/mimo-v2.6-flash',false),{max_tokens:64000,reasoning:{max_tokens:4096}});
  assert.deepEqual(documentCompletionOptions('xiaomi/mimo-v2.6-flash',true),{max_tokens:2048,reasoning:{max_tokens:1024}});
  assert.deepEqual(documentCompletionOptions('xiaomi/mimo-v2.6-flash',false,true).reasoning,{enabled:false});
});
test('other models retain their original document budget; bounded recovery requests lower effort',()=>{
  assert.equal(documentCompletionOptions('other/model',false).max_tokens,32000);
  assert.deepEqual(documentCompletionOptions('other/model',false,true).reasoning,{effort:'low'});
});
test('UTF-8 split chunks and terminal content are preserved, including an unterminated final SSE line',async()=>{
  const stream=event({choices:[{delta:{content:'Grüße '}}]})+'data: '+JSON.stringify({choices:[{delta:{content:'\\end{document}'},finish_reason:'stop'}]});
  assert.equal(await readDocumentCompletion(response(stream),ignore,ignore),'Grüße \\end{document}');
});
test('reasoning-only limit failure reports planning and counts, never returns a fake complete document',async()=>{
  const thinking=[];const summaries=[];const progress=[];
  const stream=event({model:'model',provider:'provider',choices:[{delta:{reasoning:'r'.repeat(450)}}]})+event({choices:[{delta:{},finish_reason:'length'}],usage:{completion_tokens:1000,completion_tokens_details:{reasoning_tokens:1000}}})+'data: [DONE]\n\n';
  await assert.rejects(readDocumentCompletion(response(stream),c=>progress.push(c),c=>thinking.push(c),s=>summaries.push(s)),LatexOutputLimitError);
  assert.deepEqual(thinking,[450]);assert.deepEqual(progress,[]);
  assert.equal(summaries[0].characters,0);assert.equal(summaries[0].reasoningCharacters,450);
  assert.equal(summaries[0].usage.completion_tokens_details.reasoning_tokens,1000);
  assert.equal(JSON.stringify(summaries).includes('rrrr'),false);
});
test('partial TeX from an output-limit response is never compiled as a finished document',async()=>{
  await assert.rejects(readDocumentCompletion(response(event({choices:[{delta:{content:'\\documentclass{article}'},finish_reason:'length'}]})),ignore,ignore),LatexOutputLimitError);
});
test('normal document text arrives after reasoning and returns the complete source',async()=>{
  const progress=[];
  const text='\\documentclass{article}\n\\begin{document}Hello\\end{document}';
  const stream=event({choices:[{delta:{reasoning:'r'.repeat(450)}}]})+event({choices:[{delta:{content:text}}]})+event({choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  assert.equal(await readDocumentCompletion(response(stream),c=>progress.push(c),ignore),text);
  assert.equal(progress[0],text.length);
});
test('provider errors and broken transports fail rather than treating truncated TeX as complete',async()=>{
  await assert.rejects(readDocumentCompletion(response(event({error:{message:'Provider unavailable'}})),ignore,ignore),/Provider unavailable/);
  await assert.rejects(readDocumentCompletion(response(event({choices:[{delta:{content:'partial'}}]})),ignore,ignore),/stopped before/);
  await assert.rejects(readDocumentCompletion(response(event({choices:[{delta:{},finish_reason:'stop'}]})),ignore,ignore),/no LaTeX/);
});

test('runaway planning is cancelled before spending the whole document budget',async()=>{
  const summary=[];
  const stream=event({choices:[{delta:{reasoning:'r'.repeat(24000)}}]});
  await assert.rejects(readDocumentCompletion(response(stream,1024),ignore,ignore,s=>summary.push(s),24000),/planning limit/);
  assert.equal(summary[0].finish,'planning_limit');
});
