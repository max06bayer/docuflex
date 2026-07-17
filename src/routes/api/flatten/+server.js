import { env } from '$env/dynamic/private';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const MAX_REQUEST_BYTES = 150 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 300 * 1024 * 1024;
const FLATTEN_TIMEOUT_MS = 10 * 60 * 1000;
/** @type {Promise<string> | undefined} */
let runtimePromise;

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) return Response.json({ error: 'The uploaded PDF is too large.' }, { status: 413 });
  const form = await request.formData();
  const file = form.get('file');
  const method = String(form.get('method') ?? 'standard').toLowerCase();
  if (!(file instanceof File) || !file.size) return Response.json({ error: 'Choose a PDF to flatten.' }, { status: 400 });
  if (file.size > MAX_REQUEST_BYTES) return Response.json({ error: 'The uploaded PDF is too large.' }, { status: 413 });
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return Response.json({ error: 'Only PDF files can be flattened.' }, { status: 400 });
  if (method !== 'standard' && method !== 'rasterize') return Response.json({ error: 'The selected flatten method is not supported.' }, { status: 400 });

  const directory = await mkdtemp(join(tmpdir(), 'docuflex-flatten-'));
  const inputPath = join(directory, 'document.pdf');
  const outputPath = join(directory, method === 'rasterize' ? 'document-rasterized.pdf' : 'document-flattened.pdf');
  try {
    await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));
    const python = await pythonBinary();
    const runtime = await ensurePdfRuntime(python);
    await runProcess(python, [
      join(process.cwd(), 'scripts', 'flatten-pdf.py'), inputPath, outputPath, method
    ], {
      ...process.env,
      PYTHONPATH: [runtime, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
    });
    const outputStats = await stat(outputPath);
    if (!outputStats.size || outputStats.size > MAX_OUTPUT_BYTES) throw new Error('The flattened PDF is too large.');
    const output = await readFile(outputPath);
    return new Response(new Uint8Array(output), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="document-${method === 'rasterize' ? 'rasterized' : 'flattened'}.pdf"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    console.error('PDF flattening failed:', error);
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: detail }, { status: 503 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** @param {string} python */
async function ensurePdfRuntime(python) {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const configured = env.PDF_TOOLS_PYTHONPATH?.trim();
    if (configured) return configured;
    const translationRuntime = join(homedir(), '.cache', 'docuflex', 'translate-python');
    try {
      await access(join(translationRuntime, 'fitz', '__init__.py'), constants.R_OK);
      return translationRuntime;
    } catch {}
    const runtime = join(homedir(), '.cache', 'docuflex', 'pdf-tools-python');
    try {
      await access(join(runtime, 'fitz', '__init__.py'), constants.R_OK);
      return runtime;
    } catch {}
    await mkdir(runtime, { recursive: true });
    await runProcess(python, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--upgrade',
      '--target', runtime, 'PyMuPDF>=1.26,<2'
    ], process.env);
    return runtime;
  })().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

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
    const child = spawn(binary, args, { env: processEnv, stdio: ['ignore', 'ignore', 'pipe'] });
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
      finish(() => reject(new Error('PDF flattening timed out.')));
    }, FLATTEN_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (errorLog.length < 64 * 1024) errorLog += chunk; });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code, signal) => finish(() => {
      if (code === 0) resolve(undefined);
      else reject(new Error(errorLog.trim() || `Flattening process stopped (${signal ?? `exit ${code ?? 1}`}).`));
    }));
  });
}
