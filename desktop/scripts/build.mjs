import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCli = join(desktopRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const bundles = process.platform === 'darwin'
  ? ['app']
  : process.platform === 'win32'
    ? ['nsis']
    : ['appimage', 'deb'];

execFileSync(process.execPath, [tauriCli, 'build', '--bundles', bundles.join(',')], {
  cwd: desktopRoot,
  env: process.env,
  stdio: 'inherit'
});
