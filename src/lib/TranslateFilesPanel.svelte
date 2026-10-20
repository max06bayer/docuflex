<script>
  import { onDestroy, onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly, scale } from 'svelte/transition';
  import {
    TRANSLATION_LANGUAGES,
    formatBytes,
    preferredTranslationLanguages,
    rememberTranslationLanguages,
    showAppError,
    translatePdf,
    translationLanguageLabel,
    translationStatus
  } from '$lib/translate.js';

  /** @type {() => void} */
  export let onClose = () => {};
  /** 'home' uploads a file and offers the result; 'editor' translates the open document through onTranslate. */
  /** @type {'home' | 'editor'} */
  export let placement = 'home';
  /** Editor only: translates the open document in place. @type {(source: string, target: string) => Promise<void> | void} */
  export let onTranslate = () => {};
  /** Home only: opens the translated PDF in a new editor tab. @type {(file: File) => void} */
  export let onOpen = () => {};

  const preferred = preferredTranslationLanguages();
  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {File | null} */
  let inputFile = null;
  let sourceLanguage = preferred.source;
  let targetLanguage = preferred.target;
  /** @type {'source' | 'target' | null} */
  let openMenu = null;
  let translating = false;
  let error = '';
  /** @type {{ file: File; missed: number } | null} */
  let result = null;
  /** @type {AbortController | null} */
  let request = null;
  /** @type {import('$lib/translate.js').TranslationStatus | null} */
  let status = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pollTimer;
  let statusGeneration = 0;

  $: pairLabel = `${translationLanguageLabel(sourceLanguage)} → ${translationLanguageLabel(targetLanguage)}`;
  $: download = status?.download ?? null;
  $: downloading = Boolean(download && ['preparing', 'downloading', 'installing'].includes(download.phase));
  $: progress = download?.total ? Math.min(1, download.received / download.total) : 0;
  $: modelReady = Boolean(status?.modelReady);
  $: needsFile = placement === 'home' && !inputFile;
  $: refreshStatus(sourceLanguage, targetLanguage);

  /** @param {string} source @param {string} target */
  async function refreshStatus(source, target) {
    const generation = ++statusGeneration;
    clearTimeout(pollTimer);
    try {
      const next = await translationStatus(source, target);
      if (generation !== statusGeneration) return;
      applyStatus(next);
    } catch (failure) {
      if (generation !== statusGeneration) return;
      error = failure instanceof Error ? failure.message : 'Could not check the translation model.';
    }
  }

  /** @param {import('$lib/translate.js').TranslationStatus} next */
  function applyStatus(next) {
    const wasDownloading = downloading;
    status = next;
    const phase = next.download?.phase;
    if (phase === 'preparing' || phase === 'downloading' || phase === 'installing') {
      pollTimer = setTimeout(() => refreshStatus(sourceLanguage, targetLanguage), 400);
    } else if (wasDownloading && phase === 'failed') {
      error = next.download?.error || 'The translation model could not be downloaded.';
      showAppError('Could not download the translation model', error);
    }
  }

  async function downloadModel() {
    if (downloading) return;
    error = '';
    try {
      applyStatus(await translationStatus(sourceLanguage, targetLanguage, 'POST'));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not start the download.';
      showAppError('Could not download the translation model', failure);
    }
  }

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
      error = 'Choose a PDF file to translate.';
      return;
    }
    inputFile = file;
    result = null;
    error = '';
  }

  /** @param {'source' | 'target'} menu @param {MouseEvent} event */
  function toggleMenu(menu, event) {
    event.stopPropagation();
    openMenu = openMenu === menu ? null : menu;
  }

  /** @param {'source' | 'target'} menu @param {string} language */
  function selectLanguage(menu, language) {
    // Picking the other side's language swaps the pair instead of making it invalid.
    if (menu === 'source') {
      if (language === targetLanguage) targetLanguage = sourceLanguage;
      sourceLanguage = language;
    } else {
      if (language === sourceLanguage) sourceLanguage = targetLanguage;
      targetLanguage = language;
    }
    openMenu = null;
    result = null;
    error = '';
  }

  async function translate() {
    if (translating || !modelReady || needsFile) return;
    rememberTranslationLanguages(sourceLanguage, targetLanguage);
    error = '';
    if (placement === 'editor') {
      await onTranslate(sourceLanguage, targetLanguage);
      return;
    }
    if (!inputFile) return;
    translating = true;
    result = null;
    request = new AbortController();
    try {
      const translated = await translatePdf(inputFile, sourceLanguage, targetLanguage, request.signal);
      const name = `${inputFile.name.replace(/\.pdf$/i, '') || 'document'}-${targetLanguage}.pdf`;
      result = { file: new File([translated.blob], name, { type: 'application/pdf', lastModified: Date.now() }), missed: translated.missed };
    } catch (failure) {
      if (request?.signal.aborted) return;
      console.error(failure);
      error = failure instanceof Error ? failure.message : 'Could not translate this PDF.';
      showAppError('Could not translate this PDF', failure);
    } finally {
      translating = false;
      request = null;
    }
  }

  function downloadResult() {
    if (!result) return;
    const url = URL.createObjectURL(result.file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.file.name;
    // The desktop shell routes final exports through the native save panel.
    anchor.dataset.docuflexFinalExport = 'true';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function openResult() {
    if (!result) return;
    onOpen(result.file);
    onClose();
  }

  /** @param {number} bytesPerSecond */
  function formatSpeed(bytesPerSecond) {
    const megabytes = bytesPerSecond / 1e6;
    return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB/s`;
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

  onMount(() => {
    window.addEventListener('pointerdown', closeMenus);
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    request?.abort();
    clearTimeout(pollTimer);
    statusGeneration += 1;
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', closeMenus);
    window.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="translate-panel" class:editor={placement === 'editor'} role="dialog" aria-label="Translate" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/redesign/icon-languages.svg" alt="" />
    <h2>Translate</h2>
    <button class="panel-close" type="button" aria-label="Close Translate" onclick={onClose}></button>
  </header>

  <section class="panel-fields">
    {#each [
      { id: 'source', label: 'From', value: sourceLanguage },
      { id: 'target', label: 'To', value: targetLanguage }
    ] as picker (picker.id)}
      <div class="language-picker">
        <button
          class="panel-field"
          type="button"
          aria-haspopup="menu"
          aria-expanded={openMenu === picker.id}
          disabled={translating || downloading}
          onclick={(event) => toggleMenu(/** @type {'source' | 'target'} */ (picker.id), event)}
        >
          <span>{picker.label}</span>
          <strong>{translationLanguageLabel(picker.value)}</strong>
          <i class="chevron" aria-hidden="true"></i>
        </button>
        {#if openMenu === picker.id}
          <div class="language-menu" role="menu" transition:scale={{ duration: 125, easing: cubicOut, start: 0.94, opacity: 0 }}>
            {#each TRANSLATION_LANGUAGES as language (language.id)}
              <button
                class="language-menu-item"
                class:selected={language.id === picker.value}
                role="menuitemradio"
                aria-checked={language.id === picker.value}
                type="button"
                onclick={() => selectLanguage(/** @type {'source' | 'target'} */ (picker.id), language.id)}
              >{language.label}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    {#if placement === 'home'}
      <button class="panel-field upload-field" class:chosen={Boolean(inputFile)} type="button" disabled={translating} onclick={chooseFile} title={inputFile?.name}>
        <span>{inputFile ? inputFile.name : 'Upload PDF'}</span>
        <em>{inputFile ? 'Change' : ''}</em>
      </button>
    {/if}
    <p class:visible={Boolean(error)} class="panel-error" aria-live="polite">{error}</p>
  </section>

  <section class="panel-info">
    {#if !status}
      <h3>Translation:</h3>
      <p>Checking for the <span>{pairLabel}</span> model…</p>
    {:else if modelReady}
      <h3>Ready:</h3>
      <p>
        The <span>{pairLabel}</span> model is installed.
        {status.local ? 'Your document never leaves this computer.' : 'Files are deleted after translating.'}
      </p>
    {:else if !status.canDownload}
      <h3>Unavailable:</h3>
      <p>The translation engine is <span>not installed</span> on this server.</p>
    {:else}
      <h3>{status.engineReady ? 'Model Needed:' : 'First Use:'}</h3>
      <p>
        {status.engineReady ? 'The' : 'Downloads the translation engine and the'}
        <span>{pairLabel}</span> model{status.downloadBytes ? `, about ${formatBytes(status.downloadBytes)}` : ''}. One-time download.
      </p>
    {/if}
  </section>

  <footer class="panel-actions">
    {#if result}
      <div class="result-actions">
        <button class="panel-action" type="button" onclick={openResult}>Open</button>
        <button class="panel-action secondary" type="button" onclick={downloadResult}>Download</button>
      </div>
      {#if result.missed}<p class="panel-note">Some text couldn’t be replaced and stays in the original language.</p>{/if}
    {:else if downloading && download}
      <div
        class="model-progress"
        class:indeterminate={download.phase !== 'downloading'}
        role="progressbar"
        aria-label="Downloading translation model"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(progress * 100)}
        style:--progress={download.phase === 'downloading' ? progress : 1}
      >
        <span class="progress-fill"></span>
        {#each ['track', 'fill'] as layer (layer)}
          <span class={`progress-label ${layer}`} aria-hidden={layer === 'fill'}>
            {#if download.phase === 'downloading'}
              <b>{Math.floor(progress * 100)}%</b>
              <em>{formatSpeed(download.bytesPerSecond)}</em>
            {:else}
              <b>{download.phase === 'preparing' ? 'Preparing…' : 'Installing…'}</b>
            {/if}
          </span>
        {/each}
      </div>
    {:else if status && !modelReady}
      <button class="panel-action download" type="button" disabled={!status.canDownload} onclick={downloadModel}>
        <img src="/download.svg" alt="" />
        <span>Download Model</span>
      </button>
    {:else}
      <button class="panel-action" class:busy={translating} type="button" disabled={!modelReady || translating || needsFile} onclick={translate}>
        {#if translating}
          <span class="spinner" aria-hidden="true"></span>
        {:else}
          <img src="/redesign/icon-languages.svg" alt="" />
        {/if}
        <span>{translating ? 'Translating…' : 'Translate'}</span>
      </button>
    {/if}
  </footer>

  <input bind:this={fileInput} class="file-input" type="file" accept="application/pdf,.pdf" onchange={handleFile} />
</div>

<style>
  /* Mirrors the editor's Password Protect panel (PdfEditor .protect-panel, redesign overrides). */
  .translate-panel {
    position: absolute;
    z-index: 45;
    top: 20px;
    left: 14px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    box-sizing: border-box;
    width: min(293px, calc(100% - 28px));
    border: 1.5px solid #c3c2c2;
    border-radius: 21px;
    background: rgba(240, 236, 236, 0.75);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(1.3px);
    -webkit-backdrop-filter: blur(1.3px);
    color: #000;
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
  }

  .translate-panel.editor {
    z-index: 40;
    top: 12px;
    right: 13px;
    left: auto;
    width: min(293px, calc(100% - 26px));
  }

  .panel-header {
    display: grid;
    grid-template-columns: 26px 1fr 28px;
    align-items: center;
    box-sizing: border-box;
    height: 50px;
    padding: 0 14px;
    border-bottom: 1.5px solid #c3c2c2;
    border-radius: 19.5px 19.5px 0 0;
    background: rgba(214, 214, 214, 0.75);
  }

  .panel-header > img { width: 24px; height: 24px; }

  .panel-header h2 {
    margin: 0 0 0 8px;
    overflow: hidden;
    font-size: 20px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.2px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .panel-close {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat;
    cursor: pointer;
    transition: transform 160ms ease, filter 160ms ease;
  }

  .panel-close:hover { filter: brightness(0); }
  .panel-close:active { transform: scale(0.94); }

  .panel-fields {
    display: grid;
    gap: 10px;
    padding: 12px 11px 12px 12px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }

  .panel-field {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 12px;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    width: 100%;
    height: 48px;
    padding: 0 15px 0 13px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 15px;
    background: #fff;
    color: rgba(0, 0, 0, 0.75);
    font: inherit;
    font-size: 21px;
    letter-spacing: -0.21px;
    text-align: left;
    cursor: pointer;
    transition: border-color 160ms ease, opacity 160ms ease;
  }

  .panel-field:not(:disabled):hover,
  .panel-field[aria-expanded='true'] { border-color: rgba(0, 0, 0, 0.18); }
  .panel-field:disabled { cursor: default; opacity: 0.55; }
  .panel-field span { color: rgba(0, 0, 0, 0.5); white-space: nowrap; }

  .panel-field strong {
    overflow: hidden;
    color: rgba(0, 0, 0, 0.75);
    font-weight: 400;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    width: 7px;
    height: 7px;
    margin: -4px 0 0 2px;
    border-right: 1.5px solid rgba(0, 0, 0, 0.4);
    border-bottom: 1.5px solid rgba(0, 0, 0, 0.4);
    transform: rotate(45deg);
    transition: transform 160ms ease, margin 160ms ease;
  }

  [aria-expanded='true'] .chevron { margin-top: 3px; transform: rotate(-135deg); }

  .language-picker { position: relative; min-width: 0; }

  .language-menu {
    position: absolute;
    z-index: 80;
    top: calc(100% + 6px);
    right: 0;
    left: 0;
    max-height: 252px;
    overflow-y: auto;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 7px 18px rgba(0, 0, 0, 0.1), 0 2px 5px rgba(0, 0, 0, 0.04);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    transform-origin: top center;
  }

  .language-menu-item {
    display: flex;
    align-items: center;
    width: 100%;
    height: 40px;
    padding: 0 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: rgba(0, 0, 0, 0.75);
    font: inherit;
    font-size: 18px;
    letter-spacing: -0.18px;
    text-align: left;
    cursor: pointer;
  }

  .language-menu-item:hover,
  .language-menu-item:focus-visible { background: rgba(0, 0, 0, 0.05); color: #000; outline: none; }
  .language-menu-item.selected { color: #0878f9; }

  .upload-field { grid-template-columns: minmax(0, 1fr) auto; }
  .upload-field span { overflow: hidden; text-overflow: ellipsis; }
  .upload-field.chosen span { color: rgba(0, 0, 0, 0.75); }
  .upload-field em { color: rgba(0, 0, 0, 0.5); font-size: 18px; font-style: normal; }

  .panel-error {
    max-height: 0;
    margin: -10px 2px 0;
    overflow: hidden;
    color: #c83e3e;
    font-size: 16px;
    line-height: 1.3;
    letter-spacing: -0.16px;
    opacity: 0;
    transition: max-height 240ms cubic-bezier(0.22, 1, 0.36, 1), margin 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 170ms ease;
  }

  .panel-error.visible { max-height: 84px; margin-top: -2px; opacity: 1; }

  .panel-info {
    padding: 16px 14px 14px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }

  .panel-info h3 {
    margin: 0 0 7px;
    color: #000;
    font-size: 20px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.2px;
  }

  .panel-info p {
    margin: 0;
    color: rgba(0, 0, 0, 0.5);
    font-size: 18px;
    line-height: 1.42;
    letter-spacing: -0.18px;
  }

  .panel-info p span { color: #0878f9; }

  .panel-actions {
    display: grid;
    gap: 10px;
    padding: 15px 11px 15px 12px;
  }

  .result-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

  .panel-action {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    box-sizing: border-box;
    width: 100%;
    height: 48px;
    padding: 0 12px;
    border: 0;
    border-radius: 15px;
    background: #000;
    color: #fff;
    font: inherit;
    font-size: 20px;
    line-height: 1;
    letter-spacing: -0.2px;
    cursor: pointer;
    transition: background-color 260ms ease, transform 160ms ease, box-shadow 220ms ease, opacity 160ms ease;
  }

  .panel-action:hover:not(:disabled) { box-shadow: 0 5px 16px rgba(0, 0, 0, 0.16); }
  .panel-action:active:not(:disabled) { transform: scale(0.985); }
  .panel-action:disabled { cursor: default; opacity: 0.42; }
  .panel-action.busy:disabled { cursor: wait; opacity: 0.82; }
  .panel-action img { width: 24px; height: 24px; filter: brightness(0) invert(1); }

  .panel-action.download {
    background: #0878f9;
    box-shadow: 0 5px 16px rgba(8, 120, 249, 0.22);
  }

  .panel-action.download:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.32); }

  .panel-action.secondary {
    border: 1px solid rgba(0, 0, 0, 0.1);
    background: #fff;
    color: rgba(0, 0, 0, 0.75);
  }

  .panel-action.secondary:hover { box-shadow: none; border-color: rgba(0, 0, 0, 0.18); }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: translate-spin 800ms linear infinite;
  }

  @keyframes translate-spin { to { transform: rotate(360deg); } }

  /* The Download Model button turns into this bar: blue fills it from the left like a liquid. */
  .model-progress {
    --progress: 0;
    position: relative;
    height: 48px;
    overflow: hidden;
    border-radius: 15px;
    background: rgba(8, 120, 249, 0.1);
    box-shadow: inset 0 0 0 1px rgba(8, 120, 249, 0.16);
    isolation: isolate;
  }

  .progress-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--progress) * 100%);
    min-width: 15px;
    background: linear-gradient(180deg, #2a8cff 0%, #0878f9 55%, #006ae6 100%);
    transition: width 420ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  /* The leading edge is a slow vertical wave, so the fill reads as fluid rather than a hard edge. */
  .progress-fill::after {
    position: absolute;
    top: -24px;
    right: -9px;
    bottom: -24px;
    width: 10px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 24'%3E%3Cpath d='M0 0h4c4 3 4 9 0 12s-4 9 0 12H0z' fill='%23006ae6'/%3E%3C/svg%3E") 0 0 / 10px 24px repeat-y;
    content: '';
    animation: progress-wave 1.4s linear infinite;
  }

  /* A soft sheen drifts across the filled part. */
  .progress-fill::before {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.22) 45%, transparent 70%) -120% 0 / 60% 100% no-repeat;
    content: '';
    animation: progress-sheen 2.2s ease-in-out infinite;
  }

  .model-progress.indeterminate .progress-fill::after { display: none; }

  @keyframes progress-wave { to { background-position: 0 24px; } }
  @keyframes progress-sheen { to { background-position: 220% 0; } }

  .progress-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    font-size: 20px;
    letter-spacing: -0.2px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .indeterminate .progress-label { justify-content: center; }
  .progress-label b { font-weight: 400; }
  .progress-label em { font-size: 17px; font-style: normal; opacity: 0.8; }
  .progress-label.track { color: #0878f9; }

  /* The white copy is clipped to the fill, so the text changes colour exactly at the edge. */
  .progress-label.fill {
    color: #fff;
    clip-path: inset(0 calc(100% - var(--progress) * 100%) 0 0);
    transition: clip-path 420ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .panel-note {
    margin: -2px 2px 0;
    color: rgba(0, 0, 0, 0.5);
    font-size: 16px;
    line-height: 1.3;
    letter-spacing: -0.16px;
  }

  .file-input { display: none; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .translate-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { filter: brightness(0) invert(1) opacity(0.78); }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .panel-fields { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-field { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .panel-field:not(:disabled):hover,
  :global(:root[data-theme="dark"]) .panel-field[aria-expanded='true'] { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .panel-field span { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-field strong { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .chevron { border-right: 1.5px solid rgba(255, 255, 255, 0.32); border-bottom: 1.5px solid rgba(255, 255, 255, 0.32); }
  :global(:root[data-theme="dark"]) .language-menu { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(24, 24, 24, 0.95); box-shadow: 0 7px 18px rgba(0, 0, 0, 0.3), 0 2px 5px rgba(0, 0, 0, 0.12); }
  :global(:root[data-theme="dark"]) .language-menu-item { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .language-menu-item:hover,
  :global(:root[data-theme="dark"]) .language-menu-item:focus-visible { background: rgba(255, 255, 255, 0.065); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .language-menu-item.selected { color: #0878f9; }
  :global(:root[data-theme="dark"]) .upload-field.chosen span { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .upload-field em { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-error { color: #c83e3e; }
  :global(:root[data-theme="dark"]) .panel-info { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-info h3 { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-info p { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-info p span { color: #0878f9; }
  :global(:root[data-theme="dark"]) .panel-action { background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .panel-action:hover:not(:disabled) { box-shadow: 0 5px 16px rgba(0, 0, 0, 0.48); }
  :global(:root[data-theme="dark"]) .panel-action img { filter: brightness(0); }
  :global(:root[data-theme="dark"]) .panel-action.download { background: #0878f9; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.6); }
  :global(:root[data-theme="dark"]) .panel-action.download:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.6); }
  :global(:root[data-theme="dark"]) .panel-action.secondary { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .panel-action.secondary:hover { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .spinner { border: 2px solid rgba(0, 0, 0, 0.24); border-top-color: rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .model-progress { background: rgba(8, 120, 249, 0.1); box-shadow: inset 0 0 0 1px rgba(8, 120, 249, 0.48); }
  :global(:root[data-theme="dark"]) .progress-fill { background: linear-gradient(180deg, #2a8cff 0%, #0878f9 55%, #006ae6 100%); }
  :global(:root[data-theme="dark"]) .progress-fill::before { background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.026) 45%, transparent 70%) -120% 0 / 60% 100% no-repeat; }
  :global(:root[data-theme="dark"]) .progress-label.track { color: #0878f9; }
  :global(:root[data-theme="dark"]) .progress-label.fill { color: #111111; }
  :global(:root[data-theme="dark"]) .panel-note { color: rgba(255, 255, 255, 0.5); }
  /* dark theme: end generated */

</style>
