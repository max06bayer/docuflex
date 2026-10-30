import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {applyLatexPatches} from '../src/lib/server/latex-patches.js';
const source = String.raw`\documentclass{article}
\begin{document}
\badmacro{Grüße & $x^2$}
OLD
NEW
\end{document}`;
const patch = (search,replacement) => '```search\n'+search+'\n```\n```replace\n'+replacement+'\n```';
test('localized TeX replacement preserves literal backslashes, Unicode, and all untouched content',()=>{
  const result=applyLatexPatches(source,patch(String.raw`\badmacro{Grüße & $x^2$}`,String.raw`Grüße \& $x^2$`));
  assert.equal(result.tex,source.replace(String.raw`\badmacro{Grüße & $x^2$}`,String.raw`Grüße \& $x^2$`));
  assert.equal(result.patches,1);
});
test('a batch uses original offsets and does not patch text inserted by another replacement',()=>{
  const result=applyLatexPatches(source,patch('OLD','NEW')+'\n'+patch('NEW','DONE'));
  assert.equal(result.tex,source.replace('OLD\nNEW','NEW\nDONE'));
});
test('empty replacement deletes the exact excerpt',()=>{
  assert.equal(applyLatexPatches(source,patch('OLD\n','')).tex,source.replace('OLD\n',''));
});
test('a complete document stays supported through the existing full-document path',()=>{
  assert.equal(applyLatexPatches(source,'```latex\n'+source+'\n```'),null);
});
for(const [name,reply,message] of [
  ['ambiguous search',patch('document','x'),/ambiguous/],
  ['missing search',patch('missing text','x'),/not found/],
  ['empty search',patch('','x'),/empty/],
  ['overlapping searches',patch('OLD\nNEW','x')+'\n'+patch('NEW','y'),/overlap/],
  ['reversed blocks','```replace\nx\n```\n```search\nOLD\n```',/followed/],
  ['unfinished pair','```search\nOLD\n```',/complete/],
  ['mixed patch and full document',patch('OLD','x')+'\n```latex\n'+source+'\n```',/only/],
  ['unclosed final block',patch('OLD','x')+'\n```replace\nunfinished',/complete/],
  ['no-op',patch('OLD','OLD'),/did not change/],
  ['deleted document boundary',patch(String.raw`\end{document}`,''),/structure/],
  ['partially valid batch',patch('OLD','x')+'\n'+patch('not in source','y'),/not found/]
]) test(`rejects ${name} without applying any edits`,()=>assert.throws(()=>applyLatexPatches(source,reply),message));
test('patches need an existing document',()=>assert.throws(()=>applyLatexPatches('',patch('OLD','x')),/no current/));
test('patched document really compiles after an undefined-command failure',async t=>{
  const engine=resolve('desktop/src-tauri/resources/runtime/tectonic/tectonic');
  try{await access(engine);}catch{t.skip('Bundled Tectonic unavailable');return;}
  const folder=await mkdtemp(join(tmpdir(),'docuflex-patch-test-'));
  try{
    const broken=String.raw`\documentclass{article}
\begin{document}
\undefineddocuflextest{Hello}
\end{document}`;
    await writeFile(join(folder,'main.tex'),broken);
    const compile=()=>promisify(execFile)(engine,['-X','compile','--untrusted','--only-cached','main.tex'],{cwd:folder,timeout:45000});
    await assert.rejects(compile(),error=>/Undefined control sequence|undefineddocuflextest/.test(error.stderr+error.stdout));
    const corrected=applyLatexPatches(broken,patch(String.raw`\undefineddocuflextest{Hello}`,'Hello'));
    await writeFile(join(folder,'main.tex'),corrected.tex);
    await compile();
    assert.equal((await readFile(join(folder,'main.pdf'))).subarray(0,5).toString(),'%PDF-');
  }finally{await rm(folder,{recursive:true,force:true});}
});
