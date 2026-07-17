import { env } from '$env/dynamic/private';

const PROFILES = {
  native: { addressSpace: 1536 * 1024 * 1024, cpuSeconds: 600, fileBytes: 350 * 1024 * 1024, processes: 64 },
  ocr: { addressSpace: 2048 * 1024 * 1024, cpuSeconds: 900, fileBytes: 350 * 1024 * 1024, processes: 64 },
  translation: { addressSpace: 2560 * 1024 * 1024, cpuSeconds: 1800, fileBytes: 350 * 1024 * 1024, processes: 64 }
};

/**
 * Keep untrusted document parsers inside per-process operating-system limits on Linux.
 * macOS development uses the original executable so local behavior remains unchanged.
 * @param {string} binary
 * @param {string[]} args
 * @param {'native' | 'ocr' | 'translation'} [profileName]
 */
export function boundedCommand(binary, args, profileName = 'native') {
  if (process.platform !== 'linux' || env.DISABLE_DOCUMENT_PRLIMIT === '1') return { binary, args };
  const profile = PROFILES[profileName];
  return {
    binary: env.DOCUMENT_PRLIMIT_BIN?.trim() || 'prlimit',
    args: [
      `--as=${profile.addressSpace}`,
      `--cpu=${profile.cpuSeconds}`,
      `--fsize=${profile.fileBytes}`,
      `--nproc=${profile.processes}`,
      '--',
      binary,
      ...args
    ]
  };
}
