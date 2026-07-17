<script>
  import { onDestroy } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly, scale } from 'svelte/transition';

  /** @type {() => void} */
  export let onClose = () => {};

  const languages = [
    { id: 'en', label: 'English' },
    { id: 'de', label: 'German' },
    { id: 'es', label: 'Spanish' },
    { id: 'fr', label: 'French' },
    { id: 'it', label: 'Italian' },
    { id: 'pt', label: 'Portuguese' },
    { id: 'nl', label: 'Dutch' },
    { id: 'pl', label: 'Polish' },
    { id: 'ru', label: 'Russian' },
    { id: 'uk', label: 'Ukrainian' },
    { id: 'ar', label: 'Arabic' },
    { id: 'zh', label: 'Chinese' },
    { id: 'ja', label: 'Japanese' },
    { id: 'ko', label: 'Korean' }
  ];

  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {File | null} */
  let inputFile = null;
  let sourceLanguage = 'en';
  let targetLanguage = 'de';
  /** @type {'source' | 'target' | null} */
  let openMenu = null;
  let translating = false;

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
      window.alert('Choose a PDF file to translate.');
      return;
    }
    inputFile = file;
  }

  /** @param {'source' | 'target'} menu @param {MouseEvent} event */
  function toggleMenu(menu, event) {
    event.stopPropagation();
    openMenu = openMenu === menu ? null : menu;
  }

  /** @param {'source' | 'target'} menu @param {string} language */
  function selectLanguage(menu, language) {
    if (menu === 'source') sourceLanguage = language;
    else targetLanguage = language;
    openMenu = null;
  }

  /** @param {string} language */
  function languageLabel(language) {
    return languages.find((item) => item.id === language)?.label ?? language.toUpperCase();
  }

  async function translateFile() {
    if (!inputFile || translating || sourceLanguage === targetLanguage) return;
    translating = true;
    try {
      const form = new FormData();
      form.set('file', inputFile);
      form.set('sourceLanguage', sourceLanguage);
      form.set('targetLanguage', targetLanguage);
      const response = await fetch('/api/translate', { method: 'POST', body: form });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `Translation failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${inputFile.name.replace(/\.pdf$/i, '') || 'document'}-${targetLanguage}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not translate this PDF.');
    } finally {
      translating = false;
    }
  }

  /** @param {PointerEvent} event */
  function closeMenus(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.language-picker')) openMenu = null;
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (openMenu) openMenu = null;
    else onClose();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', closeMenus);
    window.addEventListener('keydown', handleKeydown);
  }

  onDestroy(() => {
    window.removeEventListener('pointerdown', closeMenus);
    window.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="translate-panel" role="dialog" aria-label="Translate" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/quicktools/translate.svg" alt="" />
    <h2>Translate</h2>
    <button class="panel-close" type="button" aria-label="Close Translate" onclick={onClose}><span></span><span></span></button>
  </header>

  <div class="translate-content">
    {#each [
      { id: 'source', label: 'Translate From', value: sourceLanguage },
      { id: 'target', label: 'Translate To', value: targetLanguage }
    ] as picker}
      <div class="language-picker">
        <button type="button" aria-haspopup="menu" aria-expanded={openMenu === picker.id} onclick={(event) => toggleMenu(/** @type {'source' | 'target'} */ (picker.id), event)}>
          <span>{picker.label}</span>
          <strong>{languageLabel(picker.value)}</strong>
        </button>
        {#if openMenu === picker.id}
          <div class="language-menu" role="menu" transition:scale={{ duration: 125, easing: cubicOut, start: .94, opacity: 0 }}>
            {#each languages as language}
              <button class="language-menu-item" role="menuitem" type="button" onclick={() => selectLanguage(/** @type {'source' | 'target'} */ (picker.id), language.id)}>{language.label}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <footer class="translate-actions">
    <button class="translate-action upload" type="button" disabled={translating} onclick={chooseFile}>
      {#if !inputFile}<span class="action-plus" aria-hidden="true"></span>{/if}
      <span>{inputFile ? inputFile.name : 'Upload File'}</span>
    </button>
    <button class="translate-action primary" type="button" disabled={!inputFile || translating || sourceLanguage === targetLanguage} onclick={translateFile}>
      <img src="/quicktools/translate.svg" alt="" />
      <span>{translating ? 'Translating…' : 'Translate'}</span>
    </button>
  </footer>

  <input bind:this={fileInput} class="file-input" type="file" accept="application/pdf,.pdf" onchange={handleFile} />
</div>

<style>
  .translate-panel { position: absolute; z-index: 45; top: 20px; left: 14px; display: grid; grid-template-rows: 50px 118px 132px; box-sizing: border-box; width: min(320px, calc(100% - 28px)); height: 300px; overflow: visible; border: 1.5px solid #c5c5c5; border-radius: 13px; background: #fafafa; box-shadow: 0 9px 24px rgba(0,0,0,.07); color: #000; font-family: "Inter Variable", Inter, sans-serif; font-size: 16px; }
  .panel-header { display: grid; grid-template-columns: 26px 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 12px; border-bottom: 1px solid #cacaca; border-radius: 12px 12px 0 0; background: #eee; }
  .panel-header > img { width: 24px; height: 24px; }
  .panel-header h2 { margin: 0 0 1px 7px; font-size: 18px; font-weight: 400; line-height: 1; letter-spacing: -.25px; }
  .panel-close { position: relative; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: transform 160ms ease; }
  .panel-close:active { transform: scale(.94); }
  .panel-close span { position: absolute; top: 13px; left: 6px; width: 16px; height: 1.5px; border-radius: 99px; background: #929292; transform: rotate(45deg); transition: background-color 160ms ease; }
  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }
  .translate-content { display: grid; grid-template-rows: repeat(2,44px); gap: 10px; box-sizing: border-box; padding: 12px 18px; border-bottom: 1px solid #cacaca; }
  .language-picker { position: relative; min-width: 0; }
  .language-picker > button { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; height: 44px; padding: 0 13px; border: 1px solid #d7d7d7; border-radius: 8px; background: #f3f3f3; color: #7a7a7a; font: inherit; font-size: 17px; cursor: pointer; transition: border-color 160ms ease, background-color 160ms ease; }
  .language-picker > button:hover, .language-picker > button[aria-expanded='true'] { border-color: #c4c4c4; background: #eee; }
  .language-picker strong { overflow: hidden; color: #000; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
  .language-menu { position: absolute; z-index: 80; top: calc(100% + 7px); right: 0; width: 204px; max-height: 216px; overflow-y: auto; padding: 5px; border: 1px solid rgba(0,0,0,.18); border-radius: 15px; background: rgba(255,255,255,.82); box-shadow: 0 7px 18px rgba(0,0,0,.11), 0 2px 5px rgba(0,0,0,.05); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); transform-origin: top right; }
  .language-menu-item { display: flex; align-items: center; width: 100%; height: 40px; padding: 0 12px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #3f3f3f; font: inherit; font-size: 17px; text-align: left; cursor: pointer; }
  .language-menu-item:hover, .language-menu-item:focus-visible { border-color: rgba(0,0,0,.07); background: rgba(234,234,234,.62); color: #000; outline: none; }
  .translate-actions { display: grid; grid-template-rows: repeat(2,44px); align-content: center; gap: 10px; box-sizing: border-box; padding: 17px 18px; border-radius: 0 0 12px 12px; background: #fafafa; }
  .translate-action { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; min-width: 0; height: 44px; padding: 0 12px; border-radius: 8px; font: inherit; font-size: 18px; font-weight: 400; line-height: 1; letter-spacing: -.3px; cursor: pointer; transition: background-color 220ms ease, border-color 180ms ease, box-shadow 220ms ease, transform 160ms ease; }
  .translate-action span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .translate-action:active { transform: scale(.985); }
  .translate-action.upload { border: 1px solid #d7d7d7; background: #f3f3f3; color: #7a7a7a; }
  .translate-action.upload:hover { border-color: #c8c8c8; background: #eee; }
  .translate-action.primary { border: 0; background: #0878f9; color: #fff; box-shadow: 0 5px 16px rgba(8,120,249,.18); }
  .translate-action.primary:hover:not(:disabled) { background: #006ff0; box-shadow: 0 6px 18px rgba(8,120,249,.27); }
  .translate-action.primary img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .translate-action:disabled { cursor: default; opacity: .55; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%,-50%); }
  .action-plus::after { transform: translate(-50%,-50%) rotate(90deg); }
  .file-input { display: none; }
</style>
