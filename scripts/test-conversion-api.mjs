// Run against a local Docuflex with staged conversion runtimes.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const origin = process.env.DOCUFLEX_TEST_ORIGIN || 'http://127.0.0.1:5178';
const directory = new URL('../tmp/conversion/', import.meta.url);
await mkdir(directory, { recursive: true });
execFileSync(process.env.DOCUMENT_CONVERTER_PYTHON || 'python3', ['-c', `
import runpy
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
root=Path(${JSON.stringify(fileURLToPath(new URL('../', import.meta.url)))})
runpy.run_path(str(root/'scripts/test-editable-conversion.py'))['fixture'](root/'tmp/conversion/fixture.pdf')
image=Image.new('RGB',(1400,500),'white')
ImageDraw.Draw(image).text((50,90),'DOCUFLEX LOCAL SCAN',fill='black',font=ImageFont.truetype(str(root/'backend/fonts/inter-variable-normal.ttf'),70))
image.save(root/'tmp/conversion/scan.pdf',resolution=150)
`]);
async function convert(name, format, expected = 200) {
  const form = new FormData();
  form.set('file', new File([await readFile(new URL(name, directory))], name));
  form.set('outputFormat', format);
  const response = await fetch(`${origin}/api/convert`, { method: 'POST', headers: { Origin: origin }, body: form });
  assert.equal(response.status, expected, `${name} -> ${format}: ${response.status === expected ? '' : await response.text()}`);
  if (expected !== 200) return;
  const output = Buffer.from(await response.arrayBuffer());
  assert(output.length > 100);
  if (format === 'pdf') assert.equal(output.subarray(0, 5).toString(), '%PDF-');
  else if (format !== 'doc') assert.equal(output.subarray(0, 2).toString(), 'PK');
  const target = `api-${name.replace(/\.[^.]+$/, '')}.${format}`;
  await writeFile(new URL(target, directory), output);
  console.log(`${name} -> ${format}: ${output.length} bytes`);
  return target;
}
for (const format of ['docx', 'pptx', 'xlsx', 'doc']) await convert('fixture.pdf', format);
for (const format of ['docx', 'pptx', 'xlsx']) await convert('scan.pdf', format);
for (const source of ['api-fixture.docx', 'api-fixture.pptx', 'api-fixture.xlsx', 'api-fixture.doc']) await convert(source, 'pdf');
await convert('api-fixture.doc', 'docx');
await convert('api-fixture.docx', 'pptx');
// Separate profile directories must allow simultaneous Office requests.
await Promise.all([convert('api-fixture.docx', 'pdf'), convert('api-fixture.pptx', 'pdf')]);
const same = await convert('fixture.pdf', 'pdf');
assert.deepEqual(await readFile(new URL(same, directory)), await readFile(new URL('fixture.pdf', directory)));
await writeFile(new URL('invalid.pdf', directory), 'not a pdf');
await convert('invalid.pdf', 'docx', 400);
console.log('Local conversion API tests passed.');
