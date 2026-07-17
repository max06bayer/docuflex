import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_REQUEST_BYTES = 150 * 1024 * 1024;
const MAX_CONVERTER_LOG_BYTES = 64 * 1024;
const CONVERSION_TIMEOUT_MS = 180_000;

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'The PDF conversion request is too large.' }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) {
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

  const directory = await mkdtemp(join(tmpdir(), 'docuflex-pdf2html-'));
  const inputPath = join(directory, 'document.pdf');
  const outputName = 'document.html';
  const outputPath = join(directory, outputName);
  try {
    await writeFile(inputPath, Buffer.from(payload.pdfBase64, 'base64'));
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
    const html = await readFile(outputPath);
    return Response.json({ htmlBase64: html.toString('base64'), bytes: html.byteLength }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    console.error('Local pdf2htmlEX conversion failed:', error);
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({
      error: detail.includes('ENOENT')
        ? 'pdf2htmlEX is not installed. Configure PDF2HTMLEX_BIN or install the bundled local converter.'
        : `pdf2htmlEX conversion failed: ${detail}`
    }, { status: 503 });
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
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
