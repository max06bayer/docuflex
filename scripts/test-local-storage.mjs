import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
test('sandboxed data/cache use explicit container paths, other desktops keep their locations', () => {
  const source = "import {localDataDirectory,localCacheDirectory} from './src/lib/server/local-storage.js'; console.log(JSON.stringify([localDataDirectory,localCacheDirectory]));";
  const { DOCUFLEX_DATA_DIR, DOCUFLEX_CACHE_DIR, ...clean } = process.env;
  const read = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' }));
  assert.deepEqual(read(clean), [join(homedir(), '.docuflex'), join(homedir(), '.cache', 'docuflex')]);
  assert.deepEqual(read({...clean, DOCUFLEX_DATA_DIR:'/sandbox/container/data', DOCUFLEX_CACHE_DIR:'/sandbox/container/cache'}), ['/sandbox/container/data','/sandbox/container/cache']);
});
