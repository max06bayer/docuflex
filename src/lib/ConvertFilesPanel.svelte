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
  .convert-panel { position: absolute; z-index: 45; top: 20px; left: 14px; display: grid; grid-template-rows: 50px 90px 132px; width: min(320px, calc(100% - 28px)); height: 272px; border: 1.5px solid transparent; border-radius: 13px; background: #fafafa; box-shadow: 0 9px 24px rgba(0,0,0,.07); color: #000; font-family: "Inter Variable", Inter, sans-serif; font-size: 16px; }
  .convert-panel::after { position: absolute; z-index: 100; inset: -1.5px; border: 1.5px solid #c5c5c5; border-radius: 13px; content: ''; pointer-events: none; }
  .panel-header { display: grid; grid-template-columns: 26px 1fr 28px; align-items: center; height: 50px; padding: 0 12px; border-bottom: 1px solid #cacaca; border-radius: 12px 12px 0 0; background: #eee; }
  .panel-header > img { width: 24px; height: 24px; }
  .panel-header h2 { margin: 0 0 1px 7px; overflow: hidden; font-size: 18px; font-weight: 400; line-height: 1; letter-spacing: -.25px; text-overflow: ellipsis; white-space: nowrap; }
  .panel-close { position: relative; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: transform 160ms ease; }
  .panel-close:active { transform: scale(.94); }
  .panel-close span { position: absolute; top: 13px; left: 6px; width: 16px; height: 1.5px; border-radius: 99px; background: #929292; transform: rotate(45deg); transition: background-color 160ms ease; }
  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }
  .convert-content { position: relative; display: grid; align-items: center; padding: 15px 18px; border-bottom: 1px solid #cacaca; }
  .output-picker { position: relative; }
  .output-picker > button { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 44px; padding: 0 13px; border: 1px solid #d7d7d7; border-radius: 8px; background: #f3f3f3; color: #7a7a7a; font: inherit; font-size: 18px; cursor: pointer; transition: border-color 160ms ease, background-color 160ms ease; }
  .output-picker > button:hover, .output-picker > button[aria-expanded='true'] { border-color: #c4c4c4; background: #eee; }
  .output-picker strong { color: #000; font-weight: 400; }
  .output-menu { position: absolute; z-index: 80; top: calc(100% + 8px); right: 0; width: 204px; padding: 5px; border: 1px solid rgba(0,0,0,.18); border-radius: 15px; background: rgba(255,255,255,.78); box-shadow: 0 7px 18px rgba(0,0,0,.11), 0 2px 5px rgba(0,0,0,.05); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); transform-origin: top right; }
  .output-menu-item { display: flex; align-items: center; width: 100%; height: 40px; padding: 0 12px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #3f3f3f; font: inherit; font-size: 18px; text-align: left; cursor: pointer; }
  .output-menu-item.active { border-color: rgba(0,0,0,.08); background: rgba(234,234,234,.574); }
  .output-menu-item:hover { color: #000; }
  .convert-actions { display: grid; grid-template-rows: repeat(2,44px); align-content: center; gap: 10px; padding: 17px 18px; border-radius: 0 0 12px 12px;}
  .convert-action { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; height: 44px; min-width: 0; padding: 0 12px; border-radius: 8px; font: inherit; font-size: 18px; font-weight: 400; line-height: 1; letter-spacing: -.3px; cursor: pointer; transition: background-color 220ms ease, border-color 180ms ease, box-shadow 220ms ease, transform 160ms ease; }
  .convert-action span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .convert-action:active { transform: scale(.985); }
  .convert-action.upload { border: 1px solid #d7d7d7; background: #f3f3f3; color: #7a7a7a; }
  .convert-action.upload:hover { border-color: #c8c8c8; background: #eee; }
  .convert-action.primary { border: 0; background: #0878f9; color: #fff; box-shadow: 0 5px 16px rgba(8,120,249,.18); }
  .convert-action.primary:hover:not(:disabled) { background: #006ff0; box-shadow: 0 6px 18px rgba(8,120,249,.27); }
  .convert-action.primary img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .convert-action:disabled { cursor: default; opacity: .55; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%,-50%); }
  .action-plus::after { transform: translate(-50%,-50%) rotate(90deg); }
  .file-input { display: none; }
</style>
