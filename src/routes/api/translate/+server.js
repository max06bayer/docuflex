import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  MAX_GENERATED_BYTES,
  MAX_TRANSLATION_BYTES,
  contentLengthExceeds,
  isPdf,
  privateFailure,
  safeFormData
} from '$lib/server/request-security.js';
import { boundedCommand } from '$lib/server/process-security.js';

const TRANSLATION_TIMEOUT_MS = 30 * 60 * 1000;
const LANGUAGE_CODES = new Set(['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ar', 'zh', 'ja', 'ko']);
let translationQueue = Promise.resolve();
/** @type {Promise<string> | undefined} */
let runtimePromise;

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, fetch }) {
  if (contentLengthExceeds(request, MAX_TRANSLATION_BYTES + 1024 * 1024)) return Response.json({ error: 'The uploaded PDF is too large.' }, { status: 413 });

  const form = await safeFormData(request);
  if (!form) return Response.json({ error: 'The upload request is not valid multipart form data.' }, { status: 400 });
  const file = form.get('file');
  const sourceLanguage = String(form.get('sourceLanguage') ?? '').toLowerCase();
  const targetLanguage = String(form.get('targetLanguage') ?? '').toLowerCase();
  if (!(file instanceof File) || !file.size) return Response.json({ error: 'Choose a PDF to translate.' }, { status: 400 });
  if (file.size > MAX_TRANSLATION_BYTES) return Response.json({ error: 'The uploaded PDF is too large.' }, { status: 413 });
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') return Response.json({ error: 'Only PDF files can be translated.' }, { status: 400 });
  if (!LANGUAGE_CODES.has(sourceLanguage) || !LANGUAGE_CODES.has(targetLanguage)) return Response.json({ error: 'The selected language is not supported.' }, { status: 400 });
  if (sourceLanguage === targetLanguage) return Response.json({ error: 'Choose two different languages.' }, { status: 400 });

  try {
    const output = await enqueueTranslation(async () => {
      const python = await pythonBinary();
      const runtime = await ensureLocalRuntime(python);
      const directory = await mkdtemp(join(tmpdir(), 'docuflex-translate-'));
      const inputPath = join(directory, 'document.pdf');
      const editsPath = join(directory, 'translation-edits.json');
      try {
        const input = Buffer.from(await file.arrayBuffer());
        if (!isPdf(input)) throw new InvalidDocumentError('The uploaded file is not a valid PDF.');
        await writeFile(inputPath, input);
        await runProcess(python, [
          join(process.cwd(), 'scripts', 'translate-pdf-local.py'),
          inputPath,
          editsPath,
          sourceLanguage,
          targetLanguage
        ], {
          ...process.env,
          PYTHONPATH: [runtime, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
          XDG_DATA_HOME: join(homedir(), '.cache', 'docuflex', 'translate-data'),
          XDG_CACHE_HOME: join(homedir(), '.cache', 'docuflex', 'translate-cache'),
          XDG_CONFIG_HOME: join(homedir(), '.cache', 'docuflex', 'translate-config'),
          ARGOS_DEVICE_TYPE: 'cpu',
          ARGOS_STANZA_AVAILABLE: '0'
        });
        const editPayload = JSON.parse(await readFile(editsPath, 'utf8'));
        if (!Array.isArray(editPayload.edits) || !editPayload.edits.length) throw new Error('No translatable PDF text was found.');
        const backendUrl = env.PDF_BACKEND_URL ?? 'http://127.0.0.1:8080';
        const response = await fetch(`${backendUrl}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdfBase64: input.toString('base64'), edits: editPayload.edits }),
          signal: AbortSignal.timeout(120_000)
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.pdfBase64) throw new Error(result?.error || `PDF text editing failed (${response.status}).`);
        if (!Number(result.applied)) throw new Error('The PDF text editor could not match the text to translate.');
        if (Array.isArray(result.misses) && result.misses.length) {
          console.warn(`PDF translation applied ${result.applied} edits with ${result.misses.length} unmatched text runs.`);
        }
        const translated = Buffer.from(result.pdfBase64, 'base64');
        if (!translated.byteLength || translated.byteLength > MAX_GENERATED_BYTES || !isPdf(translated)) {
          throw new Error('The translated PDF output is invalid or too large.');
        }
        return translated;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    return new Response(new Uint8Array(output), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="document-${targetLanguage}.pdf"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof InvalidDocumentError) return Response.json({ error: error.message }, { status: 400 });
    if (/no selectable text/i.test(detail)) {
      return Response.json({ error: 'This PDF has no selectable text to translate. Run OCR on scanned pages first.' }, { status: 400 });
    }
    const editorUnavailable = /fetch failed|ECONNREFUSED|PDF text editing failed \(50[023]\)/i.test(detail);
    const translationUnavailable = /No module named|pip|package index|download|could not be executed|ENOENT/i.test(detail);
    return privateFailure(
      error,
      'Local PDF translation',
      editorUnavailable
        ? 'The PDF text-edit service is unavailable.'
        : translationUnavailable
          ? 'Local translation could not be prepared. Please try again shortly.'
          : 'Could not translate this PDF.',
      editorUnavailable || translationUnavailable ? 503 : 400
    );
  }
}

/** @param {() => Promise<Buffer>} task */
async function enqueueTranslation(task) {
  const previous = translationQueue;
  /** @type {() => void} */
  let release = () => {};
  translationQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

/** @param {string} python */
async function ensureLocalRuntime(python) {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const configured = env.LOCAL_TRANSLATE_PYTHONPATH?.trim();
    if (configured) return configured;
    const bundledRuntime = join(process.cwd(), '.document-python');
    try {
      await access(join(bundledRuntime, 'argostranslate', '__init__.py'), constants.R_OK);
      await access(join(bundledRuntime, 'fitz', '__init__.py'), constants.R_OK);
      return bundledRuntime;
    } catch {}
    const runtime = join(homedir(), '.cache', 'docuflex', 'translate-python');
    try {
      await access(join(runtime, 'argostranslate', '__init__.py'), constants.R_OK);
      await access(join(runtime, 'fitz', '__init__.py'), constants.R_OK);
      return runtime;
    } catch {}
    throw new Error('The bundled translation runtime is not installed.');
  })().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

class InvalidDocumentError extends Error {}

async function pythonBinary() {
  const configured = env.DOCUMENT_CONVERTER_PYTHON?.trim();
  if (configured) return configured;
  for (const candidate of [
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
    '/opt/homebrew/bin/python3', '/opt/local/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'
  ]) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return 'python3';
}

/** @param {string} binary @param {string[]} args @param {NodeJS.ProcessEnv} processEnv */
function runProcess(binary, args, processEnv) {
  return new Promise((resolve, reject) => {
    const command = boundedCommand(binary, args, 'translation');
    const child = spawn(command.binary, command.args, { env: processEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorLog = '';
    let settled = false;
    const finish = (/** @type {() => void} */ callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('Local translation timed out.')));
    }, TRANSLATION_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (errorLog.length < 96 * 1024) errorLog += chunk; });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code, signal) => finish(() => {
      if (code === 0) resolve(undefined);
      else reject(new Error(errorLog.trim() || `Translation process stopped (${signal ?? `exit ${code ?? 1}`}).`));
    }));
  });
}
