<script>
  import { openTranslationDownload } from '#lib/translation-download.js';
  import ModelOption from '#lib/ModelOption.svelte';
  import { QWEN_MODEL_ID, openQwenDownload } from '#lib/qwen-download.js';
  import ModelLabel from '#lib/ModelLabel.svelte';
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
  } from '#lib/translate.js';
  import { LatexError, describeLatexStage, explainLatexStage, formatElapsed, latexKeyReady, latexStatus, rememberLatexModel, runLatex, saveFile, storedLatexModel } from '#lib/latex.js';

  /** @type {() => void} */
  export let onClose = () => {};
  /** 'home' uploads a file and offers the result; 'editor' translates the open document through onTranslate. */
  /** @type {'home' | 'editor'} */
  export let placement = 'home';
  /** Editor only: translates the open document in place. @type {(source: string, target: string) => Promise<void> | void} */
  export let onTranslate = () => {};
  /** Home only: opens the translated PDF in a new editor tab. @type {(file: File) => void} */
  export let onOpen = () => {};
  /** Home only: opens Settings at the API key field for AI translation. @type {() => void} */
  export let onNeedKey = () => {};

  const MODE_STORAGE_KEY = 'docuflex-translate-mode';
  const AI_STYLE_STORAGE_KEY = 'docuflex-translate-ai-style';

  const preferred = preferredTranslationLanguages();
  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {File | null} */
  let inputFile = null;
  /** 'ai' rebuilds the document in LaTeX in the new language, keeping its design; home only. */
  /** @type {'local' | 'ai'} */
  let mode = 'local';
  /** @type {import('#lib/latex.js').LatexStatus | null} */
  let aiStatus = null;
  let aiModel = '';
  /** 'match' keeps the original's look (fonts, layout, compared page by page); the others redesign like PDF Enhance. */
  let aiStyle = 'match';
  /** @type {import('#lib/latex.js').LatexProgress | null} */
  let aiProgress = null;
  let aiTex = '';
  let aiElapsed = 0;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let aiClock;
  let sourceLanguage = preferred.source;
  let targetLanguage = preferred.target;
  /** @type {'source' | 'target' | 'model' | 'style' | null} */
  let openMenu = null;
  let translating = false;
  let error = '';
  /** @type {{ file: File; missed: number } | null} */
  let result = null;
  /** @type {AbortController | null} */
  let request = null;
  /** @type {import('#lib/translate.js').TranslationStatus | null} */
  let status = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pollTimer;
  let statusGeneration = 0;

  $: pairLabel = `${translationLanguageLabel(sourceLanguage)} → ${translationLanguageLabel(targetLanguage)}`;
  $: download = status?.download ?? null;
  $: downloading = Boolean(download && ['preparing', 'downloading', 'installing'].includes(download.phase));
  $: modelReady = Boolean(status?.modelReady);
  $: needsFile = placement === 'home' && !inputFile;
  $: refreshStatus(sourceLanguage, targetLanguage);
  $: ai = placement === 'home' && mode === 'ai';
  $: needsQwenDownload = Boolean(aiStatus?.models.find((model) => model.id === aiModel)?.downloadable && !aiStatus?.models.find((model) => model.id === aiModel)?.ready);
  $: aiKeyReady = latexKeyReady(aiStatus, aiModel);
  // Auto matches the original; PDF Enhance's own "Auto" would be a second Auto, so it is left out here.
  $: aiStyles = aiStatus ? [aiStatus.matchStyle, ...aiStatus.styles.filter((style) => style.id !== 'auto')] : [];
  $: aiStyleLabel = aiStyles.find((style) => style.id === aiStyle)?.label ?? '…';
  $: currentAiModel = aiStatus?.models.find((model) => model.id === aiModel);

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

  /** @param {import('#lib/translate.js').TranslationStatus} next */
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

  function downloadModel() {
    void openTranslationDownload(sourceLanguage, targetLanguage);
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

  /** @param {'source' | 'target' | 'model' | 'style'} menu @param {MouseEvent} event */
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

  /** @param {'local' | 'ai'} next */
  function setMode(next) {
    mode = next;
    openMenu = null;
    result = null;
    error = '';
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {}
    if (next === 'ai' && !aiStatus) void loadAiStatus();
  }

  async function loadAiStatus() {
    try {
      aiStatus = await latexStatus();
      aiModel = storedLatexModel(aiStatus);
      try {
        const saved = localStorage.getItem(AI_STYLE_STORAGE_KEY);
        if (saved && (saved === aiStatus.matchStyle.id || aiStatus.styles.some((style) => style.id === saved))) aiStyle = saved;
      } catch {}
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not reach Docuflex.';
    }
  }

  /** @param {string} id */
  function chooseAiModel(id) {
    aiModel = id;
    openMenu = null;
    if (aiStatus?.models.find((model) => model.id === id)?.ready === false) void openQwenDownload();
    rememberLatexModel(id);
  }

  /** @param {string} id */
  function chooseAiStyle(id) {
    aiStyle = id;
    openMenu = null;
    try {
      localStorage.setItem(AI_STYLE_STORAGE_KEY, id);
    } catch {}
  }

  /** AI translation: the same LaTeX pipeline as PDF Enhance, told to keep the original design. */
  async function translateWithAi() {
    if (translating || !inputFile || !aiStatus) return;
    if (needsQwenDownload) { void openQwenDownload(); return; }
    if (!aiKeyReady) {
      onNeedKey();
      return;
    }
    rememberTranslationLanguages(sourceLanguage, targetLanguage);
    error = '';
    result = null;
    aiTex = '';
    translating = true;
    request = new AbortController();
    const startedAt = Date.now();
    aiElapsed = 0;
    aiClock = setInterval(() => (aiElapsed = Math.floor((Date.now() - startedAt) / 1000)), 1000);
    const source = inputFile;
    try {
      const translated = await runLatex({
        file: source,
        status: aiStatus,
        model: aiModel,
        style: aiStyle,
        translateTo: translationLanguageLabel(targetLanguage),
        outputName: `${source.name.replace(/\.pdf$/i, '') || 'document'}-${targetLanguage}.pdf`,
        signal: request.signal,
        onProgress: (next) => (aiProgress = next)
      });
      aiTex = translated.tex;
      result = { file: translated.file, missed: 0 };
    } catch (failure) {
      if (request?.signal.aborted) return;
      console.error(failure);
      if (failure instanceof LatexError) aiTex = failure.tex;
      error = failure instanceof Error ? failure.message : 'Could not translate this PDF.';
    } finally {
      translating = false;
      aiProgress = null;
      request = null;
      clearInterval(aiClock);
    }
  }

  function downloadTex() {
    if (!aiTex) return;
    const base = (inputFile?.name ?? 'document.pdf').replace(/\.pdf$/i, '') || 'document';
    saveFile(new Blob([aiTex], { type: 'application/x-tex' }), `${base}-${targetLanguage}.tex`);
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

  /** @param {Event} event */
  function handleTranslationStatus(event) {
    const detail = /** @type {CustomEvent} */ (event).detail;
    if (detail?.source !== sourceLanguage || detail?.target !== targetLanguage) return;
    clearTimeout(pollTimer);
    status = detail.status;
  }
  onMount(() => {
    window.addEventListener('docuflex:translation-status', handleTranslationStatus);
    return () => window.removeEventListener('docuflex:translation-status', handleTranslationStatus);
  });
  const handleQwenReady = () => { void loadAiStatus(); };
  onMount(() => { window.addEventListener('docuflex:qwen-ready', handleQwenReady); return () => window.removeEventListener('docuflex:qwen-ready', handleQwenReady); });
  onMount(() => {
    if (placement === 'home') {
      try {
        if (localStorage.getItem(MODE_STORAGE_KEY) === 'ai') setMode('ai');
      } catch {}
    }
    window.addEventListener('pointerdown', closeMenus);
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    request?.abort();
    clearInterval(aiClock);
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
    {#if placement === 'home'}
      <div class="mode-options" role="group" aria-label="Translation engine">
        {#each [{ id: 'local', label: 'Local' }, { id: 'ai', label: 'AI' }] as option (option.id)}
          <button class:active={mode === option.id} type="button" aria-pressed={mode === option.id} disabled={translating} onclick={() => setMode(/** @type {'local' | 'ai'} */ (option.id))}>{option.label}</button>
        {/each}
      </div>
    {/if}
    {#if ai}
      <div class="language-picker">
        <button class="panel-field" type="button" aria-haspopup="menu" aria-expanded={openMenu === 'model'} disabled={translating || !aiStatus} onclick={(event) => toggleMenu('model', event)}>
          <span>Model</span>
          <strong class="model-value"><ModelLabel model={currentAiModel} selected compact /></strong>
        </button>
        {#if openMenu === 'model' && aiStatus}
          <div class="language-menu model-menu" role="menu" transition:scale={{ duration: 125, easing: cubicOut, start: 0.94, opacity: 0 }}>
            {#each aiStatus.models as model (model.id)}
              <ModelOption {model} selected={model.id === aiModel} onSelect={chooseAiModel} />
            {/each}
          </div>
        {/if}
      </div>
      <div class="language-picker">
        <button class="panel-field" type="button" aria-haspopup="menu" aria-expanded={openMenu === 'style'} disabled={translating || !aiStatus} onclick={(event) => toggleMenu('style', event)}>
          <span>Style</span>
          <strong>{aiStyleLabel}</strong>
        </button>
        {#if openMenu === 'style'}
          <div class="language-menu" role="menu" transition:scale={{ duration: 125, easing: cubicOut, start: 0.94, opacity: 0 }}>
            {#each aiStyles as style (style.id)}
              <button class="language-menu-item" class:selected={style.id === aiStyle} role="menuitemradio" aria-checked={style.id === aiStyle} type="button" onclick={() => chooseAiStyle(style.id)}><span>{style.label}</span></button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    {#each ai ? [{ id: 'target', label: 'To', value: targetLanguage }] : [
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
              ><span>{language.label}</span></button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    {#if placement === 'home'}
      <button class="upload-file" type="button" disabled={translating} onclick={chooseFile} title={inputFile?.name}>
        {#if !inputFile}<span class="action-plus" aria-hidden="true"></span>{/if}
        <span>{inputFile ? inputFile.name : 'Upload File'}</span>
      </button>
    {/if}
    <p class:visible={Boolean(error)} class="panel-error" aria-live="polite">{error}</p>
  </section>

  <section class="panel-info">
    {#if ai}
      {#if !aiStatus}
        <h3>AI Translation:</h3>
        <p>Checking the <span>LaTeX engine</span>…</p>
      {:else if !aiStatus.engine}
        <h3>Unavailable:</h3>
        <p>The LaTeX engine is <span>not installed</span> here. Use the Docuflex desktop app.</p>
      {:else if needsQwenDownload}
        <h3>Local Model:</h3><p>Download <span>Qwen 3.5 4B</span> to translate on this Mac.</p>
      {:else if !aiKeyReady}
        <h3>API Key Needed:</h3>
        <p>Uses <span>your OpenRouter key</span>, like the AI chat. Add it in Settings.</p>
      {:else if result}
        <h3>Done:</h3>
        <p>Translated into <span>{translationLanguageLabel(targetLanguage)}</span>{aiStyle === 'match' ? ' with the original layout' : ` as ${aiStyleLabel}`}.</p>
      {:else if translating}
        <h3>Translating:</h3>
        <p>{explainLatexStage(aiProgress) || 'Starting…'}</p>
      {:else}
        <h3>AI Translation:</h3>
        {#if aiStyle === 'match'}
          <p>Rebuilds the PDF in <span>{translationLanguageLabel(targetLanguage)}</span> with the original fonts and layout, then compares it page by page with the original and fixes differences. Uses your API key.</p>
        {:else}
          <p>Translates into <span>{translationLanguageLabel(targetLanguage)}</span> and redesigns the PDF as <span>{aiStyleLabel}</span>, like PDF Enhance. Uses your API key.</p>
        {/if}
      {/if}
    {:else if !status}
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
      {#if ai && aiTex}<button class="panel-link" type="button" onclick={downloadTex}>Save LaTeX Source (.tex)</button>{/if}
      {#if result.missed}<p class="panel-note">Some text couldn’t be replaced and stays in the original language.</p>{/if}
    {:else if ai}
      {#if translating}
        <div class="work-progress" role="status" aria-live="polite">
          <span class="progress-fill"></span>
          <span class="progress-label"><b>{describeLatexStage(aiProgress)}</b><em>{formatElapsed(aiElapsed)}</em></span>
        </div>
        <button class="panel-link" type="button" onclick={() => request?.abort()}>Cancel</button>
      {:else if needsQwenDownload}
        <button class="panel-action" type="button" onclick={openQwenDownload}>Download Qwen</button>
      {:else if aiStatus && !aiKeyReady}
        <button class="panel-action" type="button" onclick={onNeedKey}>
          <img src="/brain.svg" alt="" />
          <span>Add API Key</span>
        </button>
      {:else}
        <button class="panel-action" type="button" disabled={!aiStatus?.engine || !inputFile} onclick={translateWithAi}>
          <img src="/brain.svg" alt="" />
          <span>Translate with AI</span>
        </button>
        {#if aiTex}<button class="panel-link" type="button" onclick={downloadTex}>Save the uncompiled .tex</button>{/if}
      {/if}
    {:else if downloading && download}
      <button class="panel-action secondary" type="button" onclick={downloadModel}>Show download</button>
    {:else if status && !modelReady}
      <button class="panel-action download" type="button" disabled={!status.canDownload} onclick={downloadModel}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
<path d="M12 15V3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M7 10L12 15L17 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
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
    top: 12px;
    left: 13px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    box-sizing: border-box;
    width: min(320px, calc(100% - 26px));
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

  /* Pickers and upload match LatexFilesPanel and ConvertFilesPanel (.output-picker, .upload-file). */
  .panel-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; width: 100%; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; font-size: 19px; letter-spacing: -0.19px; text-align: left; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, opacity 160ms ease; }
  .panel-field:not(:disabled):hover, .panel-field[aria-expanded='true'] { border-color: rgba(0, 0, 0, 0.18); }
  .panel-field:disabled { cursor: default; opacity: 0.55; }
  .panel-field span { white-space: nowrap; }
  .panel-field strong { overflow: hidden; color: rgba(0, 0, 0, 0.75); font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }

  .model-value { display: flex; min-width: 0; max-width: calc(100% - 60px); }
  .language-menu.model-menu { width: 100%; max-height: min(280px, calc(100dvh - 250px)); overflow-y: auto; overscroll-behavior: contain; }

  .language-picker { position: relative; min-width: 0; }
  .language-menu { position: absolute; z-index: 80; top: calc(100% + 8px); right: 0; box-sizing: border-box; width: 226px; max-height: 292px; overflow-y: auto; padding: 4px 5px; border: 1px solid rgba(0, 0, 0, 0.15); border-radius: 15px; background: rgba(255, 255, 255, 0.75); box-shadow: 0 0 100px rgba(0, 0, 0, 0.08); backdrop-filter: blur(4.05px); -webkit-backdrop-filter: blur(4.05px); transform-origin: top right; }
  .language-menu-item { display: flex; align-items: center; box-sizing: border-box; width: 100%; height: 39px; padding: 0 11px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: rgba(0, 0, 0, 0.75); font: inherit; font-size: 20px; letter-spacing: -0.2px; text-align: left; white-space: nowrap; cursor: pointer; transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease; }
  .language-menu-item.selected, .language-menu-item:hover, .language-menu-item:focus-visible { border-color: rgba(0, 0, 0, 0.08); background: rgba(107, 107, 107, 0.05); color: #000; outline: none; }

  /* Same segmented switch as the Compress panel. */
  .mode-options { display: grid; grid-template-columns: repeat(2, 1fr); box-sizing: border-box; height: 48px; padding: 4px; gap: 4px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; }
  .mode-options button { padding: 0 8px; border: 0; border-radius: 11px; background: transparent; color: rgba(0, 0, 0, 0.5); font: inherit; font-size: 19px; letter-spacing: -0.19px; cursor: pointer; transition: color 170ms ease, background-color 220ms cubic-bezier(0.22, 1, 0.36, 1); }
  .mode-options button:hover:not(:disabled) { color: #000; }
  .mode-options button.active { background: #111; color: #fff; }
  .mode-options button:disabled { cursor: default; }

  .upload-file { display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; width: 100%; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; font-size: 19px; letter-spacing: -0.19px; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 160ms ease; }
  .upload-file:hover:not(:disabled) { border-color: rgba(0, 0, 0, 0.18); color: rgba(0, 0, 0, 0.75); }
  .upload-file:active:not(:disabled) { transform: scale(0.985); }
  .upload-file:disabled { cursor: default; opacity: 0.55; }
  .upload-file span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%, -50%); }
  .action-plus::after { transform: translate(-50%, -50%) rotate(90deg); }

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
  .panel-action svg { width: 24px; height: 24px; flex: none; }

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

  .progress-label b { font-weight: 400; }
  .progress-label em { font-size: 17px; font-style: normal; opacity: 0.8; }

  .panel-note {
    margin: -2px 2px 0;
    color: rgba(0, 0, 0, 0.5);
    font-size: 16px;
    line-height: 1.3;
    letter-spacing: -0.16px;
  }

  /* AI progress and links match LatexFilesPanel. */
  .work-progress { position: relative; height: 48px; overflow: hidden; border-radius: 15px; isolation: isolate; }
  .work-progress .progress-fill { position: absolute; inset: 0; width: auto; background: linear-gradient(180deg, #2a8cff 0%, #0878f9 55%, #006ae6 100%); }
  .work-progress .progress-fill::after { display: none; }
  .work-progress .progress-label { gap: 10px; color: #fff; font-size: 18px; letter-spacing: -0.18px; }
  .work-progress .progress-label b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .work-progress .progress-label em { flex: 0 0 auto; }

  .panel-link { justify-self: center; margin: -2px 0 -4px; padding: 2px 6px; border: 0; background: transparent; color: rgba(0, 0, 0, 0.5); font: inherit; font-size: 16px; letter-spacing: -0.16px; cursor: pointer; transition: color 150ms ease; }
  .panel-link:hover { color: #0878f9; }

  .file-input { display: none; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .translate-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { border: 0; filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .panel-fields { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-field { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-field:not(:disabled):hover,
  :global(:root[data-theme="dark"]) .panel-field[aria-expanded='true'] { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .panel-field strong { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .language-menu { border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(24, 24, 24, 0.95); box-shadow: 0 0 100px rgba(0, 0, 0, 0.24); }
  :global(:root[data-theme="dark"]) .language-menu-item { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .language-menu-item.selected,
  :global(:root[data-theme="dark"]) .language-menu-item:hover,
  :global(:root[data-theme="dark"]) .language-menu-item:focus-visible { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.92); outline: none; }
  :global(:root[data-theme="dark"]) .mode-options { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .mode-options button { border: 0; background: transparent; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .mode-options button:hover:not(:disabled) { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .mode-options button.active { background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .upload-file { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .upload-file:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.144); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .action-plus::before,
  :global(:root[data-theme="dark"]) .action-plus::after { background: currentColor; }
  :global(:root[data-theme="dark"]) .panel-error { color: #c83e3e; }
  :global(:root[data-theme="dark"]) .panel-info { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-info h3 { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-info p { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-info p span { color: #0878f9; }
  :global(:root[data-theme="dark"]) .panel-action { border: 0; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .panel-action:hover:not(:disabled) { box-shadow: 0 5px 16px rgba(0, 0, 0, 0.48); }
  :global(:root[data-theme="dark"]) .panel-action img { filter: brightness(0); }
  :global(:root[data-theme="dark"]) .panel-action.download { background: #0878f9; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.6); }
  :global(:root[data-theme="dark"]) .panel-action.download:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.6); }
  :global(:root[data-theme="dark"]) .panel-action.secondary { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .panel-action.secondary:hover { box-shadow: none; border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .spinner { border: 2px solid rgba(0, 0, 0, 0.24); border-top-color: rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .progress-fill { background: linear-gradient(180deg, #2a8cff 0%, #0878f9 55%, #006ae6 100%); }
  :global(:root[data-theme="dark"]) .progress-fill::after { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 24'%3E%3Cpath d='M0 0h4c4 3 4 9 0 12s-4 9 0 12H0z' fill='%23006ae6'/%3E%3C/svg%3E") 0 0 / 10px 24px repeat-y; }
  :global(:root[data-theme="dark"]) .progress-fill::before { background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.026) 45%, transparent 70%) -120% 0 / 60% 100% no-repeat; }
  :global(:root[data-theme="dark"]) .panel-note { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .work-progress .progress-fill { background: linear-gradient(180deg, #2a8cff 0%, #0878f9 55%, #006ae6 100%); }
  :global(:root[data-theme="dark"]) .work-progress .progress-label { color: #111111; }
  :global(:root[data-theme="dark"]) .panel-link { border: 0; background: transparent; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-link:hover { color: #0878f9; }
  /* dark theme: end generated */

  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .work-progress .progress-label { color: #fff; }

</style>
