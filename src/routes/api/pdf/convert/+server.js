import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_DOCUMENT_BYTES,
  MAX_GENERATED_BYTES,
  MAX_PDF_JSON_REQUEST_BYTES,
  contentLengthExceeds,
  isPdf,
  privateFailure
} from '$lib/server/request-security.js';
import { boundedCommand } from '$lib/server/process-security.js';

const MAX_CONVERTER_LOG_BYTES = 64 * 1024;
const CONVERSION_TIMEOUT_MS = 180_000;

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  if (contentLengthExceeds(request, MAX_PDF_JSON_REQUEST_BYTES)) {
    return Response.json({ error: 'The PDF conversion request is too large.' }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PDF_JSON_REQUEST_BYTES) {
    return Response.json({ error: 'The PDF conversion request is too large.' }, { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: 'The PDF conversion payload is not valid JSON.' }, { status: 400 });
  }
  if (typeof payload?.pdfBase64 !== 'string' || !payload.pdfBase64) {
    return Response.json({ error: 'pdfBase64 is required.' }, { status: 400 });
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.pdfBase64) || payload.pdfBase64.length % 4 !== 0) {
    return Response.json({ error: 'pdfBase64 is not valid base64 data.' }, { status: 400 });
  }
  const pdf = Buffer.from(payload.pdfBase64, 'base64');
  if (!pdf.byteLength || pdf.byteLength > MAX_DOCUMENT_BYTES || !isPdf(pdf)) {
    return Response.json({ error: 'The conversion input is not a valid PDF.' }, { status: 400 });
  }

  const directory = await mkdtemp(join(tmpdir(), 'docuflex-pdf2html-'));
  const inputPath = join(directory, 'document.pdf');
  const outputName = 'document.html';
  const outputPath = join(directory, outputName);
  try {
    await writeFile(inputPath, pdf);
    const converter = await localConverter();
    const converterArgs = [
      '--quiet', '1',
      '--embed', '1',
      '--correct-text-visibility', '0',
      '--dest-dir', directory,
      inputPath,
      outputName
    ];
    if (converter.dataDir) converterArgs.unshift('--data-dir', converter.dataDir);
    await runConverter(converter.binary, converterArgs);
    const outputStats = await stat(outputPath);
    if (!outputStats.size || outputStats.size > MAX_GENERATED_BYTES) throw new Error('Converted HTML exceeded the safe output limit.');
    const html = await readFile(outputPath);
    return Response.json({ htmlBase64: html.toString('base64'), bytes: html.byteLength }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return privateFailure(
      error,
      'pdf2htmlEX conversion',
      detail.includes('ENOENT') ? 'The editable-text converter is not installed on this server.' : 'Could not prepare editable text for this PDF.'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function localConverter() {
  const configured = env.PDF2HTMLEX_BIN?.trim();
  if (configured) {
    return {
      binary: configured,
      dataDir: env.PDF2HTMLEX_DATA_DIR?.trim() || ''
    };
  }
  if (process.platform === 'linux') {
    const bundleRoot = join(process.cwd(), '.pdf2htmlex', 'squashfs-root');
    const bundled = join(bundleRoot, 'AppRun');
    try {
      await access(bundled, constants.X_OK);
      return {
        binary: bundled,
        dataDir: join(bundleRoot, 'usr', 'local', 'share', 'pdf2htmlEX')
      };
    } catch {
      // Development Linux environments may provide pdf2htmlEX on PATH instead.
    }
  }
  return { binary: 'pdf2htmlEX', dataDir: '' };
}

/** @param {string} binary @param {string[]} args */
function runConverter(binary, args) {
  return new Promise((resolve, reject) => {
    const command = boundedCommand(binary, args, 'native');
    const child = spawn(command.binary, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorLog = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (errorLog.length < MAX_CONVERTER_LOG_BYTES) errorLog += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`conversion exceeded ${CONVERSION_TIMEOUT_MS / 1000} seconds`));
    }, CONVERSION_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(undefined);
      else reject(new Error(errorLog.trim() || `converter stopped (${signal ?? `exit ${code ?? 1}`})`));
    });
  });
}
