/** Pinned official release assets: never execute an installer or download mutable latest URLs. */
export const OLLAMA_VERSION = '0.40.13';
/** @type {Record<string,{name:string;size:number;sha256:string}>} */
export const OLLAMA_ASSETS = {
  "ollama-linux-amd64-rocm.tar.zst": {
    "name": "ollama-linux-amd64-rocm.tar.zst",
    "size": 1052345675,
    "sha256": "5b1b0a7a6370755a3472b1fb2a63e569a5b0114acef2a9067047bf8e5d98ecc1"
  },
  "ollama-linux-amd64.tar.zst": {
    "name": "ollama-linux-amd64.tar.zst",
    "size": 1525346571,
    "sha256": "c9490e0f520be21271d969e6703f012268b1d39f8b70dd58854e5bfef7a75bb6"
  },
  "ollama-windows-amd64-rocm.zip": {
    "name": "ollama-windows-amd64-rocm.zip",
    "size": 257076385,
    "sha256": "2ab082d5414d51ef4cd675543c976770743c90e3cad0d9deb540160ae3b25573"
  },
  "ollama-windows-amd64.zip": {
    "name": "ollama-windows-amd64.zip",
    "size": 1601969847,
    "sha256": "7afa38624fa62ee5d8293422d0ab084c1bb4603134c7f4dafce11a033b57cc19"
  }
};

/** CPU architecture chooses the executable; detected GPU vendors choose optional libraries. */
/** @param {string} [platform] @param {string} [arch] */
export function localQwenPlatform(platform = process.platform, arch = process.arch) {
  return (platform === 'darwin' && arch === 'arm64') || (['win32', 'linux'].includes(platform) && arch === 'x64');
}
/** @param {string} platform @param {string} arch @param {string[]} vendors */
export function runtimePlan(platform, arch, vendors = []) {
  if (!localQwenPlatform(platform, arch) || platform === 'darwin') return null;
  const system = platform === 'win32' ? 'windows' : 'linux';
  const extension = platform === 'win32' ? 'zip' : 'tar.zst';
  const rocm = vendors.includes('amd') && !vendors.includes('nvidia');
  const names = [`ollama-${system}-amd64.${extension}`, ...(rocm ? [`ollama-${system}-amd64-rocm.${extension}`] : [])];
  return {id:`${OLLAMA_VERSION}-${platform}-${arch}-${rocm ? 'rocm' : 'standard'}`, binary:platform === 'win32' ? 'ollama.exe' : 'bin/ollama',
    packages:names.map(name => ({...OLLAMA_ASSETS[name],url:`https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${name}`}))};
}
/** /api/ps reports actual weight placement, not GPU utilization or a guessed vendor. */
/** @param {any[]} models */
export function accelerationFromModels(models) {
  const model = models?.find(item => item.name === 'qwen3.5:4b-q4_K_M' || item.model === 'qwen3.5:4b-q4_K_M');
  if (!model) return null;
  const total = Number(model.size), gpu = Number(model.size_vram);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(gpu) || gpu < 0) return {mode:'unknown',label:'GPU use could not be verified.'};
  const percent = Math.min(100,Math.round(gpu / total * 100));
  if (!gpu) return {mode:'cpu',label:'CPU only — GPU is not in use. Check your graphics driver.',gpuBytes:gpu,totalBytes:total,percent:0};
  return {mode:gpu >= total ? 'gpu' : 'mixed',label:gpu >= total ? 'GPU active · model fully on GPU' : `GPU active · ${percent}% of model memory on GPU`,gpuBytes:gpu,totalBytes:total,percent};
}
