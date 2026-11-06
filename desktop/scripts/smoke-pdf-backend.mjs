import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const base=process.env.PDF_BACKEND_URL;
if(!base||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Set PDF_BACKEND_URL to the isolated local backend being tested.');
function fixture(){
 const text='BT /F1 24 Tf 72 720 Td (Native backend fixture) Tj ET\nBT /F1 18 Tf 72 100 Td (Keep this text) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let pdf='%PDF-1.4\n';const offsets=[0];for(const o of objects){offsets.push(Buffer.byteLength(pdf));pdf+=`${offsets.length-1} 0 obj\n${o}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf);
}
const directory=await mkdtemp(join(tmpdir(),'docuflex-native-backend-'));
const source=fixture().toString('base64');
async function post(route,extra={},pdfBase64=source){
 const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pdfBase64,annotations:[],...extra}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error(`${route}: ${r.status} ${await r.text()}`);
 return r;
}
async function pdf(route,extra={},input=source){const b=Buffer.from(await(await post(route,extra,input)).arrayBuffer());assert.equal(b.subarray(0,5).toString(),'%PDF-');return b;}
async function text(bytes){const p=join(directory,'result.pdf');await writeFile(p,bytes);return execFileSync('pdftotext',[p,'-'],{encoding:'utf8'});}
try{
 assert.equal((await(await fetch(base+'/health')).json()).ok,true);
 const fonts=await(await post('/fonts')).json();assert.ok(fonts);
 const inspected=await(await post('/ocr-layer',{action:'inspect'})).json();assert.equal(inspected.pages.length,1);assert.ok(inspected.pages[0].characters>0);
 for(const [operation,extra] of [['rotate',{pages:[0],rotation:90}],['extract',{pages:[0]}],['reorder',{order:[0]}],['insert',{insertAt:1,insertPdfBase64:source}]])await pdf('/pages',{operation,...extra});
 const edit=await(await post('/edit',{edits:[{page:0,oldText:'Native backend fixture',newText:'Edited backend fixture'}]})).json();assert.equal(edit.applied,1);assert.match(await text(Buffer.from(edit.pdfBase64,'base64')),/Edited backend fixture/);
 const shape=(type,extra={})=>({page:0,type,x:.1,y:.08,width:.4,height:.12,color:[1,0,0],...extra});
 for(const type of ['rectangle','circle','highlight','watermark'])await pdf('/export',{annotations:[shape(type,{text:type==='watermark'?'STORE TEST':''})]});
 await pdf('/export',{annotations:[{page:0,type:'pen',color:[0,0,1],points:[{x:.1,y:.3},{x:.2,y:.4}]}]});
 for(const [rotation,box] of [[0,[.08,.04,.8,.16]],[90,[.82,.08,.16,.8]],[180,[.08,.8,.84,.18]],[270,[.02,.08,.16,.84]]]){
  const rotated=await pdf('/pages',{operation:'rotate',pages:[0],rotation});
  const [x,y,width,height]=box;
  const redacted=await pdf('/export',{annotations:[shape('blackout',{x,y,width,height})]},rotated.toString('base64'));
  const remaining=await text(redacted);assert.doesNotMatch(remaining,/Native|backend|fixture/);assert.match(remaining,/Keep this text/);
 }
 const blur=Array(21).fill(0);blur[0]=1;blur[6]=1;blur[18]=blur[19]=1;blur[20]=8;
 await pdf('/export',{annotations:[shape('rectangle',{color:blur})]});
 const image=new PNG({width:2,height:2});for(let i=0;i<image.data.length;i+=4)image.data[i+3]=255;
 image.data[3]=0;
 const png=PNG.sync.write(image);
 const pixel='data:image/png;base64,'+png.toString('base64');
 const placed=await pdf('/export',{annotations:[shape('image',{imageData:pixel})]});
 const python=process.env.DOCUMENT_CONVERTER_PYTHON||fileURLToPath(new URL('../src-tauri/resources/runtime/python/bin/python3',import.meta.url));
 const mask=execFileSync(python,['-c','import fitz,sys; d=fitz.open(stream=sys.stdin.buffer.read(),filetype="pdf"); print(any(i[1]>0 for p in d for i in p.get_images(full=True)))'],{input:placed,encoding:'utf8'});
 assert.equal(mask.trim(),'True','Placed PNG alpha must remain a PDF soft mask');
 const jpeg=execFileSync(python,['-c','from PIL import Image; import io,sys; Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB").save(sys.stdout.buffer,"JPEG")'],{input:png});
 const rasterized=await pdf('/pages',{operation:'rasterize',rasterPages:[{index:0,imageBase64:jpeg.toString('base64')}]});
 assert.doesNotMatch(await text(rasterized),/Native backend fixture/);
 const unicode=await pdf('/export',{annotations:[shape('textfield',{text:'Grüße € Store',textStyle:{fontFamily:'Liberation Sans',fontSize:20}})]});assert.match(await text(unicode),/Grüße/);
 const form=await pdf('/export',{annotations:[shape('input',{fieldName:'store-field',fieldValue:'Form value'}),shape('checkbox',{y:.4,fieldName:'store-check',fieldValue:true})]});assert.ok(form.length>100);
 const password='Docuflex-test-only';const encrypted=await pdf('/export',{encryptionPassword:password});const decrypted=await pdf('/decrypt',{password},encrypted.toString('base64'));assert.match(await text(decrypted),/Native backend fixture/);
 await pdf('/ocr-layer',{action:'apply',pages:[{index:0,width:612,height:792,words:[['OCR fixture',72,500,180,500,72,480]]}]});
 const uncropped=await(await post('/uncrop')).json();assert.ok(uncropped);
 process.stdout.write('PDF backend checks passed: fonts, text edits, pages, markup, image/Unicode/form export, redaction, encryption/decryption and OCR.\n');
}finally{await rm(directory,{recursive:true,force:true});}
