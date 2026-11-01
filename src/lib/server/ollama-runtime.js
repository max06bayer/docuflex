import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access,copyFile,mkdir,mkdtemp,open,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {createZstdDecompress} from 'node:zlib';
import {OLLAMA_VERSION,runtimePlan} from '#lib/server/ollama-platform.js';
import {detectGpuVendors} from '#lib/server/ollama-hardware.js';

/** @param {string} path */
async function sha256(path) { const hash=createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part); return hash.digest('hex'); }
/** @param {string[]} paths */
async function firstFile(paths) { for(const path of paths) {try {await access(path,constants.R_OK);return path;}catch{}} throw new Error('The local runtime installer is missing. Reinstall Docuflex.'); }
/** @param {string} root @param {ReturnType<typeof runtimePlan>} plan */
async function installedPlan(root,plan) {
  if(!plan)return null;
  const folder=join(root,'runtimes',plan.id);
  try {
    const marker=JSON.parse(await readFile(join(folder,'DOCUFLEX-RUNTIME.json'),'utf8'));
    if(marker.version!==OLLAMA_VERSION || JSON.stringify(marker.packages)!==JSON.stringify(plan.packages.map(file=>file.sha256)))return null;
    const binary=join(folder,plan.binary);await access(binary,constants.X_OK);return binary;
  }catch{return null;}
}
/** Readiness checks never start Ollama, install packages or probe a GPU. @param {string} root @param {string} [platform] @param {string} [arch] */
export async function downloadedRuntime(root,platform = process.platform,arch = process.arch) {
  for(const vendors of [['amd'],[]]) {const binary=await installedPlan(root,runtimePlan(platform,arch,vendors));if(binary)return binary;}
  return null;
}

/** Resumable downloads of immutable, checksum-pinned official release assets.
 * @param {{url:string;name:string;size:number;sha256:string}} file @param {string} path @param {AbortSignal} signal @param {(bytes:number)=>void} progress
 */
export async function downloadRuntimeFile(file,path,signal,progress) {
  let received=await stat(path).then(info=>info.size).catch(()=>0);
  if(received===file.size && await sha256(path)===file.sha256){progress(received);return;}
  if(received>=file.size){await rm(path,{force:true});received=0;}
  const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(30*60*1000)]);
  let response=await fetch(file.url,{headers:received?{Range:`bytes=${received}-`}:{},signal:requestSignal});
  if(received && [416,501].includes(response.status)){
    await response.body?.cancel();received=0;
    response=await fetch(file.url,{signal:requestSignal});
  }
  if(!response.ok || !response.body)throw new Error(`Could not download the local runtime (HTTP ${response.status}).`);
  if(response.status===206){
    const range=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if(!range || Number(range[1])!==received || Number(range[3])!==file.size)throw new Error('The runtime download returned an invalid resume range.');
  } else received=0;
  const handle=await open(path,received?'a':'w',0o600);
  const reader=response.body.getReader();
  try {
    progress(received);
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      if(signal.aborted)throw new DOMException('Paused','AbortError');
      if(received+value.length>file.size)throw new Error('The runtime archive exceeds its expected size.');
      let offset=0;
      while(offset<value.length){const result=await handle.write(value,offset,value.length-offset);if(!result.bytesWritten)throw new Error('Could not save the runtime download.');offset+=result.bytesWritten;}
      received+=value.length;progress(received);
    }
  } finally {await handle.close();await reader.cancel().catch(()=>{});}
  if(received!==file.size)throw new Error('The runtime download ended early. Choose Resume to continue.');
  if(await sha256(path)!==file.sha256){await rm(path,{force:true});throw new Error('The runtime checksum did not match. Download it again.');}
}

/** @param {string} archive @param {string} folder @param {string} python @param {string} script @param {AbortSignal} signal */
export async function extractRuntimeArchive(archive,folder,python,script,signal) {
  const zip=archive.endsWith('.zip');
  const child=spawn(python,[script,zip?'zip':'tar',folder,...(zip?[archive]:[])],{stdio:[zip?'ignore':'pipe','ignore','pipe'],windowsHide:true,signal});
  let stderr='';child.stderr?.on('data',part=>{stderr=(stderr+String(part)).slice(-4096);});
  const closed=new Promise((resolveClose,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolveClose(undefined):reject(new Error(`Could not extract the local runtime: ${stderr || `exit ${code}`}`)));});
  try {
    await Promise.all([closed,...(!zip?[pipeline(createReadStream(archive),createZstdDecompress(),/** @type {import('node:stream').Writable} */ (child.stdin),{signal})]:[])]);
  } catch(error){child.kill();await closed.catch(()=>{});throw error;}
}

/** Install only inside Docuflex's private data directory; no system installer, service or driver changes.
 * @param {string} root @param {AbortSignal} signal @param {(state:{status:string;received:number;total:number})=>void} progress
 */
export async function ensureDownloadedRuntime(root,signal,progress) {
  const vendors=await detectGpuVendors();
  const plan=runtimePlan(process.platform,process.arch,vendors);
  if(!plan)throw new Error('Local Qwen is unavailable on this operating system or architecture.');
  const existing=await installedPlan(root,plan);if(existing)return existing;
  const downloads=join(root,'downloads'),runtimes=join(root,'runtimes');
  await mkdir(downloads,{recursive:true,mode:0o700});await mkdir(runtimes,{recursive:true,mode:0o700});
  const total=plan.packages.reduce((sum,file)=>sum+file.size,0);let completed=0;
  const paths=[];
  for(const file of plan.packages){
    const path=join(downloads,`${OLLAMA_VERSION}-${file.name}`);paths.push(path);
    await downloadRuntimeFile(file,path,signal,received=>progress({status:`Downloading local runtime · ${file.name}`,received:completed+received,total}));
    completed+=file.size;
  }
  progress({status:'Installing the local GPU runtime…',received:total,total});
  const python=await firstFile([process.env.DOCUMENT_CONVERTER_PYTHON||'',resolve('runtime/python/python.exe'),resolve('runtime/python/bin/python3'),resolve('desktop/src-tauri/resources/runtime/python/bin/python3')].filter(Boolean));
  const script=await firstFile([resolve('scripts/install-ollama-runtime.py')]);
  const staging=await mkdtemp(join(runtimes,'install-'));
  try {
    for(const path of paths)await extractRuntimeArchive(path,staging,python,script,signal);
    if(signal.aborted)throw new DOMException('Paused','AbortError');
    await access(join(staging,plan.binary),constants.X_OK);
    const license=await firstFile([resolve('licenses/ollama-LICENSE.txt'),resolve('desktop/licenses/ollama-LICENSE.txt')]);
    await copyFile(license,join(staging,'OLLAMA_LICENSE'));
    await writeFile(join(staging,'DOCUFLEX-RUNTIME.json'),JSON.stringify({version:OLLAMA_VERSION,packages:plan.packages.map(file=>file.sha256),vendors}),{mode:0o600});
    const destination=join(runtimes,plan.id);
    await rm(destination,{recursive:true,force:true});await rename(staging,destination);
    await Promise.all(paths.map(path=>rm(path,{force:true})));
    return join(destination,plan.binary);
  } finally {await rm(staging,{recursive:true,force:true});}
}
