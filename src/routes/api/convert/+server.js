import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const MAX_REQUEST_BYTES = 150 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 180_000;
const FORMATS = new Set(['docx', 'doc', 'xlsx', 'pdf', 'pptx']);
/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) return Response.json({ error: 'The uploaded file is too large.' }, { status: 413 });

  const form = await request.formData();
  const file = form.get('file');
  const outputFormat = String(form.get('outputFormat') ?? '').toLowerCase();
  if (!(file instanceof File) || !file.size) return Response.json({ error: 'Choose a file to convert.' }, { status: 400 });
  if (file.size > MAX_REQUEST_BYTES) return Response.json({ error: 'The uploaded file is too large.' }, { status: 413 });
  if (!FORMATS.has(outputFormat)) return Response.json({ error: 'The requested output format is not supported.' }, { status: 400 });

  const inputFormat = extname(file.name).slice(1).toLowerCase();
  if (!FORMATS.has(inputFormat)) return Response.json({ error: 'The input format is not supported.' }, { status: 400 });
  const baseName = safeBaseName(file.name);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (inputFormat === outputFormat) return downloadResponse(bytes, `${baseName}.${outputFormat}`, outputFormat);

  const directory = await mkdtemp(join(tmpdir(), 'docuflex-convert-'));
  const inputPath = join(directory, `${baseName}.${inputFormat}`);
  try {
    await writeFile(inputPath, bytes);
    let outputPath;
    if (supportsDirectConversion(inputFormat, outputFormat)) {
      try {
        await runConverter(await converterBinary(), ['--headless', '--convert-to', outputFormat, '--outdir', directory, inputPath]);
        outputPath = await convertedOutputPath(directory, inputPath, outputFormat);
      } catch (directError) {
        console.warn(`Direct ${inputFormat.toUpperCase()} to ${outputFormat.toUpperCase()} conversion failed; using page rendering.`, directError);
      }
    }
    outputPath ??= await convertViaPageImages({ directory, inputPath, inputFormat, outputFormat, baseName });
    const output = await readFile(outputPath);
    return downloadResponse(output, `${baseName}.${outputFormat}`, outputFormat);
  } catch (error) {
    console.error('Document conversion failed:', error);
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: detail.includes('ENOENT') ? 'The document conversion service is not installed.' : detail }, { status: 503 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** @param {string} inputFormat @param {string} outputFormat */
function supportsDirectConversion(inputFormat, outputFormat) {
  if (outputFormat === 'pdf' && inputFormat !== 'pdf') return true;
  const writerFormats = new Set(['doc', 'docx']);
  return writerFormats.has(inputFormat) && writerFormats.has(outputFormat);
}

/** @param {string} directory @param {string} inputPath @param {string} outputFormat */
async function convertedOutputPath(directory, inputPath, outputFormat) {
  const inputName = inputPath.split('/').at(-1) ?? '';
  const outputFiles = await readdir(directory);
  const outputName = outputFiles.find((name) => name !== inputName && extname(name).slice(1).toLowerCase() === outputFormat);
  if (!outputName) throw new Error(`The converter did not create a ${outputFormat.toUpperCase()} file.`);
  return join(directory, outputName);
}

/** @param {{ directory: string; inputPath: string; inputFormat: string; outputFormat: string; baseName: string }} options */
async function convertViaPageImages({ directory, inputPath, inputFormat, outputFormat, baseName }) {
  const officeBinary = await converterBinary();
  let pdfPath = inputPath;
  if (inputFormat !== 'pdf') {
    await runConverter(officeBinary, ['--headless', '--convert-to', 'pdf', '--outdir', directory, inputPath]);
    pdfPath = await convertedOutputPath(directory, inputPath, 'pdf');
  }
  if (outputFormat === 'pdf') return pdfPath;

  const pagePrefix = join(directory, 'page');
  await runConverter(await pdfRendererBinary(), ['-png', '-r', '144', pdfPath, pagePrefix]);
  const generatedFormat = outputFormat === 'doc' ? 'docx' : outputFormat;
  const generatedPath = join(directory, `${baseName}-rendered.${generatedFormat}`);
  await runConverter(await pythonBinary(), [
    join(process.cwd(), 'scripts', 'build-converted-office.py'),
    generatedFormat,
    generatedPath,
    directory
  ]);
  if (outputFormat !== 'doc') return generatedPath;

  await runConverter(officeBinary, ['--headless', '--convert-to', 'doc', '--outdir', directory, generatedPath]);
  return convertedOutputPath(directory, generatedPath, 'doc');
}

async function converterBinary() {
  const configured = env.DOCUMENT_CONVERTER_BIN?.trim();
  if (configured) return configured;

  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/Applications/LibreOfficeDev.app/Contents/MacOS/soffice',
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice')
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known macOS installation before falling back to PATH.
    }
  }
  return 'soffice';
}

async function pdfRendererBinary() {
  const configured = env.PDF_RENDER_BIN?.trim();
  if (configured) return configured;
  return firstExecutable([
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'),
    '/opt/homebrew/bin/pdftoppm',
    '/opt/local/bin/pdftoppm',
    '/usr/local/bin/pdftoppm',
    '/usr/bin/pdftoppm'
  ], 'pdftoppm');
}

async function pythonBinary() {
  const configured = env.DOCUMENT_CONVERTER_PYTHON?.trim();
  if (configured) return configured;
  return firstExecutable([
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
    '/opt/homebrew/bin/python3',
    '/opt/local/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3'
  ], 'python3');
}

/** @param {string[]} candidates @param {string} fallback */
async function firstExecutable(candidates, fallback) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for a platform-specific executable.
    }
  }
  return fallback;
}

/** @param {string} fileName */
function safeBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'converted';
}

/** @param {Buffer} bytes @param {string} name @param {string} format */
function downloadResponse(bytes, name, format) {
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': CONTENT_TYPES[format],
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store'
    }
  });
}

/** @param {string} binary @param {string[]} args */
function runConverter(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorLog = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Document conversion timed out.'));
    }, CONVERSION_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (errorLog.length < 64 * 1024) errorLog += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(undefined);
      else reject(new Error(errorLog.trim() || `Document converter stopped (${signal ?? `exit ${code ?? 1}`}).`));
    });
  });
}
