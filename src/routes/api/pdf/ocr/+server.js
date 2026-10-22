import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_DOCUMENT_BYTES,
  MAX_GENERATED_BYTES,
  contentLengthExceeds,
  isPdf,
  privateFailure
} from '$lib/server/request-security.js';
import { boundedCommand } from '$lib/server/process-security.js';

const MAX_LOG_BYTES = 96 * 1024;
const MAX_OCR_JSON_BYTES = 64 * 1024 * 1024;
const OCR_TIMEOUT_MS = 10 * 60 * 1000;
const PAGE_TIMEOUT_MS = 3 * 60 * 1000;
// A page is recognized when it has (almost) no text, or when a large part of
// it is an image: a scan that carries a stamped header or footer. Words that
// land on text the page already has are dropped by the backend.
const MIN_TEXT_CHARACTERS = 20;
const MIN_IMAGE_COVERAGE = 0.5;
const MIN_TESSERACT_CONFIDENCE = 20;

/** Tesseract's language codes for the BCP 47 languages browsers report. @type {Record<string, string>} */
const TESSERACT_LANGUAGES = {
  ar: 'ara', bg: 'bul', cs: 'ces', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa', et: 'est',
  fi: 'fin', fr: 'fra', he: 'heb', hr: 'hrv', hu: 'hun', it: 'ita', ja: 'jpn', ko: 'kor', lt: 'lit',
  lv: 'lav', nb: 'nor', nl: 'nld', no: 'nor', pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus', sk: 'slk',
  sl: 'slv', sr: 'srp', sv: 'swe', th: 'tha', tr: 'tur', uk: 'ukr', vi: 'vie', zh: 'chi_sim'
};

let ocrQueue = Promise.resolve();

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, fetch }) {
  if (contentLengthExceeds(request, MAX_DOCUMENT_BYTES)) {
    return Response.json({ error: 'The PDF is too large for OCR.' }, { status: 413 });
  }
  const input = await request.arrayBuffer();
  if (!input.byteLength || input.byteLength > MAX_DOCUMENT_BYTES) {
    return Response.json({ error: input.byteLength ? 'The PDF is too large for OCR.' : 'The PDF is empty.' }, { status: input.byteLength ? 413 : 400 });
  }
  if (!isPdf(input)) return Response.json({ error: 'The uploaded file is not a valid PDF.' }, { status: 400 });

  const languages = requestedLanguages(env.OCR_LANGUAGES?.trim() || request.headers.get('x-ocr-languages') || 'en');
  try {
    const result = await enqueueOcr(() => createSearchablePdf(fetch, Buffer.from(input), languages));
    return new Response(new Uint8Array(result.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(result.pdf.byteLength),
        'Cache-Control': 'no-store',
        'X-OCR-Engine': result.engine,
        'X-OCR-Pages': String(result.pages),
        'X-OCR-Words': String(result.words)
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missing = /ENOENT|not found|could not be executed/i.test(detail);
    return privateFailure(
      error,
      'PDF OCR',
      missing ? 'OCR is not installed on this server.' : 'Could not OCR this PDF.',
      missing ? 503 : 400
    );
  }
}

/** @param {() => Promise<any>} task */
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

/**
 * Recognizes the scanned pages and lays the words over the original pages as
 * invisible text, so the document keeps its exact look, sharpness and size.
 * @param {typeof fetch} fetch @param {Buffer} input @param {string[]} languages
 */
async function createSearchablePdf(fetch, input, languages) {
  const pdfBase64 = input.toString('base64');
  const inspection = await callBackend(fetch, { action: 'inspect', pdfBase64 });
  /** @type {{ characters: number, imageCoverage: number }[]} */
  const pageInfo = (await inspection.json()).pages ?? [];
  const targets = pageInfo
    .map((page, index) => ({ ...page, index }))
    .filter((page) => page.characters < MIN_TEXT_CHARACTERS || page.imageCoverage >= MIN_IMAGE_COVERAGE)
    .map((page) => page.index);
  if (!targets.length) return { pdf: input, engine: 'none', pages: 0, words: 0 };

  const directory = await mkdtemp(join(tmpdir(), 'docuflex-ocr-'));
  try {
    const inputPath = join(directory, 'input.pdf');
    await writeFile(inputPath, input);
    const { engine, pages } = await recognizePages(directory, inputPath, targets, languages);
    const words = pages.reduce((/** @type {number} */ total, /** @type {{ words: unknown[] }} */ page) => total + page.words.length, 0);
    if (!words) return { pdf: input, engine, pages: targets.length, words: 0 };
    const applied = await callBackend(fetch, { action: 'apply', pdfBase64, pages });
    const output = Buffer.from(await applied.arrayBuffer());
    if (!output.byteLength || output.byteLength > MAX_GENERATED_BYTES) throw new Error('OCR output is too large.');
    if (!isPdf(output)) throw new Error('OCR output is not a valid PDF.');
    return { pdf: output, engine, pages: targets.length, words };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** @param {typeof fetch} fetch @param {Record<string, unknown>} body */
async function callBackend(fetch, body) {
  const backendUrl = env.PDF_BACKEND_URL ?? 'http://127.0.0.1:8080';
  const response = await fetch(`${backendUrl}/ocr-layer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5 * 60_000)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error ?? `The PDF backend failed (${response.status}).`);
  }
  return response;
}

/**
 * Apple Vision on macOS (on-device, far better on photos, skewed and sideways
 * scans), Tesseract everywhere else or when Vision is unavailable.
 * @param {string} directory @param {string} inputPath @param {number[]} targets @param {string[]} languages
 */
async function recognizePages(directory, inputPath, targets, languages) {
  const vision = env.VISION_OCR_BIN?.trim();
  if (vision && await exists(vision)) {
    try {
      const output = await captureCommand(vision, [
        inputPath,
        '--pages', targets.join(','),
        '--languages', languages.join(',')
      ], OCR_TIMEOUT_MS, MAX_OCR_JSON_BYTES);
      return { engine: 'vision', pages: JSON.parse(output).pages };
    } catch (error) {
      console.error('Vision OCR failed, using Tesseract:', error);
    }
  }
  return { engine: 'tesseract', pages: await recognizeWithTesseract(directory, inputPath, targets, languages) };
}

/** @param {string} directory @param {string} inputPath @param {number[]} targets @param {string[]} languages */
async function recognizeWithTesseract(directory, inputPath, targets, languages) {
  const tesseract = env.TESSERACT_BIN?.trim() || 'tesseract';
  const codes = await tesseractLanguages(tesseract, languages);
  // One single-threaded Tesseract per page is much faster than one
  // multi-threaded Tesseract working through the pages in turn.
  const workers = Math.max(1, Math.min(Number(env.OCR_JOBS) || availableParallelism(), 8, targets.length));
  /** @type {any[]} */
  const pages = [];
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < targets.length) {
      const index = targets[next];
      next += 1;
      pages.push(await recognizePageWithTesseract(directory, inputPath, index, tesseract, codes));
    }
  }));
  return pages.sort((left, right) => left.index - right.index);
}

/**
 * @param {string} directory @param {string} inputPath @param {number} index
 * @param {string} tesseract @param {string} languages
 */
async function recognizePageWithTesseract(directory, inputPath, index, tesseract, languages) {
  const imageBase = join(directory, `page-${index + 1}`);
  const pageNumber = String(index + 1);
  await runCommand(env.PDFTOPPM_BIN?.trim() || 'pdftoppm', [
    '-r', '300', '-gray', '-f', pageNumber, '-l', pageNumber, '-singlefile', inputPath, imageBase
  ], PAGE_TIMEOUT_MS);
  const tsv = await captureCommand(tesseract, [
    // Settings instead of the "tsv" config name: not every tessdata folder
    // (the desktop bundle's included) ships the config files.
    `${imageBase}.pgm`, 'stdout', '-l', languages, '--dpi', '300',
    '-c', 'tessedit_create_txt=0', '-c', 'tessedit_create_tsv=1'
  ],PAGE_TIMEOUT_MS, MAX_OCR_JSON_BYTES, { OMP_THREAD_LIMIT: '1' });
  await rm(`${imageBase}.pgm`, { force: true });
  return { index, ...parseTesseractTsv(tsv) };
}

/**
 * Tesseract's word boxes hug each word's own letters; the line box gives every
 * word of a line the same top and baseline, as the text layer needs.
 * @param {string} tsv
 */
function parseTesseractTsv(tsv) {
  let width = 1;
  let height = 1;
  /** @type {Map<string, { top: number, bottom: number }>} */
  const lines = new Map();
  /** @type {{ key: string, text: string, left: number, right: number, confidence: number }[]} */
  const words = [];
  for (const row of tsv.split('\n').slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12) continue;
    const [level, page, block, paragraph, line, , left, top, boxWidth, boxHeight, confidence] = columns.slice(0, 11).map(Number);
    const key = `${page}:${block}:${paragraph}:${line}`;
    if (level === 1) {
      width = boxWidth || width;
      height = boxHeight || height;
    } else if (level === 4) {
      lines.set(key, { top, bottom: top + boxHeight });
    } else if (level === 5) {
      const text = columns.slice(11).join('\t').trim();
      if (text && confidence >= MIN_TESSERACT_CONFIDENCE) {
        words.push({ key, text, left, right: left + boxWidth, confidence: confidence / 100 });
      }
    }
  }
  return {
    width,
    height,
    words: words.flatMap((word) => {
      const line = lines.get(word.key);
      if (!line) return [];
      return [[word.text, word.left, line.bottom, word.right, line.bottom, word.left, line.top, word.confidence]];
    })
  };
}

/** @param {string} tesseract @param {string[]} languages */
async function tesseractLanguages(tesseract, languages) {
  const wanted = [...new Set(languages.map((language) => TESSERACT_LANGUAGES[language.split('-')[0]]).filter(Boolean))];
  try {
    const output = await captureCommand(tesseract, ['--list-langs'], 15_000, MAX_LOG_BYTES);
    const installed = new Set(output.split(/\s+/).filter((value) => /^[a-z_]{3,8}$/i.test(value)));
    const usable = wanted.filter((language) => installed.has(language));
    if (usable.length) return usable.join('+');
  } catch {
    // Tesseract reports the authoritative error when it runs.
  }
  return 'eng';
}

/**
 * Accepts BCP 47 tags ("de-DE,en") or Tesseract codes ("deu+eng").
 * @param {string} value
 */
function requestedLanguages(value) {
  const byCode = Object.fromEntries(Object.entries(TESSERACT_LANGUAGES).map(([tag, code]) => [code, tag]));
  const languages = value.split(/[,+]/)
    .map((language) => language.trim())
    .map((language) => byCode[language.toLowerCase()] ?? language)
    .filter((language) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(language));
  return languages.length ? [...new Set(languages)].slice(0, 6) : ['en'];
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} binary @param {string[]} args @param {number} timeoutMs @returns {Promise<void>} */
async function runCommand(binary, args, timeoutMs) {
  await captureCommand(binary, args, timeoutMs, 0);
}

/**
 * @param {string} binary @param {string[]} args @param {number} timeoutMs
 * @param {number} maxOutputBytes @param {Record<string, string>} [extraEnv]
 * @returns {Promise<string>}
 */
function captureCommand(binary, args, timeoutMs, maxOutputBytes, extraEnv) {
  return new Promise((resolve, reject) => {
    const command = boundedCommand(binary, args, 'ocr');
    const child = spawn(command.binary, command.args, {
      stdio: ['ignore', maxOutputBytes ? 'pipe' : 'ignore', 'pipe'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env
    });
    /** @type {Buffer[]} */
    const output = [];
    let outputBytes = 0;
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
    child.stdout?.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`${binary} produced too much output.`)));
        return;
      }
      output.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { if (log.length < MAX_LOG_BYTES) log += chunk; });
    child.on('error', (error) => { finish(() => reject(error)); });
    child.on('exit', (code, signal) => {
      finish(() => {
        if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
        else reject(new Error(log.trim() || `${binary} stopped (${signal ?? `exit ${code ?? 1}`}).`));
      });
    });
  });
}
