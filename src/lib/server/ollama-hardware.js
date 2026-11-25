import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir} from 'node:fs/promises';
const run = promisify(execFile);
/** @param {string} value */
export function gpuVendor(value) {
  if (/VEN_10DE|0x10de|nvidia/i.test(value)) return 'nvidia';
  if (/VEN_1002|0x1002|\bAMD\b|Radeon/i.test(value)) return 'amd';
  if (/VEN_8086|0x8086|intel/i.test(value)) return 'intel';
  return null;
}
/** Read actual display adapters, never infer GPU type from Intel/AMD CPU names. */
export async function detectGpuVendors(platform = process.platform) {
  const vendors = new Set();
  if (platform === 'win32') {
    try {
      const result = await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID | ConvertTo-Json -Compress'],{timeout:10000,windowsHide:true,maxBuffer:1024*1024});
      const adapters = JSON.parse(result.stdout || '[]');
      for (const adapter of Array.isArray(adapters) ? adapters : [adapters]) { const vendor = gpuVendor(`${adapter.Name} ${adapter.PNPDeviceID}`); if (vendor) vendors.add(vendor); }
    } catch { /* GPU verification after loading remains authoritative. */ }
  } else if (platform === 'linux') {
    try {
      for (const entry of await readdir('/sys/class/drm')) {
        if (!/^card\d+$/.test(entry)) continue;
        const vendor = gpuVendor(await readFile(`/sys/class/drm/${entry}/device/vendor`,'utf8').catch(()=>''));
        if (vendor) vendors.add(vendor);
      }
    } catch {}
    try { const result = await run('nvidia-smi',['--query-gpu=name','--format=csv,noheader'],{timeout:3000,maxBuffer:65536}); if (result.stdout.trim()) vendors.add('nvidia'); } catch {}
  }
  return [...vendors];
}
