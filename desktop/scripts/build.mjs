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
const buildEnvironment = process.platform === 'linux'
  ? {
      ...process.env,
      NO_STRIP: '1',
      LD_LIBRARY_PATH: [
        join(desktopRoot, 'src-tauri', 'resources', 'runtime', 'java', 'lib', 'server'),
        process.env.LD_LIBRARY_PATH
      ].filter(Boolean).join(':')
    }
  : process.env;

execFileSync(process.execPath, [tauriCli, 'build', '--verbose', '--bundles', bundles.join(',')], {
  cwd: desktopRoot,
  env: buildEnvironment,
  stdio: 'inherit'
});
