import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_REQUEST_BYTES = 150 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 300 * 1024 * 1024;
const MAX_LOG_BYTES = 96 * 1024;
const OCR_TIMEOUT_MS = 10 * 60 * 1000;

let ocrQueue = Promise.resolve();

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'The PDF is too large for OCR.' }, { status: 413 });
  }
  const input = await request.arrayBuffer();
  if (!input.byteLength || input.byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: input.byteLength ? 'The PDF is too large for OCR.' : 'The PDF is empty.' }, { status: input.byteLength ? 413 : 400 });
  }

  const requestedLanguages = sanitizeLanguages(
    env.OCR_LANGUAGES?.trim() || request.headers.get('x-ocr-languages') || 'eng'
  );
  try {
    const output = await enqueueOcr(() => createSearchablePdf(Buffer.from(input), requestedLanguages));
    return new Response(new Uint8Array(output), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(output.byteLength),
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    console.error('PDF OCR failed:', error);
    const detail = error instanceof Error ? error.message : String(error);
    const missing = /ENOENT|not found|could not be executed/i.test(detail);
    return Response.json({
      error: missing
        ? 'OCR is not installed. Install OCRmyPDF, Tesseract, and Poppler.'
        : `OCR failed: ${detail}`
    }, { status: missing ? 503 : 400 });
  }
}

/** @param {() => Promise<Buffer>} task */
async function enqueueOcr(task) {
  const previous = ocrQueue;
  /** @type {() => void} */
  let release = () => {};
  ocrQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

/** @param {Buffer} input @param {string} requestedLanguages */
async function createSearchablePdf(input, requestedLanguages) {
  const directory = await mkdtemp(join(tmpdir(), 'docuflex-ocr-'));
  const inputPath = join(directory, 'input.pdf');
  const outputPath = join(directory, 'searchable.pdf');
  try {
    await writeFile(inputPath, input);
    const languages = await availableLanguages(requestedLanguages);
    const binary = env.OCR_PDF_BIN?.trim() || 'ocrmypdf';
    try {
      await runCommand(binary, [
        '--output-type', 'pdf',
        '--skip-text',
        '--rotate-pages',
        '--deskew',
        '--optimize', '0',
        '--jobs', String(Math.max(1, Math.min(4, Number(env.OCR_JOBS ?? 1) || 1))),
        '--language', languages,
        '--tesseract-timeout', '180',
        inputPath,
        outputPath
      ], OCR_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      await runTesseractFallback(directory, inputPath, outputPath, languages);
    }
    const outputStats = await stat(outputPath);
    if (!outputStats.size || outputStats.size > MAX_OUTPUT_BYTES) throw new Error('OCR output is too large.');
    return await readFile(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** @param {string} directory @param {string} inputPath @param {string} outputPath @param {string} languages */
async function runTesseractFallback(directory, inputPath, outputPath, languages) {
  const imagePrefix = join(directory, 'page');
  await runCommand(env.PDFTOPPM_BIN?.trim() || 'pdftoppm', ['-r', '300', '-png', inputPath, imagePrefix], OCR_TIMEOUT_MS);
  const images = (await readdir(directory))
    .filter((name) => /^page-\d+\.png$/i.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
  if (!images.length) throw new Error('OCR could not rasterize any PDF pages.');
  const pagePdfs = [];
  for (let index = 0; index < images.length; index += 1) {
    const outputBase = join(directory, `ocr-page-${String(index + 1).padStart(5, '0')}`);
    await runCommand(env.TESSERACT_BIN?.trim() || 'tesseract', [
      join(directory, images[index]), outputBase, '--dpi', '300', '-l', languages, 'pdf'
    ], OCR_TIMEOUT_MS);
    pagePdfs.push(`${outputBase}.pdf`);
  }
  await runCommand(env.PDFUNITE_BIN?.trim() || 'pdfunite', [...pagePdfs, outputPath], OCR_TIMEOUT_MS);
}

/** @param {string} requested */
async function availableLanguages(requested) {
  try {
    const output = await captureCommand(env.TESSERACT_BIN?.trim() || 'tesseract', ['--list-langs'], 15_000);
    const installed = new Set(output.split(/\s+/).filter((value) => /^[a-z]{3}$/i.test(value)));
    const usable = requested.split('+').filter((language) => installed.has(language));
    if (usable.length) return usable.join('+');
  } catch {
    // OCRmyPDF will provide the authoritative language error if Tesseract cannot be queried.
  }
  return 'eng';
}

/** @param {string} value */
function sanitizeLanguages(value) {
  const languages = value.toLowerCase().split('+').filter((language) => /^[a-z]{3}$/.test(language));
  return languages.length ? [...new Set(languages)].join('+') : 'eng';
}

/** @param {string} binary @param {string[]} args @param {number} timeoutMs @returns {Promise<void>} */
function runCommand(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    let settled = false;
    const finish = (/** @type {() => void} */ callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${binary} exceeded ${Math.round(timeoutMs / 1000)} seconds.`)));
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (log.length < MAX_LOG_BYTES) log += chunk;
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('exit', (code, signal) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(log.trim() || `${binary} stopped (${signal ?? `exit ${code ?? 1}`}).`));
      });
    });
  });
}

/** @param {string} binary @param {string[]} args @param {number} timeoutMs @returns {Promise<string>} */
function captureCommand(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let log = '';
    let settled = false;
    const finish = (/** @type {() => void} */ callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${binary} timed out.`)));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (output.length < MAX_LOG_BYTES) output += chunk; });
    child.stderr.on('data', (chunk) => { if (log.length < MAX_LOG_BYTES) log += chunk; });
    child.on('error', (error) => { finish(() => reject(error)); });
    child.on('exit', (code) => {
      finish(() => {
        if (code === 0) resolve(output);
        else reject(new Error(log.trim() || `${binary} stopped with exit ${code ?? 1}.`));
      });
    });
  });
}
