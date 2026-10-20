<script>
  import { onDestroy } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly, scale } from 'svelte/transition';

  /** @type {() => void} */
  export let onClose = () => {};

  const formats = [
    { id: 'docx', label: 'DOCX' },
    { id: 'doc', label: 'DOC' },
    { id: 'xlsx', label: 'XLSX' },
    { id: 'pdf', label: 'PDF' },
    { id: 'pptx', label: 'PPTX' }
  ];

  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {File | null} */
  let inputFile = null;
  let outputFormat = 'docx';
  let outputMenuOpen = false;
  let converting = false;

  function chooseFile() {
    fileInput?.click();
  }

  /** @param {Event} event */
  function handleFile(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!formats.some((format) => format.id === extension)) {
      window.alert('Choose a DOCX, DOC, XLSX, PDF, or PPTX file.');
      return;
    }
    inputFile = file;
  }

  /** @param {MouseEvent} event */
  function toggleOutputMenu(event) {
    event.stopPropagation();
    outputMenuOpen = !outputMenuOpen;
  }

  /** @param {string} format */
  function selectOutputFormat(format) {
    outputFormat = format;
    outputMenuOpen = false;
  }

  async function convertFile() {
    if (!inputFile || converting) return;
    converting = true;
    try {
      const form = new FormData();
      form.set('file', inputFile);
      form.set('outputFormat', outputFormat);
      const response = await fetch('/api/convert', { method: 'POST', body: form });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `Conversion failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${inputFile.name.replace(/\.[^.]+$/, '') || 'converted'}.${outputFormat}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not convert this file.');
    } finally {
      converting = false;
    }
  }

  /** @param {PointerEvent} event */
  function closeMenu(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.output-picker')) outputMenuOpen = false;
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (outputMenuOpen) outputMenuOpen = false;
    else onClose();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', handleKeydown);
  }

  onDestroy(() => {
    window.removeEventListener('pointerdown', closeMenu);
    window.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="convert-panel" role="dialog" aria-label="Convert Files" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/convert.svg" alt="" />
    <h2>Convert Files</h2>
    <button class="panel-close" type="button" aria-label="Close Convert Files" onclick={onClose}>
      <span></span><span></span>
    </button>
  </header>

  <div class="convert-content">
    <div class="output-picker">
      <button type="button" aria-haspopup="menu" aria-expanded={outputMenuOpen} onclick={toggleOutputMenu}>
        <span>Output File</span>
        <strong>{outputFormat.toUpperCase()}</strong>
      </button>
      {#if outputMenuOpen}
        <div class="output-menu" role="menu" transition:scale={{ duration: 125, easing: cubicOut, start: 0.94, opacity: 0 }}>
          {#each formats as format}
            <button
              class:active={outputFormat === format.id}
              class="output-menu-item"
              role="menuitem"
              type="button"
              onclick={() => selectOutputFormat(format.id)}
            >
              <span>{format.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <footer class="convert-actions">
    <button class="convert-action upload" type="button" disabled={converting} onclick={chooseFile}>
      {#if !inputFile}<span class="action-plus" aria-hidden="true"></span>{/if}
      <span>{inputFile ? inputFile.name : 'Upload File'}</span>
    </button>
    <button class="convert-action primary" type="button" disabled={!inputFile || converting} onclick={convertFile}>
      <img src="/convert.svg" alt="" />
      <span>{converting ? 'Converting…' : 'Convert'}</span>
    </button>
  </footer>

  <input bind:this={fileInput} class="file-input" type="file" accept=".docx,.doc,.xlsx,.pdf,.pptx,application/pdf" onchange={handleFile} />
</div>

<style>
  /* Matches the redesign panels (TranslateFilesPanel, SettingsPanel, PdfEditor .protect-panel). */
  .convert-panel { position: absolute; z-index: 45; top: 12px; left: 13px; display: grid; box-sizing: border-box; width: min(320px, calc(100% - 26px)); border: 1.5px solid #c3c2c2; border-radius: 21px; background: rgba(240, 236, 236, 0.75); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); backdrop-filter: blur(1.3px); -webkit-backdrop-filter: blur(1.3px); color: #000; font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 19px; letter-spacing: -0.19px; -webkit-font-smoothing: antialiased; }
  .panel-header { display: grid; grid-template-columns: 24px 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 14px 0 15px; border-bottom: 1.5px solid #c3c2c2; border-radius: 19.5px 19.5px 0 0; background: rgba(214, 214, 214, 0.75); }
  .panel-header > img { width: 24px; height: 24px; object-fit: contain; }
  .panel-header h2 { margin: 0 0 0 8px; overflow: hidden; font-size: 20px; font-weight: 400; line-height: 1.22; letter-spacing: -0.2px; text-overflow: ellipsis; white-space: nowrap; }
  .panel-close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; cursor: pointer; transition: transform 160ms ease, filter 160ms ease; }
  .panel-close span { display: none; }
  .panel-close:hover { filter: brightness(0); }
  .panel-close:active { transform: scale(0.94); }
  .convert-content { position: relative; display: grid; padding: 15px 11px 15px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .output-picker { position: relative; }
  .output-picker > button { display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; letter-spacing: inherit; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 160ms ease; justify-content: space-between; width: 100%; }
  .output-picker > button:hover, .output-picker > button[aria-expanded='true'] { border-color: rgba(0, 0, 0, 0.18); }
  .output-picker strong { color: rgba(0, 0, 0, 0.75); font-weight: 400; }
  .output-menu { position: absolute; z-index: 80; top: calc(100% + 8px); right: 0; box-sizing: border-box; width: 206px; padding: 4px 5px; border: 1px solid rgba(0, 0, 0, 0.15); border-radius: 15px; background: rgba(255, 255, 255, 0.75); box-shadow: 0 0 100px rgba(0, 0, 0, 0.08); backdrop-filter: blur(4.05px); -webkit-backdrop-filter: blur(4.05px); transform-origin: top right; }
  .output-menu-item { display: flex; align-items: center; box-sizing: border-box; width: 100%; height: 39px; padding: 0 11px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: rgba(0, 0, 0, 0.75); font: inherit; font-size: 20px; letter-spacing: -0.2px; text-align: left; cursor: pointer; transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease; }
  .output-menu-item.active, .output-menu-item:hover { border-color: rgba(0, 0, 0, 0.08); background: rgba(107, 107, 107, 0.05); color: #000; }
  .convert-actions { display: grid; gap: 10px; padding: 15px 11px 15px 12px; }
  .convert-action { display: flex; align-items: center; justify-content: center; gap: 10px; box-sizing: border-box; width: 100%; min-width: 0; height: 48px; padding: 0 17px; border: 1px solid #111; border-radius: 15px; background: #111; color: #fff; font: inherit; letter-spacing: inherit; cursor: pointer; transition: opacity 150ms ease, background-color 150ms ease, transform 160ms ease; }
  .convert-action span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .convert-action:active { transform: scale(0.97); }
  .convert-action.upload { border-color: rgba(0, 0, 0, 0.1); background: #fff; color: rgba(0, 0, 0, 0.5); }
  .convert-action.upload:hover:not(:disabled) { border-color: rgba(0, 0, 0, 0.18); color: rgba(0, 0, 0, 0.75); }
  .convert-action.primary img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .convert-action:disabled { cursor: default; opacity: 0.35; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%, -50%); }
  .action-plus::after { transform: translate(-50%, -50%) rotate(90deg); }
  .file-input { display: none; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .convert-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { border: 0; filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .convert-content { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .output-picker > button { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .output-picker > button:hover,
  :global(:root[data-theme="dark"]) .output-picker > button[aria-expanded='true'] { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .output-picker strong { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .output-menu { border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(24, 24, 24, 0.95); box-shadow: 0 0 100px rgba(0, 0, 0, 0.24); }
  :global(:root[data-theme="dark"]) .output-menu-item { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .output-menu-item.active,
  :global(:root[data-theme="dark"]) .output-menu-item:hover { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .convert-action { border: 1px solid #ececec; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .convert-action.upload { border-color: rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .convert-action.upload:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.144); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .convert-action.primary img { filter: brightness(0); }
  :global(:root[data-theme="dark"]) .action-plus::before,
  :global(:root[data-theme="dark"]) .action-plus::after { background: currentColor; }
  /* dark theme: end generated */

</style>
