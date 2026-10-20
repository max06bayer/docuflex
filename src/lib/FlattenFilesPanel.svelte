<script>
  import { onDestroy } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';

  /** @type {() => void} */
  export let onClose = () => {};

  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {File | null} */
  let inputFile = null;
  /** @type {'standard' | 'rasterize'} */
  let method = 'standard';
  let flattening = false;

  function chooseFile() {
    fileInput?.click();
  }

  /** @param {Event} event */
  function handleFile(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      window.alert('Choose a PDF file to flatten.');
      return;
    }
    inputFile = file;
  }

  async function flattenFile() {
    if (!inputFile || flattening) return;
    flattening = true;
    try {
      const form = new FormData();
      form.set('file', inputFile);
      form.set('method', method);
      const response = await fetch('/api/flatten', { method: 'POST', body: form });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `Flattening failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${inputFile.name.replace(/\.pdf$/i, '') || 'document'}-${method === 'rasterize' ? 'rasterized' : 'flattened'}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not flatten this PDF.');
    } finally {
      flattening = false;
    }
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') onClose();
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', handleKeydown);
  onDestroy(() => window.removeEventListener('keydown', handleKeydown));
</script>

<div class="flatten-panel" role="dialog" aria-label="Flatten" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/quicktools/flatten.svg" alt="" />
    <h2>Flatten</h2>
    <button class="panel-close" type="button" aria-label="Close Flatten" onclick={onClose}><span></span><span></span></button>
  </header>

  <div class="flatten-content">
    <button class="upload-file" type="button" disabled={flattening} onclick={chooseFile}>
      {#if !inputFile}<span class="action-plus" aria-hidden="true"></span>{/if}
      <span>{inputFile ? inputFile.name : 'Upload File'}</span>
    </button>
    <div class="method-setting">
      <span>Flatten Method</span>
      <div class="method-options" role="group" aria-label="Flatten method">
        <button class:active={method === 'standard'} type="button" aria-pressed={method === 'standard'} onclick={() => method = 'standard'}>Standard</button>
        <button class:active={method === 'rasterize'} type="button" aria-pressed={method === 'rasterize'} onclick={() => method = 'rasterize'}>Rasterize</button>
      </div>
    </div>
  </div>

  <footer class="flatten-actions">
    <button class="flatten-submit" type="button" disabled={!inputFile || flattening} onclick={flattenFile}>
      <img src="/quicktools/flatten.svg" alt="" />
      <span>{flattening ? (method === 'rasterize' ? 'Rasterizing…' : 'Flattening…') : (method === 'rasterize' ? 'Rasterize' : 'Flatten')}</span>
    </button>
  </footer>
  <input bind:this={fileInput} class="file-input" type="file" accept="application/pdf,.pdf" onchange={handleFile} />
</div>

<style>
  /* Matches the redesign panels (TranslateFilesPanel, SettingsPanel, PdfEditor .protect-panel). */
  .flatten-panel { position: absolute; z-index: 45; top: 12px; left: 13px; display: grid; box-sizing: border-box; width: min(320px, calc(100% - 26px)); border: 1.5px solid #c3c2c2; border-radius: 21px; background: rgba(240, 236, 236, 0.75); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); backdrop-filter: blur(1.3px); -webkit-backdrop-filter: blur(1.3px); color: #000; font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 19px; letter-spacing: -0.19px; -webkit-font-smoothing: antialiased; }
  .panel-header { display: grid; grid-template-columns: 24px 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 14px 0 15px; border-bottom: 1.5px solid #c3c2c2; border-radius: 19.5px 19.5px 0 0; background: rgba(214, 214, 214, 0.75); }
  .panel-header > img { width: 24px; height: 24px; object-fit: contain; }
  .panel-header h2 { margin: 0 0 0 8px; overflow: hidden; font-size: 20px; font-weight: 400; line-height: 1.22; letter-spacing: -0.2px; text-overflow: ellipsis; white-space: nowrap; }
  .panel-close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; cursor: pointer; transition: transform 160ms ease, filter 160ms ease; }
  .panel-close span { display: none; }
  .panel-close:hover { filter: brightness(0); }
  .panel-close:active { transform: scale(0.94); }
  .flatten-content { display: grid; gap: 14px; padding: 15px 11px 16px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .upload-file { display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; letter-spacing: inherit; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 160ms ease; }
  .upload-file:hover:not(:disabled) { border-color: rgba(0, 0, 0, 0.18); color: rgba(0, 0, 0, 0.75); }
  .upload-file:active { transform: scale(0.985); }
  .upload-file span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%, -50%); }
  .action-plus::after { transform: translate(-50%, -50%) rotate(90deg); }
  .method-setting { display: grid; gap: 8px; color: rgba(0, 0, 0, 0.5); }
  .method-setting > span { padding-left: 2px; }
  .method-options { display: grid; grid-template-columns: repeat(2, 1fr); box-sizing: border-box; height: 48px; padding: 4px; gap: 4px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; }
  .method-options button { padding: 0 8px; border: 0; border-radius: 11px; background: transparent; color: rgba(0, 0, 0, 0.5); font: inherit; letter-spacing: inherit; cursor: pointer; transition: color 170ms ease, background-color 220ms cubic-bezier(0.22, 1, 0.36, 1); }
  .method-options button:hover { color: #000; }
  .method-options button.active { background: #111; color: #fff; }
  .flatten-actions { display: grid; padding: 15px 11px 15px 12px; }
  .flatten-submit { display: flex; align-items: center; justify-content: center; gap: 10px; box-sizing: border-box; width: 100%; min-width: 0; height: 48px; padding: 0 17px; border: 1px solid #111; border-radius: 15px; background: #111; color: #fff; font: inherit; letter-spacing: inherit; cursor: pointer; transition: opacity 150ms ease, background-color 150ms ease, transform 160ms ease; }
  .flatten-submit:active { transform: scale(0.97); }
  .flatten-submit img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .flatten-submit:disabled, .upload-file:disabled { cursor: default; opacity: 0.35; }
  .file-input { display: none; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .flatten-panel { border: 1.5px solid #4c4c4c; background: rgba(41, 41, 41, 0.97); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); color: #ffffff; }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #4c4c4c; background: rgba(35, 35, 35, 0.97); }
  :global(:root[data-theme="dark"]) .panel-close { filter: invert(1); }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .flatten-content { border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  :global(:root[data-theme="dark"]) .upload-file { border: 1px solid rgba(255, 255, 255, 0.1); background: #2e2e2e; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .upload-file:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.18); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .method-setting { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .method-options { border: 1px solid rgba(255, 255, 255, 0.1); background: #2e2e2e; }
  :global(:root[data-theme="dark"]) .method-options button { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .method-options button:hover { color: #ffffff; }
  :global(:root[data-theme="dark"]) .method-options button.active { background: #f0f0f0; color: #000000; }
  :global(:root[data-theme="dark"]) .flatten-submit { border: 1px solid #efefef; background: #f0f0f0; color: #000000; }
  :global(:root[data-theme="dark"]) .flatten-submit img { filter: brightness(0); }
  /* dark theme: end generated */

</style>
