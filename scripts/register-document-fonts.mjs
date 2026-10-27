import { execFileSync } from 'node:child_process';
import { mkdir, lstat, readlink, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Register the same redistributable faces used by the conversion engine with
// Linux LibreOffice. Production uses a fresh, unprivileged HOME on each boot.
export async function registerDocumentFonts() {
  if (process.platform !== 'linux') return;
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
