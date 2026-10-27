import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { updateGeoip } from './update-geoip.mjs';
import { registerDocumentFonts } from './register-document-fonts.mjs';

await registerDocumentFonts();

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
  // Headless Office does not need the Nix wrapper's desktop D-Bus session.
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || 'disabled:',
  SAL_USE_VCLPLUGIN: 'svp',
  SAL_DISABLE_OPENCL: '1',
  PDF_BACKEND_URL:
    process.env.PDF_BACKEND_URL ??
    `http://${javaEnvironment.PDF_BACKEND_HOST}:${javaEnvironment.PDF_BACKEND_PORT}`,
  BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT ?? String(230 * 1024 * 1024),
  ADDRESS_HEADER: process.env.ADDRESS_HEADER ?? 'x-forwarded-for',
  XFF_DEPTH: process.env.XFF_DEPTH ?? '1',
  PROTOCOL_HEADER: process.env.PROTOCOL_HEADER ?? 'x-forwarded-proto',
  HOST_HEADER: process.env.HOST_HEADER ?? 'x-forwarded-host',
  PYTHONPATH: [join(process.cwd(), '.document-python'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  TESSDATA_PREFIX: process.env.TESSDATA_PREFIX ?? join(process.cwd(), '.ocr', 'tessdata')
};

const backend = spawn(
  'java',
  ['-cp', 'backend/out:backend/lib/pdfbox-app-3.0.8.jar', 'DocuflexPdfServer'],
  { stdio: 'inherit', env: javaEnvironment }
);
const frontend = spawn(process.execPath, ['build'], { stdio: 'inherit', env: frontendEnvironment });
const children = [backend, frontend];

// Refresh the analytics GeoIP database in the background; checked daily,
// downloaded at most every 30 days. Failures only affect location fields.
if (process.env.ANALYTICS_ENABLED !== 'false' && process.env.GEOIP_AUTO_UPDATE !== 'false') {
  const refreshGeoip = () => updateGeoip().catch((error) => console.error('GeoIP update failed:', error));
  refreshGeoip();
  setInterval(refreshGeoip, 86_400_000).unref();
}
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
