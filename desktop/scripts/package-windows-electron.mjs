// Builds the Windows installer around the Electron shell (desktop/electron).
//
//   npm run stage                         (stages src-tauri/resources, icons)
//   node scripts/package-windows-electron.mjs
//
// The staged offline resources (Node, Java, Python, OCR, pdf2htmlEX, Office,
// Tectonic, frontend, backend) are the same as the Tauri build's; only the
// window runs in Chromium instead of WebView2. Output:
//   desktop/electron-dist/Docuflex_<version>_x64-setup.exe
// The "-setup.exe" suffix is what the in-app updater looks for.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The Windows installer must be built on Windows.');

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shellSource = join(desktopRoot, 'electron');
const resources = join(desktopRoot, 'src-tauri', 'resources');
const icon = join(desktopRoot, 'src-tauri', 'icons', 'icon.ico');
const appStage = join(desktopRoot, '.electron-app');
const output = join(desktopRoot, 'electron-dist');

for (const required of [join(resources, 'RUNTIME.json'), join(resources, 'runtime', 'java', 'bin', 'java.exe'), icon]) {
  try { await access(required); } catch { throw new Error(`Missing ${required}. Run \`npm run stage\` in desktop/ first.`); }
}

const desktopPackage = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
const shellPackage = JSON.parse(await readFile(join(shellSource, 'package.json'), 'utf8'));
const version = desktopPackage.version;
const electronVersion = shellPackage.devDependencies.electron;

const npm = process.env.npm_execpath;
const runNpm = (/** @type {string[]} */ args) => npm
  ? execFileSync(process.execPath, [npm, ...args], { stdio: 'inherit' })
  : execFileSync('npm.cmd', args, { stdio: 'inherit', shell: true });
// Locally, a running dev shell (`npx electron .` in desktop/electron) locks
// electron.exe, so reinstall only on CI or when the builder is missing.
let installed = true;
try { await access(join(shellSource, 'node_modules', 'electron-builder', 'package.json')); } catch { installed = false; }
if (process.env.CI || !installed) runNpm(['ci', '--prefix', shellSource, '--no-audit', '--no-fund']);

// The packaged app holds only the shell; electron-builder adds Electron itself.
await rm(appStage, { recursive: true, force: true });
await mkdir(appStage, { recursive: true });
for (const file of ['main.cjs', 'preload.cjs', 'icon.png']) await cp(join(shellSource, file), join(appStage, file));
await cp(join(desktopRoot, 'runtime', 'chrome.js'), join(appStage, 'chrome.js'));
await cp(icon, join(appStage, 'icon.ico'));
await writeFile(join(appStage, 'package.json'), `${JSON.stringify({
  name: 'docuflex-desktop',
  productName: 'Docuflex',
  version,
  description: 'Docuflex offline PDF editor',
  author: 'Maximilian Bayer',
  license: 'AGPL-3.0-only',
  private: true,
  main: 'main.cjs'
}, null, 2)}\n`);

const require = createRequire(join(shellSource, 'package.json'));
const builder = require('electron-builder');
await rm(output, { recursive: true, force: true });
await builder.build({
  targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
  config: {
    appId: 'com.docuflex.editor',
    productName: 'Docuflex',
    executableName: 'docuflex-desktop',
    copyright: 'Copyright © Maximilian Bayer',
    electronVersion,
    directories: { app: appStage, output },
    files: ['**/*'],
    asar: true,
    // 2 GB of runtimes stay plain files next to the app, like the Tauri build.
    extraResources: [{ from: resources, to: 'docuflex/resources', filter: ['**/*'] }],
    // .pdf is registered by installer.nsh (customInstall) with a named ProgId.
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
      shortcutName: 'Docuflex',
      uninstallDisplayName: 'Docuflex',
      installerIcon: icon,
      uninstallerIcon: icon,
      include: join(shellSource, 'installer.nsh'),
      artifactName: 'Docuflex_${version}_x64-setup.${ext}'
    },
    publish: null
  }
});
console.log(`Windows installer written to ${output}`);
