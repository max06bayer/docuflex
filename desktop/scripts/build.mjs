import { distributionProfile } from './distribution.mjs';
import { inspectStoreResources, assertStoreSigning } from './check-app-store.mjs';
import { signSandboxApp } from './sign-macos-sandbox.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCli = join(desktopRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const profile = distributionProfile();
let signingIdentity;
if (profile.store) {
  const issues = await inspectStoreResources(profile.resources);
  if (issues.length) throw new Error(issues.map(issue => issue.message).join('\n'));
  signingIdentity = profile.localQa ? '-' : assertStoreSigning();
  // tauri-build copies resources next to the executable before bundling. Clear
  // the previous copy so replaced runtime notices cannot leave read-only files.
  await rm(join(profile.target, 'release/resources'), {recursive: true, force: true});
}
const desktopOrigin = `http://127.0.0.1:${profile.port}`;
const frontendConfig = readFileSync(join(profile.resources, 'frontend', 'adapter-node.js'), 'utf8');
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

if (profile.store) {
  buildEnvironment.CARGO_TARGET_DIR = profile.target;
  buildEnvironment.APPLE_SIGNING_IDENTITY = signingIdentity;
  // Store uploads are validated by App Store Connect, not Developer ID notarization.
  for (const key of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']) delete buildEnvironment[key];
}

// DOCUFLEX_VARIANT=redesign builds "Docuflex Redesign": its own bundle id and ports, so it installs and runs next to Docuflex.
const storeOverrides = {bundle:{macOS:{signingIdentity, bundleVersion: process.env.DOCUFLEX_STORE_BUILD_NUMBER || '1'}}};
if (profile.localQa) {
  storeOverrides.identifier = 'com.docuflex.editor.storeqa';
  const security = JSON.parse(readFileSync(join(desktopRoot, 'src-tauri/tauri.appstore.conf.json'), 'utf8')).app.security;
  security.capabilities[0].remote.urls = [`http://127.0.0.1:${profile.port}/*`];
  storeOverrides.app = {security};
}
const variantArguments = profile.store
  ? ['--config', join(desktopRoot, 'src-tauri/tauri.appstore.conf.json'), '--features', profile.localQa ? 'mac-app-store,side-by-side' : 'mac-app-store',
     '--config', JSON.stringify(storeOverrides)]
  : process.env.DOCUFLEX_VARIANT === 'redesign'
  ? ['--config', join(desktopRoot, 'src-tauri', 'tauri.redesign.conf.json'), '--features', 'side-by-side']
  : [];

execFileSync(process.execPath, [tauriCli, 'build', '--verbose', '--bundles', bundles.join(','), ...variantArguments], {
  cwd: desktopRoot,
  env: buildEnvironment,
  stdio: 'inherit'
});

if (process.platform === 'darwin') {
  const product = process.env.DOCUFLEX_VARIANT === 'redesign' ? 'Docuflex Redesign' : 'Docuflex';
  const target = profile.target;
  await signSandboxApp(join(target, 'release/bundle/macos', `${product}.app`), signingIdentity, {resourcesRoot: profile.resources, appStore: profile.store});
  if (profile.localQa) console.log('Local Store QA build only: ad-hoc signed, not suitable for App Store upload.');
}
