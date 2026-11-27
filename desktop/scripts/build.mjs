import { distributionProfile } from './distribution.mjs';
import { inspectStoreResources, assertStoreSigning } from './check-app-store.mjs';
import { signSandboxApp } from './sign-macos-sandbox.mjs';
import { assertInstallerIdentity, buildStorePackage, identityTeam, prepareStoreSigning, readProvisioningProfile } from './app-store-package.mjs';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  if (!profile.localQa) {
    // Check the upload requirements before the long build, not after it.
    const provisioning = process.env.DOCUFLEX_PROVISIONING_PROFILE;
    if (!provisioning) throw new Error('Set DOCUFLEX_PROVISIONING_PROFILE to the Mac App Store provisioning profile for com.docuflex.editor.');
    const {team} = readProvisioningProfile(provisioning);
    if (identityTeam(signingIdentity) !== team) throw new Error('The signing identity and provisioning profile belong to different teams.');
    if (identityTeam(assertInstallerIdentity(process.env.APPLE_INSTALLER_IDENTITY)) !== team) throw new Error('The installer identity and provisioning profile belong to different teams.');
    if (!/^\d+(\.\d+){0,2}$/.test(process.env.DOCUFLEX_STORE_BUILD_NUMBER || '')) throw new Error('Set DOCUFLEX_STORE_BUILD_NUMBER to a number higher than every earlier upload.');
  }
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
  const app = join(target, 'release/bundle/macos', `${product}.app`);
  installLayeredIcon(app);
  const store = profile.store && !profile.localQa
    ? await prepareStoreSigning(app, process.env.DOCUFLEX_PROVISIONING_PROFILE, signingIdentity, join(desktopRoot, 'src-tauri/Entitlements.plist'))
    : null;
  try {
    await signSandboxApp(app, signingIdentity, {resourcesRoot: profile.resources, appStore: profile.store, entitlements: store?.entitlements});
  } finally { await store?.cleanup(); }
  if (profile.localQa) console.log('Local Store QA build only: ad-hoc signed, not suitable for App Store upload.');
  else if (store) {
    const version = JSON.parse(readFileSync(join(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8')).version;
    const output = join(target, 'release/bundle/macos', `Docuflex_${version}_${process.env.DOCUFLEX_STORE_BUILD_NUMBER}_AppStore.pkg`);
    buildStorePackage(app, output, process.env.APPLE_INSTALLER_IDENTITY || '');
    console.log(`App Store upload package: ${output}`);
  }
}

/**
 * Tauri only bundles the flat icon.icns. The Icon Composer icon
 * (src-tauri/Docuflex.icon) is compiled with actool into Assets.car so macOS
 * 26 draws it with Liquid Glass and its dark, tinted and clear variants; the .icns
 * actool writes beside it stays the fallback. Runs before signing.
 * @param {string} app
 */
function installLayeredIcon(app) {
  const source = join(desktopRoot, 'src-tauri/Docuflex.icon');
  if (!existsSync(source)) return;
  const output = mkdtempSync(join(tmpdir(), 'docuflex-icon-'));
  try {
    execFileSync('xcrun', ['actool', source, '--compile', output, '--app-icon', 'Docuflex',
      '--platform', 'macosx', '--target-device', 'mac', '--minimum-deployment-target', '26.0',
      '--output-partial-info-plist', join(output, 'partial.plist')], { stdio: ['ignore', 'ignore', 'inherit'] });
    const resources = join(app, 'Contents/Resources');
    copyFileSync(join(output, 'Assets.car'), join(resources, 'Assets.car'));
    copyFileSync(join(output, 'Docuflex.icns'), join(resources, 'Docuflex.icns'));
    const plist = join(app, 'Contents/Info.plist');
    execFileSync('plutil', ['-replace', 'CFBundleIconFile', '-string', 'Docuflex', plist]);
    execFileSync('plutil', ['-replace', 'CFBundleIconName', '-string', 'Docuflex', plist]);
    rmSync(join(resources, 'icon.icns'), { force: true });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
