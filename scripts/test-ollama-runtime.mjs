import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm,stat,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {zstdCompressSync} from 'node:zlib';
import {downloadRuntimeFile,extractRuntimeArchive,downloadedRuntime} from '../src/lib/server/ollama-runtime.js';
import {runtimePlan,OLLAMA_VERSION} from '../src/lib/server/ollama-platform.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('runtime downloads resume exact ranges, verify checksums and reject corrupted archives',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qwen-download-test-'));
 const data=Buffer.from('verified runtime bytes '.repeat(1000));let requests=0;
 const server=createServer((req,res)=>{
  requests++;
  const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);
  if(req.url==='/no-range'){res.end(data);return;}
  if(req.url==='/unsupported-range' && offset){res.writeHead(501);res.end();return;}
  if(req.url==='/wrong'){res.end(Buffer.alloc(data.length,1));return;}
  if(offset){res.writeHead(206,{'Content-Range':`bytes ${offset}-${data.length-1}/${data.length}`});res.end(data.subarray(offset));}else res.end(data);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 const file={url,name:'fixture',size:data.length,sha256:hash(data)};
 try{
  const path=join(root,'runtime.partial');await writeFile(path,data.subarray(0,123));
  const progress=[];await downloadRuntimeFile(file,path,new AbortController().signal,value=>progress.push(value));
  assert.deepEqual(await readFile(path),data);assert.equal(progress[0],123);
  await downloadRuntimeFile(file,path,new AbortController().signal,()=>{});assert.equal(requests,1,'verified complete archives should not download again');
  await rm(path);await writeFile(path,data.subarray(0,10));
  const paused=new AbortController();paused.abort();
  await assert.rejects(downloadRuntimeFile(file,path,paused.signal,()=>{}),{name:'AbortError'});
  assert.equal((await stat(path)).size,10);
  await downloadRuntimeFile({...file,url:url+'/no-range'},path,new AbortController().signal,()=>{});
  assert.deepEqual(await readFile(path),data);
  await writeFile(path,data.subarray(0,20));
  await downloadRuntimeFile({...file,url:url+'/unsupported-range'},path,new AbortController().signal,()=>{});
  assert.deepEqual(await readFile(path),data);
  await rm(path);await assert.rejects(downloadRuntimeFile({...file,url:url+'/wrong'},path,new AbortController().signal,()=>{}),/checksum/);
  await assert.rejects(stat(path),/ENOENT/);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
test('private runtime readiness requires the correct version, archive hashes and executable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qwen-installed-test-'));const plan=runtimePlan('win32','x64',[]);const folder=join(root,'runtimes',plan.id);
 try{
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'ollama.exe'),'fixture',{mode:0o700});
  assert.equal(await downloadedRuntime(root,'win32','x64'),null);
  await writeFile(join(folder,'DOCUFLEX-RUNTIME.json'),JSON.stringify({version:OLLAMA_VERSION,packages:plan.packages.map(file=>file.sha256)}));
  assert.equal(await downloadedRuntime(root,'win32','x64'),join(folder,'ollama.exe'));
  await writeFile(join(folder,'DOCUFLEX-RUNTIME.json'),JSON.stringify({version:'wrong',packages:[]}));
  assert.equal(await downloadedRuntime(root,'win32','x64'),null);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Windows ZIP and Linux Zstandard archives extract safely; traversal and escaping symlinks are rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qwen-archive-test-'));
 const python=execFileSync(process.platform === 'win32' ? 'python' : 'python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
 const script=resolve('scripts/install-ollama-runtime.py');
 try{
  execFileSync(python,['-c',`import io,os,sys,tarfile,zipfile
p=sys.argv[1]
with zipfile.ZipFile(os.path.join(p,'valid.zip'),'w') as z: z.writestr('ollama.exe','binary');z.writestr('lib/ollama/vulkan.dll','gpu')
with zipfile.ZipFile(os.path.join(p,'bad.zip'),'w') as z: z.writestr('../escape','bad')
with tarfile.open(os.path.join(p,'valid.tar'),'w') as t:
 b=b'#!/bin/sh\\n';m=tarfile.TarInfo('bin/ollama');m.mode=0o755;m.size=len(b);t.addfile(m,io.BytesIO(b))
with tarfile.open(os.path.join(p,'bad.tar'),'w') as t:
 m=tarfile.TarInfo('outside');m.type=tarfile.SYMTYPE;m.linkname='../../escape';t.addfile(m)
`,root]);
  const zipOut=join(root,'zip-out');await extractRuntimeArchive(join(root,'valid.zip'),zipOut,python,script,new AbortController().signal);
  assert.equal(await readFile(join(zipOut,'lib/ollama/vulkan.dll'),'utf8'),'gpu');
  await assert.rejects(extractRuntimeArchive(join(root,'bad.zip'),join(root,'bad-zip'),python,script,new AbortController().signal),/escapes/);
  for(const name of ['valid','bad'])await writeFile(join(root,name+'.tar.zst'),zstdCompressSync(await readFile(join(root,name+'.tar'))));
  const tarOut=join(root,'tar-out');await extractRuntimeArchive(join(root,'valid.tar.zst'),tarOut,python,script,new AbortController().signal);
  assert.ok((await stat(join(tarOut,'bin/ollama'))).isFile());
  if(process.platform!=='win32')assert.ok((await stat(join(tarOut,'bin/ollama'))).mode&0o100);
  await assert.rejects(extractRuntimeArchive(join(root,'bad.tar.zst'),join(root,'bad-tar'),python,script,new AbortController().signal),/outside/);
 }finally{await rm(root,{recursive:true,force:true});}
});
