import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_GENERATED_BYTES,
  MAX_TRANSLATION_BYTES,
  contentLengthExceeds,
  isPdf,
  logPrivateError,
  safeFormData
} from '$lib/server/request-security.js';
import { boundedCommand } from '$lib/server/process-security.js';
import {
  TRANSLATION_LANGUAGE_CODES,
  autoInstallEnabled,
  findRuntime,
  missingModels,
  pythonBinary,
  translationEnvironment
} from '$lib/server/translate-runtime.js';

const TRANSLATION_TIMEOUT_MS = 30 * 60 * 1000;
const EDIT_TIMEOUT_MS = 10 * 60 * 1000;
let translationQueue = Promise.resolve();

/** A failure with a reason the user can act on. */
class TranslationError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

/** @param {string} message @param {number} status */
const failure = (message, status) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, fetch }) {
  if (contentLengthExceeds(request, MAX_TRANSLATION_BYTES + 1024 * 1024)) return failure('This PDF is larger than the 30 MB translation limit.', 413);

  const form = await safeFormData(request);
  if (!form) return failure('The upload request is not valid multipart form data.', 400);
  const file = form.get('file');
  const sourceLanguage = String(form.get('sourceLanguage') ?? '').toLowerCase();
  const targetLanguage = String(form.get('targetLanguage') ?? '').toLowerCase();
  if (!(file instanceof File) || !file.size) return failure('Choose a PDF to translate.', 400);
  if (file.size > MAX_TRANSLATION_BYTES) return failure('This PDF is larger than the 30 MB translation limit.', 413);
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') return failure('Only PDF files can be translated.', 400);
  if (!TRANSLATION_LANGUAGE_CODES.has(sourceLanguage) || !TRANSLATION_LANGUAGE_CODES.has(targetLanguage)) return failure('The selected language is not supported.', 400);
  if (sourceLanguage === targetLanguage) return failure('Choose two different languages.', 400);

  try {
    const output = await enqueueTranslation(async () => {
      const runtime = await findRuntime();
      if (!runtime) {
        throw new TranslationError(autoInstallEnabled()
          ? 'The translation engine is not downloaded yet. Use Download Model first.'
          : 'The translation engine is not installed on this server.', 503);
      }
      // The desktop downloads models with progress from the panel; never fetch them silently here.
      if (autoInstallEnabled() && (await missingModels(sourceLanguage, targetLanguage)).length) {
        throw new TranslationError('This language model is not downloaded yet. Use Download Model first.', 409);
      }
      const input = Buffer.from(await file.arrayBuffer());
      if (!isPdf(input)) throw new TranslationError('This file is not a valid PDF.', 400);
      const directory = await mkdtemp(join(tmpdir(), 'docuflex-translate-'));
      const inputPath = join(directory, 'document.pdf');
      const editsPath = join(directory, 'translation-edits.json');
      try {
        await writeFile(inputPath, input);
        await runTranslationScript(await pythonBinary(), [
          join(process.cwd(), 'scripts', 'translate-pdf-local.py'),
          inputPath,
          editsPath,
          sourceLanguage,
          targetLanguage
        ], { ...process.env, ...translationEnvironment(runtime) });
        const editPayload = JSON.parse(await readFile(editsPath, 'utf8'));
        if (!Array.isArray(editPayload.edits) || !editPayload.edits.length) throw new TranslationError('No translatable text was found in this PDF.');
        return await applyTranslatedText(fetch, input, editPayload.edits);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    return new Response(new Uint8Array(output.translated), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="document-${targetLanguage}.pdf"`,
        'Cache-Control': 'no-store',
        'X-Docuflex-Translated-Runs': String(output.applied),
        'X-Docuflex-Missed-Runs': String(output.missed)
      }
    });
  } catch (error) {
    if (error instanceof TranslationError) return failure(error.message, error.status);
    const reference = logPrivateError(error, 'Local PDF translation');
    return Response.json({ error: 'Something unexpected went wrong while translating this PDF.', reference }, { status: 500 });
  }
}

/**
 * Writes the translated runs into the original PDF with the text-edit backend.
 * @param {typeof fetch} fetch @param {Buffer} input @param {unknown[]} edits
 */
async function applyTranslatedText(fetch, input, edits) {
  const backendUrl = env.PDF_BACKEND_URL ?? 'http://127.0.0.1:8080';
  /** @type {Response} */
  let response;
  /** @type {string} */
  let body;
  try {
    response = await fetch(`${backendUrl}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64: input.toString('base64'), edits }),
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS)
    });
    body = await response.text();
  } catch (error) {
    if (error instanceof Error && /timeout|abort/i.test(`${error.name} ${error.message}`)) {
      throw new TranslationError('Writing the translated text into the PDF took too long. Try a shorter document.', 504);
    }
    logPrivateError(error, 'PDF text-edit backend');
    throw new TranslationError('The PDF engine is not running, so the translation could not be written into the PDF. Restart Docuflex and try again.', 503);
  }
  /** @type {any} */
  let result = null;
  try { result = JSON.parse(body); } catch {}
  if (!response.ok) {
    throw new TranslationError(result?.error
      ? `The PDF engine could not write the translation: ${result.error}`
      : `The PDF engine failed while writing the translation (HTTP ${response.status}).`, 502);
  }
  if (!result?.pdfBase64) {
    logPrivateError(new Error(`Unreadable /edit response: ${body.slice(0, 200)}`), 'PDF text-edit backend');
    throw new TranslationError('The PDF engine sent back an unreadable response. Update Docuflex and try again.', 502);
  }
  const applied = Number(result.applied) || 0;
  const missed = Array.isArray(result.misses) ? result.misses.length : 0;
  if (!applied) throw new TranslationError('None of the text could be replaced. This PDF’s fonts or text encoding don’t allow editing.');
  if (missed) console.warn(`PDF translation applied ${applied} edits with ${missed} unmatched text runs.`);
  const translated = Buffer.from(result.pdfBase64, 'base64');
  if (!translated.byteLength || !isPdf(translated)) throw new TranslationError('The PDF engine produced a damaged file.', 502);
  if (translated.byteLength > MAX_GENERATED_BYTES) throw new TranslationError('The translated PDF is too large to return.', 413);
  return { translated, applied, missed };
}

/** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
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

/** @param {string} binary @param {string[]} args @param {NodeJS.ProcessEnv} processEnv */
function runTranslationScript(binary, args, processEnv) {
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
      finish(() => reject(new TranslationError('Translating this PDF took more than 30 minutes and was stopped. Try a shorter document.', 504)));
    }, TRANSLATION_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (errorLog.length < 96 * 1024) errorLog += chunk; });
    child.on('error', (error) => finish(() => {
      logPrivateError(error, 'Translation engine start');
      reject(new TranslationError('The translation engine could not be started.', 503));
    }));
    child.on('exit', (code, signal) => finish(() => {
      if (code === 0) return resolve(undefined);
      const reason = errorLog.match(/^DOCUFLEX_ERROR: (.+)$/m)?.[1]?.trim();
      if (reason) return reject(new TranslationError(reason));
      logPrivateError(new Error(errorLog.trim() || `exit ${code}`), 'Translation engine');
      if (signal === 'SIGKILL' || signal === 'SIGXCPU') return reject(new TranslationError('The translation engine ran out of time or memory on this PDF.', 507));
      if (/No module named/i.test(errorLog)) return reject(new TranslationError('The translation engine is incomplete. Download the model again.', 503));
      // The desktop runs locally, so the crash reason is the user's own information.
      const crash = errorLog.match(/^DOCUFLEX_CRASH: (.+)$/m)?.[1]?.trim();
      reject(new TranslationError(crash && autoInstallEnabled()
        ? `The translation engine stopped unexpectedly (${crash.slice(0, 160)}).`
        : 'The translation engine stopped unexpectedly.', 500));
    }));
  });
}
