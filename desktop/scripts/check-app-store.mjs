import {constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {access,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {distributionProfile,desktopRoot} from './distribution.mjs';
import {sha256File} from './file-hash.mjs';
import {nativeBackendFingerprint} from './build-native-pdf.mjs';
async function exists(path){try{await access(path);return true;}catch{return false;}}
export async function inspectStoreResources(resources){
 const issues=[];
 const problem=(id,message)=>issues.push({id,message});
 let manifest;try{manifest=JSON.parse(await readFile(join(resources,'RUNTIME.json'),'utf8'));}catch{problem('manifest','Store resources have not been staged.');return issues;}
 if(manifest.distribution!=='app-store'||manifest.pdfBackend!=='native-image')problem('distribution','Resources must be staged for the app-store profile.');
 if(await exists(join(resources,'runtime/java')))problem('java','A JVM must not be included in the Store resources.');
 try {await access(join(resources,'runtime/pdf-backend/bin/docuflex-pdf-backend'),constants.X_OK);}catch {problem('native-pdf','The native PDF executable is missing or not executable.');}
 try{const m=JSON.parse(await readFile(join(resources,'runtime/pdf-backend/NATIVE-PDF-BACKEND.json'),'utf8'));if(!m.verified||!m.nativeRasterLocked||m.fingerprint!==await nativeBackendFingerprint())problem('native-pdf','The native PDF backend is stale or unverified.');}catch{problem('native-pdf','A verified native PDF backend is required.');}
 for (const name of ['pdf-native-raster.py','install-model-data.py','translate-pdf-local.py']) {
  const staged = join(resources,'scripts',name);
  if (!await exists(staged) || await sha256File(staged) !== await sha256File(join(desktopRoot,'../scripts',name))) problem('scripts','The staged helper is missing or stale: '+name);
 }
 const site=join(resources,'runtime/python/lib/python3.12/site-packages');
 for(const module of ['argostranslate','ctranslate2','fitz','PIL'])if(!await exists(join(site,module,'__init__.py')))problem('translation-engine','Bundle the translation/conversion engine: missing '+module+'.');
 const zip=join(resources,'runtime/tectonic/texlive-v33.zip');
 if(!await exists(zip))problem('tex','Bundle the offline TeX resources.');
 else if(await sha256File(zip)!=='eab6e0f384907a63634cab1b1050b99e1c1acac5fb592a7ef27bad110022073c')problem('tex','Offline TeX bundle checksum mismatch.');
 async function visit(directory){for(const e of await readdir(directory,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=join(directory,e.name);if(e.isDirectory())await visit(p);else if(/\.(jar|class)$/i.test(e.name))problem('java-bytecode','Java bytecode is not part of the Store package: '+p.slice(resources.length+1));}}
 await visit(resources);
 return issues;
}
export function assertStoreSigning(env=process.env){
 const identity=env.APPLE_SIGNING_IDENTITY||'';
 if(!/^(Apple Distribution:|3rd Party Mac Developer Application:)/.test(identity))throw Error('Set APPLE_SIGNING_IDENTITY to an installed Apple Distribution certificate for the Store build.');
 const identities=execFileSync('security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'});
 if(!identities.includes('"'+identity+'"'))throw Error('The selected Store signing identity is not installed or is not valid.');
 return identity;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const profile=distributionProfile({...process.env,DOCUFLEX_DISTRIBUTION:'app-store'});
 const issues=await inspectStoreResources(profile.resources);
 try{assertStoreSigning();}catch(e){issues.push({id:'signing',message:e.message});}
 console.log(JSON.stringify({resources:profile.resources,readyForSigning:issues.length===0,issues},null,2));
 if(issues.length)process.exitCode=1;
}
