import { spawn } from 'node:child_process';

const javaEnvironment = {
  ...process.env,
  PDF_BACKEND_HOST: process.env.PDF_BACKEND_HOST ?? '127.0.0.1',
  PDF_BACKEND_PORT: process.env.PDF_BACKEND_PORT ?? '8080',
  JAVA_TOOL_OPTIONS:
    process.env.JAVA_TOOL_OPTIONS ??
    '-Xms64m -XX:MaxRAMPercentage=50 -XX:+ExitOnOutOfMemoryError'
};
const frontendEnvironment = {
  ...process.env,
  BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT ?? String(150 * 1024 * 1024)
};

const backend = spawn(
  'java',
  ['-cp', 'backend/out:backend/lib/pdfbox-app-3.0.3.jar', 'DocuflexPdfServer'],
  { stdio: 'inherit', env: javaEnvironment }
);
const frontend = spawn(process.execPath, ['build'], { stdio: 'inherit', env: frontendEnvironment });
const children = [backend, frontend];
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

for (const [name, child] of [
  ['PDF backend', backend],
  ['SvelteKit frontend', frontend]
]) {
  child.on('error', (error) => {
    console.error(`${name} failed to start:`, error);
    shutdown('SIGTERM');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${name} stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).`);
    shutdown('SIGTERM');
    process.exitCode = code ?? 1;
  });
}
