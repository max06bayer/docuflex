<script>
  import ModelLabel from '#lib/ModelLabel.svelte';
  import { openQwenDownload } from '#lib/qwen-download.js';
  /** @type {{id: string; name: string; short?: string; free?: boolean; local?: boolean; downloadable?: boolean; ready?: boolean}} */
  export let model;
  export let selected = false;
  /** @type {(id: string) => void} */
  export let onSelect = () => {};
</script>
<div class="model-option-row" role="none">
  <button class="model-option-select" class:active={selected} role="menuitemradio" aria-checked={selected} type="button" onclick={(event) => { event.stopPropagation(); onSelect(model.id); }}><ModelLabel {model} {selected} /></button>
  {#if model.downloadable && !model.ready}
    <button class="model-download-button" role="menuitem" type="button" title="Download Qwen 3.5 4B · about 3.3 GB" aria-label="Download Qwen 3.5 4B" onclick={(event) => { event.stopPropagation(); void openQwenDownload(); }}>Download</button>
  {/if}
</div>
<style>
  .model-option-row { display: flex; align-items: center; gap: 3px; min-width: 0; }
  .model-option-select { display: flex; align-items: center; flex: 1; min-width: 0; height: 38px; padding: 0 9px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: rgba(0, 0, 0, 0.75); font: inherit; font-size: 16px; text-align: left; cursor: pointer; }
  .model-option-select:hover { background: rgba(0, 0, 0, 0.04); }
  .model-option-select.active { background: rgba(0, 0, 0, 0.06); }
  .model-download-button { display: grid; place-items: center; width: auto; height: 38px; padding: 0 9px; font: inherit; font-size: 16px; flex: none; border: 0; border-radius: 9px; background: transparent; color: #0878f9; cursor: pointer; }
  .model-download-button:hover { background: rgba(8, 120, 249, 0.1); }
  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .model-option-select { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .model-option-select:hover { background: rgba(255, 255, 255, 0.06); }
  :global(:root[data-theme="dark"]) .model-option-select.active { background: rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .model-download-button { color: #69b2ff; }
  /* dark theme: end manual */
</style>
