import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_REQUEST_BYTES = 150 * 1024 * 1024;
const COMPRESSION_TIMEOUT_MS = 180_000;
/** @type {Record<string, { dpi: number; quality: number }>} */
const LEVELS = {
  small: { dpi: 72, quality: 35 },
  medium: { dpi: 110, quality: 60 },
  large: { dpi: 150, quality: 82 }
};

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) return Response.json({ error: 'The uploaded PDF is too large.' }, { status: 413 });
  const form = await request.formData();
  const file = form.get('file');
  const levelName = String(form.get('compression') ?? 'large').toLowerCase();
  const level = LEVELS[levelName];
  if (!(file instanceof File) || !file.size) return Response.json({ error: 'Choose a PDF to compress.' }, { status: 400 });
  if (file.size > MAX_REQUEST_BYTES) return Response.json({ error: 'The uploaded PDF is too large.' }, { status: 413 });
  if (!level) return Response.json({ error: 'The selected compression level is not supported.' }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const directory = await mkdtemp(join(tmpdir(), 'docuflex-compress-'));
  const inputPath = join(directory, 'document.pdf');
  const outputPath = join(directory, 'document-compressed.pdf');
  try {
    await writeFile(inputPath, bytes);
    await runProcess(await pdfRendererBinary(), [
      '-jpeg', '-r', String(level.dpi), '-jpegopt', `quality=${level.quality},progressive=y,optimize=y`,
      inputPath, join(directory, 'page')
    ]);
    await runProcess(await pythonBinary(), [
      join(process.cwd(), 'scripts', 'build-compressed-pdf.py'), outputPath, String(level.dpi), directory
    ]);
    const output = await readFile(outputPath);
    const compressed = output.byteLength < bytes.byteLength ? output : bytes;
    return new Response(new Uint8Array(compressed), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="document-compressed.pdf"', 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    console.error('PDF compression failed:', error);
    return Response.json({ error: error instanceof Error ? error.message : 'Could not compress the PDF.' }, { status: 503 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function pdfRendererBinary() {
  const configured = env.PDF_RENDER_BIN?.trim();
  if (configured) return configured;
  return firstExecutable([
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'),
    '/opt/homebrew/bin/pdftoppm', '/opt/local/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm'
  ], 'pdftoppm');
}

async function pythonBinary() {
  const configured = env.DOCUMENT_CONVERTER_PYTHON?.trim();
  if (configured) return configured;
  return firstExecutable([
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
    '/opt/homebrew/bin/python3', '/opt/local/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'
  ], 'python3');
}

/** @param {string[]} candidates @param {string} fallback */
async function firstExecutable(candidates, fallback) {
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return fallback;
}

/** @param {string} binary @param {string[]} args */
function runProcess(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorLog = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PDF compression timed out.')); }, COMPRESSION_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (errorLog.length < 64 * 1024) errorLog += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(undefined);
      else reject(new Error(errorLog.trim() || `Compression process stopped (${signal ?? `exit ${code ?? 1}`}).`));
    });
  });
}
