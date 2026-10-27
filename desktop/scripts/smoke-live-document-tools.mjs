import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const frontend = process.env.DOCUFLEX_FRONTEND_URL || 'http://127.0.0.1:43127';

function assertPdfHasVisiblePixels(pdfBytes) {
  const directory = mkdtempSync(join(tmpdir(), 'docuflex-ocr-visual-'));
  try {
    const pdfPath = join(directory, 'ocr.pdf');
    const imagePrefix = join(directory, 'page');
    writeFileSync(pdfPath, pdfBytes);
    execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '96', '-gray', pdfPath, imagePrefix], {
      stdio: 'pipe'
    });
    const pgm = readFileSync(`${imagePrefix}.pgm`);
    const header = pgm.toString('ascii', 0, Math.min(pgm.length, 256));
    const match = header.match(/^P5\s+(?:#.*\s+)*(\d+)\s+(\d+)\s+(\d+)\s/);
    if (!match) throw new Error('OCR visual check could not parse the rendered page.');
    const headerLength = match[0].length;
    const pixels = pgm.subarray(headerLength);
    const visiblePixels = pixels.reduce((count, value) => count + (value < 245 ? 1 : 0), 0);
    if (visiblePixels < 100) {
      throw new Error(`OCR rendered a blank page (${visiblePixels} non-white pixels).`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function minimalPdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 31} >>\nstream\nBT /F1 24 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function expectSuccessfulResponse(label, response) {
  if (response.ok) return response;
  const detail = await response.text();
  throw new Error(`${label} failed with HTTP ${response.status}: ${detail}`);
}

const pdf = minimalPdf('Docuflex Live Tools');
const failures = [];
// Exercise the installed/mounted package, after linuxdeploy or NSIS has
// relocated its libraries. Pre-package Python tests alone cannot verify that.
for (const format of ['docx', 'pptx', 'xlsx']) {
  try {
    const form = new FormData();
    form.set('file', new File([pdf], 'live.pdf', { type: 'application/pdf' }));
    form.set('outputFormat', format);
    const exported = await expectSuccessfulResponse(`PDF to ${format}`, await fetch(`${frontend}/api/convert`, {
      method: 'POST', headers: { Origin: frontend }, body: form
    }));
    const officeBytes = Buffer.from(await exported.arrayBuffer());
    if (officeBytes.subarray(0, 2).toString() !== 'PK') throw new Error(`${format} did not return an Office package.`);
    const back = new FormData();
    back.set('file', new File([officeBytes], `live.${format}`));
    back.set('outputFormat', 'pdf');
    const rendered = await expectSuccessfulResponse(`${format} to PDF`, await fetch(`${frontend}/api/convert`, {
      method: 'POST', headers: { Origin: frontend }, body: back
    }));
    const renderedBytes = Buffer.from(await rendered.arrayBuffer());
    if (renderedBytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${format} roundtrip did not return PDF.`);
    assertPdfHasVisiblePixels(renderedBytes);
  } catch (error) {
    failures.push(error);
  }
}
try {
  const conversion = await expectSuccessfulResponse('Edit Text conversion', await fetch(`${frontend}/api/pdf/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfBase64: pdf.toString('base64') })
  }));
  const conversionResult = await conversion.json();
  if (!conversionResult.htmlBase64 || !Buffer.from(conversionResult.htmlBase64, 'base64').includes('Docuflex')) {
    throw new Error('Edit Text conversion did not return the expected document text.');
  }
} catch (error) {
  failures.push(error);
}

try {
  const ocr = await expectSuccessfulResponse('OCR', await fetch(`${frontend}/api/pdf/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'x-ocr-languages': 'eng' },
    body: pdf
  }));
  const ocrBytes = Buffer.from(await ocr.arrayBuffer());
  if (!ocrBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('OCR did not return a PDF document.');
  }
  // OCR lays invisible text over scanned pages and leaves the pages themselves (and
  // pages that already have text, like this one) untouched, so the size barely changes.
  if (ocrBytes.length < pdf.length * 0.9) {
    throw new Error(`OCR returned a smaller PDF than it received (${ocrBytes.length} of ${pdf.length} bytes).`);
  }
  assertPdfHasVisiblePixels(ocrBytes);
} catch (error) {
  failures.push(error);
}

if (failures.length) throw new AggregateError(failures, 'Packaged document tools failed.');

process.stdout.write('Packaged Office roundtrips, Edit Text and OCR API tests passed.\n');
