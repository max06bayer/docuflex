import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,cp,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {desktopRoot} from './distribution.mjs';
import {sha256File} from './file-hash.mjs';
const root=resolve(desktopRoot,'..');
const cache=join(desktopRoot,'.cache/app-store-native');
const home=join(cache,'bellsoft-liberica-vm-full-openjdk25-25.0.4.1/Contents/Home');
const archive=join(cache,'nik.tar.gz');
const tool={url:'https://github.com/bell-sw/LibericaNIK/releases/download/25.0.4.1%2B1-25.0.4.1%2B2/bellsoft-liberica-vm-full-openjdk25.0.4.1%2B2-25.0.4.1%2B1-macos-aarch64.tar.gz',sha256:'216fc08d50f51097a9f27c8e8d94f9dde6c11b029a14501f7bd63e5ec5c8c632'};
export const nativeBackendDirectory=join(cache,'verified');
export async function nativeBackendFingerprint(){
 const hash=createHash('sha256');
 for(const name of ['backend/src/DocuflexPdfServer.java','backend/src/NativeRasterBridge.java','backend/native-image/reachability-metadata.json','backend/lib/pdfbox-app-3.0.8.jar','scripts/pdf-native-raster.py','desktop/scripts/smoke-pdf-backend.mjs','desktop/scripts/build-native-pdf.mjs','scripts/requirements-conversion.txt']){hash.update(name+'\0');hash.update(await readFile(join(root,name)));}
 return hash.digest('hex');
}
async function exists(path){try{await access(path);return true;}catch{return false;}}
function run(binary,args,options={}){execFileSync(binary,args,{cwd:root,stdio:'inherit',...options});}
async function port(){const s=createServer();await new Promise((r,j)=>s.once('error',j).listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function buildNativePdfBackend({python=join(desktopRoot,'src-tauri/resources/runtime/python/bin/python3')}={}){
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The Store native backend currently targets Apple Silicon macOS.');
 const fingerprint=await nativeBackendFingerprint();
 try {const previous=JSON.parse(await readFile(join(nativeBackendDirectory,'NATIVE-PDF-BACKEND.json'),'utf8'));if(previous.fingerprint===fingerprint&&previous.verified&&await exists(join(nativeBackendDirectory,'docuflex-pdf-backend')))return nativeBackendDirectory;}catch{}
 await mkdir(cache,{recursive:true});
 if(!await exists(archive))run('/usr/bin/curl',['-fL','--retry','2','--output',archive+'.part',tool.url]);
 if(!await exists(archive)&&await exists(archive+'.part'))await rename(archive+'.part',archive);
 if(await sha256File(archive)!==tool.sha256)throw Error('Native compiler archive checksum mismatch.');
 if(!await exists(join(home,'bin/native-image')))run('tar',['-xf',archive,'-C',cache]);
 const build=join(cache,'build');await rm(build,{recursive:true,force:true});await mkdir(join(build,'classes'),{recursive:true});
 const jar=join(root,'backend/lib/pdfbox-app-3.0.8.jar');
 run(join(home,'bin/javac'),['--release','17','-cp',jar,'-d',join(build,'classes'),join(root,'backend/src/DocuflexPdfServer.java'),join(root,'backend/src/NativeRasterBridge.java')]);
 run(join(home,'bin/native-image'),['-J-Xmx4g','--parallelism=4','--no-fallback','-march=compatibility','-Djava.awt.headless=true','-Ddocuflex.native.raster=true','--initialize-at-build-time=NativeRasterBridge$Mode','-H:+AddAllCharsets','-cp',join(build,'classes')+':'+jar,'-H:IncludeResources=org/apache/pdfbox/.*|org/apache/fontbox/.*','-H:ConfigurationFileDirectories='+join(root,'backend/native-image'),'DocuflexPdfServer',join(build,'docuflex-pdf-backend')]);
 const chosenPort=await port();
 const env={...process.env,PDF_BACKEND_HOST:'127.0.0.1',PDF_BACKEND_PORT:String(chosenPort),DOCUFLEX_NATIVE_RASTER_PYTHON:python,DOCUFLEX_NATIVE_RASTER_SCRIPT:join(root,'scripts/pdf-native-raster.py')};
 const child=spawn(join(build,'docuflex-pdf-backend'),[],{cwd:root,env,stdio:['ignore','inherit','inherit']});
 try{
  let ready=false;
  for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${chosenPort}/health`,{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  if(!ready)throw Error('Native PDF backend did not start.');
  run(process.execPath,[join(desktopRoot,'scripts/smoke-pdf-backend.mjs')],{env:{...process.env,DOCUMENT_CONVERTER_PYTHON:python,PDF_BACKEND_URL:`http://127.0.0.1:${chosenPort}`}});
 }finally{child.kill('SIGTERM');}
 await mkdir(nativeBackendDirectory,{recursive:true});
 await cp(join(build,'docuflex-pdf-backend'),join(nativeBackendDirectory,'docuflex-pdf-backend'));
 const licenses=join(nativeBackendDirectory,'licenses');await rm(licenses,{recursive:true,force:true});await mkdir(licenses,{recursive:true});
 for(const name of ['LICENSE','LICENSE.txt','LICENSE_NATIVEIMAGE.txt','THIRD_PARTY_LICENSE.txt'])if(await exists(join(home,name)))await cp(join(home,name),join(licenses,name),{dereference:true});
 await cp(join(home,'legal'),join(licenses,'jdk-modules'),{recursive:true,dereference:true});
 for(const name of ['LICENSE','NOTICE'])await writeFile(join(licenses,'PDFBox-'+name),execFileSync('unzip',['-p',jar,'META-INF/'+name]));
 await writeFile(join(nativeBackendDirectory,'NATIVE-PDF-BACKEND.json'),JSON.stringify({fingerprint,compiler:tool,verified:true,nativeRasterLocked:true,architecture:'arm64',runtime:'native executable; no JVM',validation:'fonts, editing, page operations, rotated redaction, images/alpha, blur, forms, encryption/decryption and OCR'},null,2)+'\n');
 return nativeBackendDirectory;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(await buildNativePdfBackend());
