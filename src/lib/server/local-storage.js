import { homedir } from 'node:os';
import { join } from 'node:path';

// Native sandboxed macOS sets explicit container paths. Other desktop platforms
// retain their existing locations; never derive a macOS container from a name.
export const localDataDirectory = process.env.DOCUFLEX_DATA_DIR || join(homedir(), '.docuflex');
export const localCacheDirectory = process.env.DOCUFLEX_CACHE_DIR || join(homedir(), '.cache', 'docuflex');
