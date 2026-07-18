import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const resources = join(desktopRoot, 'src-tauri', 'resources');
const windows = process.platform === 'win32';
const executable = (runtime, name) => join(resources, 'runtime', runtime, 'bin', `${name}${windows ? '.exe' : ''}`);
const ocrExecutable = (name) => windows && name !== 'tesseract'
  ? join(resources, 'runtime', 'ocr', 'poppler', 'bin', `${name}.exe`)
  : executable('ocr', name);
const python = windows ? join(resources, 'runtime', 'python', 'python.exe') : executable('python', 'python3');
const office = process.platform === 'win32'
  ? join(resources, 'runtime', 'office', 'program', 'soffice.com')
  : process.platform === 'linux'
    ? join(resources, 'runtime', 'office', 'program', 'soffice')
    : join(resources, 'runtime', 'office', 'bin', 'soffice');

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: options.cwd ?? resources,
    encoding: options.encoding ?? 'utf8',
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 30_000
  });
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
  return pdf;
}

const temporary = await mkdtemp(join(tmpdir(), 'docuflex-runtime-smoke-'));
try {
  run(executable('node', 'node'), ['--version']);
  run(executable('java', 'java'), ['--version']);
  run(python, ['-c', 'import PIL, docx, lxml, openpyxl, pptx, xlsxwriter; print("python-ok")']);
  run(ocrExecutable('pdftoppm'), ['-v']);
  run(ocrExecutable('pdfunite'), ['-v']);
  const languages = run(ocrExecutable('tesseract'), ['--list-langs'], {
    env: { TESSDATA_PREFIX: join(resources, 'runtime', 'ocr', 'share', 'tessdata') }
  });
  for (const language of ['eng', 'deu', 'osd']) {
    if (!languages.split(/\s+/).includes(language)) throw new Error(`OCR language is missing: ${language}`);
  }

  const image = join(temporary, 'ocr.png');
  const font = join(resources, 'backend', 'fonts', 'inter-variable-normal.ttf');
  run(python, ['-c', [
    'from PIL import Image, ImageDraw, ImageFont',
    `image=Image.new("RGB",(1200,260),"white")`,
    `font=ImageFont.truetype(${JSON.stringify(font)},96)`,
    'ImageDraw.Draw(image).text((35,55),"DOCUFLEX OFFLINE",font=font,fill="black")',
    `image.save(${JSON.stringify(image)})`
  ].join(';')]);
  const ocrText = run(ocrExecutable('tesseract'), [image, 'stdout', '-l', 'eng', '--psm', '7'], {
    env: { TESSDATA_PREFIX: join(resources, 'runtime', 'ocr', 'share', 'tessdata') },
    timeout: 60_000
  });
  if (!/docuflex/i.test(ocrText)) throw new Error(`Bundled OCR smoke test failed: ${ocrText.trim()}`);

  const pdf = join(temporary, 'document.pdf');
  const html = join(temporary, 'document.html');
  await writeFile(pdf, minimalPdf('Docuflex Offline'));
  run(executable('pdf2htmlEX', 'pdf2htmlEX'), [
    '--data-dir', join(resources, 'runtime', 'pdf2htmlEX', 'share', 'pdf2htmlEX'),
    '--quiet', '1', '--embed', '1', '--correct-text-visibility', '0',
    '--dest-dir', temporary, pdf, 'document.html'
  ], { timeout: 120_000 });
  const converted = await readFile(html, 'utf8');
  if (!/Docuflex/.test(converted)) throw new Error('Bundled pdf2htmlEX smoke test did not preserve text.');

  if (process.platform !== 'darwin') run(office, ['--headless', '--version'], { timeout: 60_000 });
  process.stdout.write(`Docuflex ${process.platform}-${process.arch} offline runtime smoke test passed.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
