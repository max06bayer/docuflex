import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCli = join(desktopRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const desktopOrigin = `http://127.0.0.1:${process.env.DOCUFLEX_VARIANT === 'redesign' ? 43137 : 43127}`;
const frontendConfig = readFileSync(join(desktopRoot, 'src-tauri', 'resources', 'frontend', 'adapter-node.js'), 'utf8');
if (!frontendConfig.includes(`export const origin = ${JSON.stringify(desktopOrigin)};`)) {
  throw new Error(`The staged frontend is missing the desktop origin ${desktopOrigin}. Run npm run stage before bundling.`);
}

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
        join(desktopRoot, 'src-tauri', 'resources', 'runtime', 'java', 'lib'),
        join(desktopRoot, 'src-tauri', 'resources', 'runtime', 'java', 'lib', 'server'),
        process.env.LD_LIBRARY_PATH
      ].filter(Boolean).join(':')
    }
  : process.platform === 'darwin'
    // macOS 27 rejects stripped Rust macro libraries with misaligned LINKEDIT metadata.
    ? { ...process.env, CARGO_PROFILE_RELEASE_STRIP: 'none', CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP: 'none' }
    : process.env;

// DOCUFLEX_VARIANT=redesign builds "Docuflex Redesign": its own bundle id and ports, so it installs and runs next to Docuflex.
const variantArguments = process.env.DOCUFLEX_VARIANT === 'redesign'
  ? ['--config', join(desktopRoot, 'src-tauri', 'tauri.redesign.conf.json'), '--features', 'side-by-side']
  : [];

execFileSync(process.execPath, [tauriCli, 'build', '--verbose', '--bundles', bundles.join(','), ...variantArguments], {
  cwd: desktopRoot,
  env: buildEnvironment,
  stdio: 'inherit'
});
