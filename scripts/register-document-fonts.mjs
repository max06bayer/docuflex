import { execFileSync } from 'node:child_process';
import { access, mkdir, lstat, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Register the same redistributable faces used by the conversion engine with
// Linux LibreOffice. Production uses a fresh, unprivileged HOME on each boot.
export async function registerDocumentFonts() {
  if (process.platform !== 'linux') return;
  if (!process.env.FONTCONFIG_FILE) {
    // Nix supplies fontconfig outside /etc; the unprivileged server must
    // inherit its actual config so Office can find the registered fonts.
    try {
      const cacheBinary = await realpath(execFileSync('which', ['fc-cache'], { encoding: 'utf8' }).trim());
      const candidates = [join(dirname(cacheBinary), '..', 'etc', 'fonts', 'fonts.conf')];
      const linkage = execFileSync('ldd', [cacheBinary], { encoding: 'utf8' });
      const nixLibrary = linkage.match(/(\/nix\/store\/[^\s/]+)\/lib\/libfontconfig\.so/);
      if (nixLibrary) candidates.unshift(join(nixLibrary[1], 'etc', 'fonts', 'fonts.conf'));
      for (const config of candidates) {
        try {
          await access(config);
          process.env.FONTCONFIG_FILE = config;
          break;
        } catch { /* Try the next installed configuration. */ }
      }
    } catch {
      // Conventional distributions already provide /etc/fonts/fonts.conf.
    }
  }
  const directory = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'fonts');
  const destination = join(directory, 'docuflex');
  const source = resolve('backend/fonts');
  await mkdir(directory, { recursive: true });
  try {
    const existing = await lstat(destination);
    if (!existing.isSymbolicLink()) throw new Error(`Expected a font symlink at ${destination}`);
    if (await readlink(destination) !== source) {
      await unlink(destination);
      await symlink(source, destination);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(source, destination);
  }
  execFileSync('fc-cache', ['-f', destination], { stdio: 'inherit' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await registerDocumentFonts();
}
