import {execFileSync} from 'node:child_process';
import {sha256File} from './file-hash.mjs';
import {access,cp,mkdir,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {desktopRoot} from './distribution.mjs';
import {buildNativePdfBackend} from './build-native-pdf.mjs';

export async function prepareStoreNativeBackend(resources){
 const source=await buildNativePdfBackend({python:join(resources,'runtime/python/bin/python3')});
 const destination=join(resources,'runtime/pdf-backend/bin');
 await mkdir(destination,{recursive:true});
 await cp(join(source,'docuflex-pdf-backend'),join(destination,'docuflex-pdf-backend'));
 await cp(join(source,'NATIVE-PDF-BACKEND.json'),join(resources,'runtime/pdf-backend/NATIVE-PDF-BACKEND.json'));
 await rm(join(resources,'licenses/native-pdf-backend'),{recursive:true,force:true});
 await cp(join(source,'licenses'),join(resources,'licenses/native-pdf-backend'),{recursive:true,dereference:true});
 // Compiler notices are read-only upstream; Tauri must clear copied xattrs.
 execFileSync('chmod',['-R','u+rwX',join(resources,'licenses/native-pdf-backend')]);
}
export async function prepareStoreTexBundle(resources){
 const cache=join(desktopRoot,'.cache/app-store-tex');await mkdir(cache,{recursive:true});
 const archive=join(cache,'tlextras-2022.0r0.tar');
 const zip=join(cache,'texlive-v33.zip');
 try{await access(zip);}catch{
  try{await access(archive);}catch{
   execFileSync('/usr/bin/curl',['-fL','--retry','2','--output',archive+'.part','https://data1b.fullyjustified.net/tlextras-2022.0r0.tar'],{stdio:'inherit'});
   await rename(archive+'.part',archive);
  }
  const actual=await sha256File(archive);
  if(actual!=='425685e124746c15ba9bb8e0596bdaad98fce886afa347fbcf9ec0e9acd7fe79')throw Error('Offline TeX archive checksum mismatch.');
  const python=join(resources,'runtime/python/bin/python3');
  execFileSync(python,['-c',`import sys,tarfile,zipfile
with tarfile.open(sys.argv[1]) as t, zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
 assert t.extractfile('SHA256SUM').read().strip() == b'6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c'
 for entry in t:
  if not entry.isfile(): continue
  assert '/' not in entry.name and chr(92) not in entry.name and entry.name not in ('.','..')
  info=zipfile.ZipInfo(entry.name, date_time=(1980,1,1,0,0,0))
  info.create_system=3; info.external_attr=0o644 << 16
  z.writestr(info,t.extractfile(entry).read(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)`,archive,zip+'.part'],{stdio:'inherit'});
  await rename(zip+'.part',zip);
 }
 // Zip timestamps are deterministic because every entry is created with the ZIP default.
 const digest=await sha256File(zip);
 if(digest!=='eab6e0f384907a63634cab1b1050b99e1c1acac5fb592a7ef27bad110022073c')throw Error('Offline TeX bundle checksum mismatch.');
 await cp(zip,join(resources,'runtime/tectonic/texlive-v33.zip'));
 await writeFile(join(resources,'runtime/tectonic/BUNDLE.json'),JSON.stringify({sha256:digest,upstream:'https://data1b.fullyjustified.net/tlextras-2022.0r0.tar',upstreamSha256:'425685e124746c15ba9bb8e0596bdaad98fce886afa347fbcf9ec0e9acd7fe79',fingerprint:'6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c'},null,2)+'\n');
}
