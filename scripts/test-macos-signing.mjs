import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machType } from '../desktop/scripts/sign-macos-sandbox.mjs';
test('bundle signer recognises thin/universal executables versus dylibs and ordinary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docuflex-mach-sign-'));
  try {
    const executable = Buffer.alloc(32);
    executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(2, 12);
    const library = Buffer.from(executable); library.writeUInt32LE(6, 12);
    const universal = Buffer.alloc(4096 + 32);
    universal.writeUInt32BE(0xcafebabe, 0); universal.writeUInt32BE(1,4); universal.writeUInt32BE(4096,16); executable.copy(universal,4096);
    for(const [name, data, expected] of [['node',executable,2],['library',library,6],['universal',universal,2],['ordinary',Buffer.from('ordinary text that is not executable code'),0]]) {
      const path = join(directory,name); await writeFile(path,data); assert.equal(await machType(path),expected,name);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});
