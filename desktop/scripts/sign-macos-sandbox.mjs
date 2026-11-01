import { execFileSync } from 'node:child_process';
import { open, readdir, readFile, mkdtemp, writeFile, rm, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inherited = await readFile(join(desktop, 'src-tauri/HelperEntitlements.plist'), 'utf8');

/** Detect Mach-O file type, including universal binaries, without executing it. */
export async function machType(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(32);
    if ((await file.read(header, 0, 32, 0)).bytesRead < 16) return 0;
    let offset = 0;
    const magic = header.readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      offset = magic === 0xcafebabf ? Number(header.readBigUInt64BE(16)) : header.readUInt32BE(16);
      if ((await file.read(header, 0, 32, offset)).bytesRead < 16) return 0;
    }
    if ([0xfeedface, 0xfeedfacf].includes(header.readUInt32LE(0))) return header.readUInt32LE(12);
    if ([0xfeedface, 0xfeedfacf].includes(header.readUInt32BE(0))) return header.readUInt32BE(12);
    return 0;
  } finally { await file.close(); }
}

export async function signSandboxApp(appPath, identity = process.env.APPLE_SIGNING_IDENTITY || '-') {
  if (process.platform !== 'darwin') throw new Error('macOS signing must run on a Mac.');
  const app = resolve(appPath);
  const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const main = join(app, 'Contents/MacOS', executableName);
  // Tauri's resource glob dereferences links. Restore the staged topology so
  // framework versions and library aliases remain genuine macOS bundles.
  const resourceSource = join(desktop, 'src-tauri/resources');
  const resourceTarget = join(app, 'Contents/Resources/resources');
  async function restoreLinks(source, target) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isSymbolicLink()) {
        const link = await readlink(from);
        const resolved = resolve(dirname(from), link);
        if (!resolved.startsWith(resourceSource + '/')) throw new Error(`Runtime symlink escapes the resource bundle: ${from}`);
        await rm(to, { recursive: true, force: true });
        await symlink(link, to);
      } else if (entry.isDirectory()) await restoreLinks(from, to);
    }
  }
  await restoreLinks(resourceSource, resourceTarget);
  const files = [];
  const bundles = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        if (/\.(app|framework|xpc)$/.test(entry.name)) bundles.push(path);
      } else if (entry.isFile()) {
        const type = await machType(path);
        if (type) files.push({ path, type });
      }
    }
  }
  await walk(app);
  const temporary = await mkdtemp(join(tmpdir(), 'docuflex-sign-'));
  const entitlementFiles = new Map();
  async function helperEntitlements(path) {
    // Only the interpreter executables need these hardened-runtime exceptions.
    // get-task-allow/debugger and broad sandbox exceptions are never retained.
    const name = basename(path);
    const java = name === 'java';
    const node = name === 'node';
    const office = ['soffice', 'unopkg'].includes(name);
    const python = /^python(?:\d+(?:\.\d+)?)?$/i.test(name);
    const extras = [
      ...(java || node || office ? ['com.apple.security.cs.allow-jit'] : []),
      ...(java || office ? ['com.apple.security.cs.allow-unsigned-executable-memory'] : []),
      // Ad-hoc signatures have no Team ID for same-team library validation.
      // Real-identity builds need this exception only for Python extensions.
      // Optional translation wheels contain native Python extensions. They
      // remain sandboxed; downloaded-code/store eligibility is a separate gate.
      ...((python || identity === '-') ? ['com.apple.security.cs.disable-library-validation'] : [])
    ];
    const key = extras.join(',');
    if (!entitlementFiles.has(key)) {
      const file = join(temporary, `helper-${entitlementFiles.size}.plist`);
      await writeFile(file, inherited.replace('</dict>', extras.map(key => `<key>${key}</key><true/>`).join('') + '</dict>'));
      entitlementFiles.set(key, file);
    }
    return entitlementFiles.get(key);
  }
  const timestamp = identity === '-' ? '--timestamp=none' : '--timestamp';
  function sign(path, entitlements, hardened = false) {
    execFileSync('codesign', ['--force', '--sign', identity, timestamp,
      ...(hardened ? ['--options', 'runtime'] : []),
      ...(entitlements ? ['--entitlements', entitlements] : []), path], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  try {
    for (const { path, type } of files) {
      if (path === main) continue;
      sign(path, type === 2 ? await helperEntitlements(path) : null, type === 2);
    }
    // Children before their enclosing bundle, then the outer application last.
    for (const bundle of bundles) {
      if (bundle.endsWith('.framework')) sign(bundle, null);
      else {
        const executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
        sign(bundle, await helperEntitlements(join(bundle, 'Contents/MacOS', executable)), true);
      }
    }
    sign(app, join(desktop, 'src-tauri/Entitlements.plist'), true);
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`Sandbox signed and verified: ${files.length} Mach-O files, ${bundles.length} nested bundles.`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass the built .app path.');
  await signSandboxApp(process.argv[2]);
}
