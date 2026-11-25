import { get, writable } from 'svelte/store';
import { translationStatus, translationLanguageLabel } from '#lib/translate.js';
/** @typedef {{visible: boolean; source: string; target: string; label: string; phase: string; received: number; total: number; speed: number; size: number; error: string}} DownloadState */
/** @type {import('svelte/store').Writable<DownloadState>} */
export const translationDownload = writable({visible:false, source:'en', target:'de', label:'English → German', phase:'available', received:0, total:0, speed:0, size:0, error:''});
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
let generation = 0;
const active = (/** @type {string} */ phase) => ['preparing', 'downloading', 'installing', 'checking'].includes(phase);

/** @param {import('#lib/translate.js').TranslationStatus} status */
function apply(status) {
  const download = status.download;
  translationDownload.update(state => {
    const pair = download && active(download.phase) ? download.pair?.split('-') : null;
    const source = pair?.[0] || state.source;
    const target = pair?.[1] || state.target;
    const samePair = source === state.source && target === state.target;
    return {...state, source, target, label:`${translationLanguageLabel(source)} → ${translationLanguageLabel(target)}`,
      phase: samePair && status.modelReady ? 'ready' : download?.phase === 'failed' ? 'error' : download?.phase === 'done' ? 'available' : download?.phase || 'available',
      received:download?.received || 0, total:download?.total || 0, speed:download?.bytesPerSecond || 0, size:status.downloadBytes || 0, error:download?.error || ''};
  });
  const state = get(translationDownload);
  window.dispatchEvent(new CustomEvent('docuflex:translation-status', {detail:{source:state.source,target:state.target,status}}));
}
async function poll() {
  clearTimeout(timer);
  const current = generation;
  const {source,target} = get(translationDownload);
  try {
    const status = await translationStatus(source,target);
    if (current !== generation) return;
    apply(status);
    if (active(get(translationDownload).phase)) timer = setTimeout(poll,750);
  } catch (error) {
    if (current === generation) translationDownload.update(state => ({...state,phase:'error',error:error instanceof Error ? error.message : 'Could not check the download.'}));
  }
}
/** @param {string} source @param {string} target */
export async function openTranslationDownload(source,target) {
  if (!active(get(translationDownload).phase)) {
    generation += 1;
    translationDownload.update(state => ({...state,source,target,label:`${translationLanguageLabel(source)} → ${translationLanguageLabel(target)}`,visible:true,phase:'checking',error:''}));
  } else translationDownload.update(state => ({...state,visible:true}));
  await poll();
}
export async function downloadTranslationModel() {
  const {source,target,phase} = get(translationDownload);
  if (active(phase)) return;
  const current = ++generation;
  translationDownload.update(state => ({...state,phase:'preparing',error:'',visible:true}));
  try {
    const status = await translationStatus(source,target,'POST');
    if (current !== generation) return;
    apply(status);
    await poll();
  } catch (error) {
    if (current === generation) translationDownload.update(state => ({...state,phase:'error',error:error instanceof Error ? error.message : 'Could not start the download.'}));
  }
}
export function dismissTranslationDownload() { translationDownload.update(state=>({...state,visible:false})); }
