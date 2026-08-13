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
  if (ocrBytes.length < 5_000 || ocrBytes.length < pdf.length * 3) {
    throw new Error(`OCR returned a suspiciously small, potentially blank PDF (${ocrBytes.length} bytes).`);
  }
  assertPdfHasVisiblePixels(ocrBytes);
} catch (error) {
  failures.push(error);
}

if (failures.length) throw new AggregateError(failures, 'Packaged document tools failed.');

process.stdout.write('Packaged Edit Text and OCR API tests passed.\n');
