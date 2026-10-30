import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '0.40.13';
const sha256 = 'bae29252232b9e1358cf5801a7d65a07442af18fb5467cb68c7fc3711f59c511';
export async function prepareOllamaRuntime(destination) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const cache = resolve(desktop, '.cache', `ollama-v${version}`);
  const archive = resolve(cache, 'ollama-darwin.tgz');
  await mkdir(cache, { recursive: true });
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes) {
    const response = await fetch(`https://github.com/ollama/ollama/releases/download/v${version}/ollama-darwin.tgz`);
    if (!response.ok) throw new Error(`Ollama runtime download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Ollama runtime checksum mismatch.');
  await writeFile(archive, bytes);
  const extracted = resolve(cache, 'verified');
  await mkdir(extracted, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  await mkdir(destination, { recursive: true });
  await cp(extracted, destination, { recursive: true, verbatimSymlinks: true });
  await cp(resolve(desktop, 'licenses/ollama-LICENSE.txt'), resolve(destination, 'OLLAMA_LICENSE'));
  await writeFile(resolve(destination, 'DOCUFLEX-RUNTIME.json'), JSON.stringify({ version, sha256, source: 'https://github.com/ollama/ollama', model: 'qwen3.5:4b-q4_K_M' }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareOllamaRuntime(resolve(process.argv[2] || resolve(desktop, 'src-tauri/resources/runtime/ollama')));
}
