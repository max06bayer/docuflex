import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
let server;let convertToLatex;
const originalFetch=globalThis.fetch;
before(async()=>{
  server=await createServer({server:{middlewareMode:true,hmr:false},logLevel:'error'});
  ({convertToLatex}=await server.ssrLoadModule('/src/lib/server/latex.js'));
});
after(async()=>{globalThis.fetch=originalFetch;await server?.close();});
const tex=String.raw`\documentclass{article}
\begin{document}Enhance recovery fixture.\end{document}`;
function completion(content,finish='stop') {
  const event={choices:[{delta:{content},finish_reason:finish}]};
  return new Response('data: '+JSON.stringify(event)+'\n\ndata: [DONE]\n\n');
}
function mockCompletions(responses) {
  const requests=[];
  globalThis.fetch=async(url,options)=>{
    if(!String(url).startsWith('https://openrouter.ai/api/v1/chat/completions'))return originalFetch(url,options);
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length,'Unexpected extra completion');
    return responses.shift();
  };
  return requests;
}
function convert(onEvent=()=>{}) {
  return convertToLatex({pages:[{text:'Enhance recovery fixture.'}],model:'xiaomi/mimo-v2.6-flash',style:'classic',instructions:'',name:'fixture.pdf',key:'mock-key-never-sent',signal:new AbortController().signal,onEvent});
}
test('cloud output-limit recovery drops the unfinished response and compiles a complete fresh result',async()=>{
  const calls=mockCompletions([completion('unfinished draft never retained','length'),completion('```latex\n'+tex+'\n```')]);
  const events=[];
  const result=await convert(e=>events.push(e));
  assert.equal(calls.length,2);
  assert.equal(result.pdf.subarray(0,5).toString(),'%PDF-');
  assert.equal(result.attempts,2);
  assert.ok(events.some(e=>e.stage==='resetting'));
  assert.equal(JSON.stringify(calls[1].messages).includes('unfinished draft never retained'),false);
  assert.deepEqual(calls[1].reasoning,{enabled:false});
  assert.equal(calls[1].max_tokens,64000);
});
test('repeated cloud output limits stop after one fresh retry and never reach the compiler',async()=>{
  const calls=mockCompletions([completion('partial','length'),completion('partial','length')]);
  const events=[];
  await assert.rejects(convert(e=>events.push(e)),/output limit/);
  assert.equal(calls.length,2);
  assert.equal(events.some(e=>e.stage==='compiling'),false);
});
test('compiler repair still replaces only a broken section with its small separate response budget',async()=>{
  const broken=tex.replace('Enhance recovery fixture.',String.raw`\undefineddocuflexfixture{Enhance recovery fixture.}`);
  const patch='```search\n'+String.raw`\undefineddocuflexfixture{Enhance recovery fixture.}`+'\n```\n```replace\nEnhance recovery fixture.\n```';
  const calls=mockCompletions([completion('```latex\n'+broken+'\n```'),completion(patch)]);
  const result=await convert();
  assert.equal(result.tex,tex);
  assert.equal(result.attempts,2);
  assert.equal(calls[1].max_tokens,2048);
  assert.deepEqual(calls[1].reasoning,{max_tokens:1024});
});

test('planning-only limit recovery does not replay reasoning or wait for a full output-limit failure',async()=>{
  const thinking=new Response('data: '+JSON.stringify({choices:[{delta:{reasoning:'r'.repeat(64000)}}]})+'\n\n');
  const calls=mockCompletions([thinking,completion('```latex\n'+tex+'\n```')]);
  const result=await convert();
  assert.equal(result.attempts,2);assert.equal(calls.length,2);
  assert.deepEqual(calls[1].reasoning,{enabled:false});
  assert.equal(JSON.stringify(calls[1]).includes('rrrrrrrr'),false);
});
test('a repair that consumes its budget in thinking retries with reduced reasoning',async()=>{
  const broken=tex.replace('Enhance recovery fixture.',String.raw`\undefineddocuflexfixture{Enhance recovery fixture.}`);
  const patch='```search\n'+String.raw`\undefineddocuflexfixture{Enhance recovery fixture.}`+'\n```\n```replace\nEnhance recovery fixture.\n```';
  const calls=mockCompletions([completion('```latex\n'+broken+'\n```'),completion('','length'),completion(patch)]);
  const result=await convert();
  assert.equal(result.tex,tex);assert.equal(calls.length,3);
  assert.deepEqual(calls[2].reasoning,{enabled:false});assert.equal(calls[2].max_tokens,2048);
});

test('a font-package conflict carries its root-cause guidance into targeted repair',async()=>{
  const broken=tex.replace('\\begin{document}',String.raw`\usepackage{newtxtext,newtxmath}
\usepackage{amssymb}
\begin{document}`);
  const patch='```search\n'+String.raw`\usepackage{newtxtext,newtxmath}
\usepackage{amssymb}`+'\n```\n```replace\n'+String.raw`\usepackage{amssymb}
\usepackage{newtxtext,newtxmath}`+'\n```';
  const calls=mockCompletions([completion('```latex\n'+broken+'\n```'),completion(patch)]);
  const result=await convert();
  assert.equal(result.pdf.subarray(0,5).toString(),'%PDF-');
  assert.equal(result.attempts,2);
  assert.match(JSON.stringify(calls[1].messages),/Move the amsmath\/amssymb package load BEFORE/);
});
