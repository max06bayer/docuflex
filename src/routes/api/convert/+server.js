import * as env from '$app/env/private';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_DOCUMENT_BYTES,
  MAX_GENERATED_BYTES,
  contentLengthExceeds,
  isOleCompound,
  isPdf,
  isZip,
  privateFailure,
  safeFormData
} from '#lib/server/request-security.js';
import { boundedCommand } from '#lib/server/process-security.js';

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
  if (contentLengthExceeds(request, MAX_DOCUMENT_BYTES + 1024 * 1024)) return Response.json({ error: 'The uploaded file is too large.' }, { status: 413 });

  const form = await safeFormData(request);
  if (!form) return Response.json({ error: 'The upload request is not valid multipart form data.' }, { status: 400 });
  const file = form.get('file');
  const outputFormat = String(form.get('outputFormat') ?? '').toLowerCase();
  if (!(file instanceof File) || !file.size) return Response.json({ error: 'Choose a file to convert.' }, { status: 400 });
  if (file.size > MAX_DOCUMENT_BYTES) return Response.json({ error: 'The uploaded file is too large.' }, { status: 413 });
  if (!FORMATS.has(outputFormat)) return Response.json({ error: 'The requested output format is not supported.' }, { status: 400 });

  const inputFormat = extname(file.name).slice(1).toLowerCase();
  if (!FORMATS.has(inputFormat)) return Response.json({ error: 'The input format is not supported.' }, { status: 400 });
  const baseName = safeBaseName(file.name);
  const bytes = Buffer.from(await file.arrayBuffer());
  const validInput = inputFormat === 'pdf'
    ? isPdf(bytes)
    : inputFormat === 'doc'
      ? isOleCompound(bytes) || isZip(bytes)
      : isZip(bytes);
  if (!validInput) return Response.json({ error: `The uploaded file is not a valid ${inputFormat.toUpperCase()} document.` }, { status: 400 });
  if (inputFormat === outputFormat) return downloadResponse(bytes, `${baseName}.${outputFormat}`, outputFormat);

  const directory = await mkdtemp(join(tmpdir(), 'docuflex-convert-'));
  const inputPath = join(directory, `${baseName}.${inputFormat}`);
  try {
    await writeFile(inputPath, bytes);
    const officeProfile = `-env:UserInstallation=${pathToFileURL(join(directory, 'office-profile')).href}`;
    const officeConvert = async (/** @type {string} */ source, /** @type {string} */ format) => {
      await runConverter(await converterBinary(), [officeProfile, '--headless', '--convert-to', format, '--outdir', directory, source]);
      return convertedOutputPath(directory, source, format);
    };
    let outputPath;
    let warning = '';
    if (supportsDirectConversion(inputFormat, outputFormat)) {
      // Office's native filters preserve the source structure. Never silently
      // flatten a failed conversion into page screenshots.
      outputPath = await officeConvert(inputPath, outputFormat);
    } else {
      const pdfPath = inputFormat === 'pdf' ? inputPath : await officeConvert(inputPath, 'pdf');
      const generatedFormat = outputFormat === 'doc' ? 'docx' : outputFormat;
      const generatedPath = join(directory, `converted.${generatedFormat}`);
      const report = await runConverter(await pythonBinary(), [
        join(process.cwd(), 'scripts', 'build-converted-office.py'), generatedFormat, generatedPath, pdfPath
      ]);
      if (/"ocrPages":\s*[1-9]/.test(report)) {
        warning = 'Scanned pages were reconstructed with local OCR. Check recognized text; original scan fonts and artwork cannot be recovered reliably.';
      }
      outputPath = outputFormat === 'doc' ? await officeConvert(generatedPath, 'doc') : generatedPath;
    }
    if (outputFormat === 'doc') warning = [warning, 'DOC is a legacy format. Use DOCX to retain embedded fonts and the best layout fidelity.'].filter(Boolean).join(' ');
    const outputStats = await stat(outputPath);
    if (!outputStats.size || outputStats.size > MAX_GENERATED_BYTES) throw new Error('Generated document exceeded the safe output limit.');
    const output = await readFile(outputPath);
    return downloadResponse(output, `${baseName}.${outputFormat}`, outputFormat, warning);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const inputError = detail.match(/CONVERSION_INPUT: ([^\r\n]+)/)?.[1];
    if (inputError) return Response.json({ error: inputError }, { status: 422 });
    return privateFailure(
      error,
      'Document conversion',
      detail.includes('ENOENT') ? 'The document conversion service is not installed.' : 'Could not convert this document.'
    );
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

/** @param {Buffer} bytes @param {string} name @param {string} format @param {string} [warning] */
function downloadResponse(bytes, name, format, warning = '') {
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': CONTENT_TYPES[format],
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
      ...(warning ? { 'X-Docuflex-Conversion-Warning': warning } : {})
    }
  });
}

/** @param {string} binary @param {string[]} args */
function runConverter(binary, args) {
  return new Promise((resolve, reject) => {
    const command = boundedCommand(binary, args, 'native');
    const child = spawn(command.binary, command.args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let errorLog = '';
    let outputLog = '';
    const timeout = setTimeout(() => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
      reject(new Error('Document conversion timed out.'));
    }, CONVERSION_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { outputLog = (outputLog + chunk).slice(-64 * 1024); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (errorLog.length < 64 * 1024) errorLog += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(outputLog);
      else reject(new Error(errorLog.trim() || `Document converter stopped (${signal ?? `exit ${code ?? 1}`}).`));
    });
  });
}
