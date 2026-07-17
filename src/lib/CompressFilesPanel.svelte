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
  /** @type {'small' | 'medium' | 'large'} */
  let compression = 'large';
  let compressing = false;

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
      window.alert('Choose a PDF file to compress.');
      return;
    }
    inputFile = file;
  }

  async function compressFile() {
    if (!inputFile || compressing) return;
    compressing = true;
    try {
      const form = new FormData();
      form.set('file', inputFile);
      form.set('compression', compression);
      const response = await fetch('/api/compress', { method: 'POST', body: form });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `Compression failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${inputFile.name.replace(/\.pdf$/i, '') || 'document'}-compressed.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not compress this PDF.');
    } finally {
      compressing = false;
    }
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') onClose();
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', handleKeydown);
  onDestroy(() => window.removeEventListener('keydown', handleKeydown));
</script>

<div class="compress-panel" role="dialog" aria-label="Compress" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/compress.svg" alt="" />
    <h2>Compress</h2>
    <button class="panel-close" type="button" aria-label="Close Compress" onclick={onClose}><span></span><span></span></button>
  </header>

  <div class="compress-content">
    <button class="upload-file" type="button" disabled={compressing} onclick={chooseFile}>
      {#if !inputFile}<span class="action-plus" aria-hidden="true"></span>{/if}
      <span>{inputFile ? inputFile.name : 'Upload File'}</span>
    </button>
    <div class="compression-setting">
      <span>Filesize Compression</span>
      <div class="compression-options" role="group" aria-label="Filesize compression">
        {#each [
          { id: 'small', label: 'Small' },
          { id: 'medium', label: 'Medium' },
          { id: 'large', label: 'Large' }
        ] as option}
          <button class:active={compression === option.id} type="button" aria-pressed={compression === option.id} onclick={() => compression = /** @type {'small' | 'medium' | 'large'} */ (option.id)}>{option.label}</button>
        {/each}
      </div>
    </div>
  </div>

  <footer class="compress-actions">
    <button class="compress-submit" type="button" disabled={!inputFile || compressing} onclick={compressFile}>
      <img src="/compress.svg" alt="" />
      <span>{compressing ? 'Compressing…' : 'Compress'}</span>
    </button>
  </footer>
  <input bind:this={fileInput} class="file-input" type="file" accept="application/pdf,.pdf" onchange={handleFile} />
</div>

<style>
  .compress-panel { position: absolute; z-index: 45; top: 20px; left: 14px; display: grid; grid-template-rows: 50px 164px 78px; box-sizing: border-box; width: min(320px, calc(100% - 28px)); height: 292px; overflow: hidden; border: 1.5px solid #c5c5c5; border-radius: 13px; background: #fafafa; box-shadow: 0 9px 24px rgba(0,0,0,.07); color: #000; font-family: "Inter Variable", Inter, sans-serif; font-size: 16px; }
  .panel-header { display: grid; grid-template-columns: 26px 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 12px; border-bottom: 1px solid #cacaca; background: #eee; }
  .panel-header > img { width: 24px; height: 24px; }
  .panel-header h2 { margin: 0 0 0 7px; font-size: 18px; font-weight: 400; line-height: 1.22; letter-spacing: -.25px; }
  .panel-close { position: relative; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: transform 160ms ease; }
  .panel-close:active { transform: scale(.94); }
  .panel-close span { position: absolute; top: 13px; left: 6px; width: 16px; height: 1.5px; border-radius: 99px; background: #929292; transform: rotate(45deg); transition: background-color 160ms ease; }
  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }
  .compress-content { display: grid; grid-template-rows: 44px auto; gap: 15px; box-sizing: border-box; padding: 17px 18px 15px; border-bottom: 1px solid #cacaca; }
  .upload-file { display: flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid #d7d7d7; border-radius: 8px; background: #f3f3f3; color: #7a7a7a; font: inherit; font-size: 18px; cursor: pointer; transition: border-color 180ms ease, background-color 220ms ease, transform 160ms ease; }
  .upload-file:hover { border-color: #c8c8c8; background: #eee; }
  .upload-file:active { transform: scale(.985); }
  .upload-file span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%,-50%); }
  .action-plus::after { transform: translate(-50%,-50%) rotate(90deg); }
  .compression-setting { display: grid; gap: 9px; color: #7a7a7a; font-size: 18px; }
  .compression-options { display: grid; grid-template-columns: repeat(3,1fr); height: 44px; overflow: hidden; border: 1px solid #d7d7d7; border-radius: 8px; background: #f3f3f3; }
  .compression-options button { padding: 0 8px; border: 0; border-right: 1px solid #d7d7d7; background: transparent; color: #7a7a7a; font: inherit; font-size: 18px; cursor: pointer; transition: color 170ms ease, background-color 170ms ease; }
  .compression-options button:last-child { border-right: 0; }
  .compression-options button.active { background: #000; color: #fff; }
  .compress-actions { display: grid; align-content: center; box-sizing: border-box; padding: 17px 18px; background: #fafafa; }
  .compress-submit { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; height: 44px; padding: 0 12px; border: 0; border-radius: 8px; background: #0878f9; color: #fff; box-shadow: 0 5px 16px rgba(8,120,249,.18); font: inherit; font-size: 18px; cursor: pointer; transition: background-color 220ms ease, box-shadow 220ms ease, transform 160ms ease; }
  .compress-submit:hover:not(:disabled) { background: #006ff0; box-shadow: 0 6px 18px rgba(8,120,249,.27); }
  .compress-submit:active { transform: scale(.985); }
  .compress-submit img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .compress-submit:disabled, .upload-file:disabled { cursor: default; opacity: .55; }
  .file-input { display: none; }
</style>
