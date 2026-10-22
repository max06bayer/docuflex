<script>
  import { onDestroy, onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly, scale } from 'svelte/transition';
  import { LatexError, describeLatexStage, explainLatexStage, formatElapsed, latexKeyReady, latexStatus, rememberLatexModel, runLatex, saveFile, storedLatexModel } from '$lib/latex.js';

  /** @type {() => void} */
  export let onClose = () => {};
  /** Opens the generated PDF in a new editor tab. @type {(file: File) => void} */
  export let onOpen = () => {};
  /** Opens Settings at the API key field. @type {() => void} */
  export let onNeedKey = () => {};

  const STYLE_STORAGE_KEY = 'docuflex-latex-style';

  /** @type {import('$lib/latex.js').LatexStatus | null} */
  let status = null;
  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {File | null} */
  let inputFile = null;
  let selectedModel = '';
  let selectedStyle = 'paper';
  let instructions = '';
  /** @type {'model' | 'style' | null} */
  let openMenu = null;
  let converting = false;
  let error = '';
  /** @type {import('$lib/latex.js').LatexProgress | null} */
  let progress = null;
  /** @type {{ file: File; tex: string; attempts: number } | null} */
  let result = null;
  /** The source of a document that never compiled, so it is not lost. */
  let failedTex = '';
  /** @type {AbortController | null} */
  let request = null;
  let startedAt = 0;
  let elapsed = 0;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let clock;

  $: models = status?.models ?? [];
  $: styles = status?.styles ?? [];
  $: currentModel = models.find((model) => model.id === selectedModel);
  $: modelLabel = currentModel?.short ?? currentModel?.name ?? '…';
  $: styleLabel = styles.find((style) => style.id === selectedStyle)?.label ?? '…';
  $: hasKey = latexKeyReady(status);
  $: ready = Boolean(status?.engine && hasKey);
  $: stageText = describeLatexStage(progress);

  onMount(async () => {
    window.addEventListener('pointerdown', closeMenus);
    window.addEventListener('keydown', handleKeydown);
    try {
      const saved = localStorage.getItem(STYLE_STORAGE_KEY);
      if (saved) selectedStyle = saved;
    } catch {}
    try {
      status = await latexStatus();
      selectedModel = storedLatexModel(status);
      if (!status.styles.some((style) => style.id === selectedStyle)) selectedStyle = status.styles[0]?.id ?? 'auto';
    } catch {
      error = 'Could not reach Docuflex.';
    }
  });

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
      error = 'Choose a PDF file to convert.';
      return;
    }
    inputFile = file;
    result = null;
    failedTex = '';
    error = '';
  }

  /** @param {'model' | 'style'} menu @param {MouseEvent} event */
  function toggleMenu(menu, event) {
    event.stopPropagation();
    openMenu = openMenu === menu ? null : menu;
  }

  /** @param {string} id */
  function chooseModel(id) {
    selectedModel = id;
    openMenu = null;
    rememberLatexModel(id);
  }

  /** @param {string} id */
  function chooseStyle(id) {
    selectedStyle = id;
    openMenu = null;
    try {
      localStorage.setItem(STYLE_STORAGE_KEY, id);
    } catch {}
  }

  async function convert() {
    if (converting || !inputFile) return;
    if (!hasKey) {
      onNeedKey();
      return;
    }
    error = '';
    result = null;
    failedTex = '';
    converting = true;
    request = new AbortController();
    startedAt = Date.now();
    elapsed = 0;
    clock = setInterval(() => (elapsed = Math.floor((Date.now() - startedAt) / 1000)), 1000);
    const source = inputFile;
    try {
      result = await runLatex({
        file: source,
        status: /** @type {import('$lib/latex.js').LatexStatus} */ (status),
        model: selectedModel,
        style: selectedStyle,
        instructions: instructions.trim(),
        outputName: `${source.name.replace(/\.pdf$/i, '') || 'document'}-latex.pdf`,
        signal: request.signal,
        onProgress: (next) => (progress = next)
      });
    } catch (failure) {
      if (request?.signal.aborted) return;
      console.error(failure);
      if (failure instanceof LatexError) failedTex = failure.tex;
      error = failure instanceof Error ? failure.message : 'Could not convert this PDF.';
    } finally {
      converting = false;
      progress = null;
      request = null;
      clearInterval(clock);
    }
  }

  function cancel() {
    request?.abort();
  }

  function downloadResult() {
    if (result) saveFile(result.file, result.file.name);
  }

  function downloadTex() {
    const tex = result?.tex || failedTex;
    if (!tex) return;
    const base = (inputFile?.name ?? 'document.pdf').replace(/\.pdf$/i, '') || 'document';
    saveFile(new Blob([tex], { type: 'application/x-tex' }), `${base}.tex`);
  }

  function openResult() {
    if (!result) return;
    onOpen(result.file);
    onClose();
  }

  /** @param {PointerEvent} event */
  function closeMenus(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.output-picker')) openMenu = null;
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (openMenu) openMenu = null;
    else if (!converting) onClose();
  }

  onDestroy(() => {
    request?.abort();
    clearInterval(clock);
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', closeMenus);
    window.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="latex-panel" role="dialog" aria-label="PDF Enhance (LaTeX)" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/brain.svg" alt="" />
    <h2>PDF Enhance (LaTeX)</h2>
    <button class="panel-close" type="button" aria-label="Close PDF Enhance" onclick={onClose}></button>
  </header>

  <section class="panel-fields">
    {#each [
      { id: 'model', label: 'Model', value: modelLabel },
      { id: 'style', label: 'Style', value: styleLabel }
    ] as picker (picker.id)}
      <div class="output-picker">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={openMenu === picker.id}
          disabled={converting || !status}
          onclick={(event) => toggleMenu(/** @type {'model' | 'style'} */ (picker.id), event)}
        >
          <span>{picker.label}</span>
          <strong>{picker.value}</strong>
        </button>
        {#if openMenu === picker.id}
          <div class="output-menu" role="menu" transition:scale={{ duration: 125, easing: cubicOut, start: 0.94, opacity: 0 }}>
            {#each picker.id === 'model' ? models.map((model) => ({ id: model.id, label: model.name })) : styles as option (option.id)}
              {@const selected = option.id === (picker.id === 'model' ? selectedModel : selectedStyle)}
              <button
                class="output-menu-item"
                class:active={selected}
                role="menuitemradio"
                aria-checked={selected}
                type="button"
                onclick={() => (picker.id === 'model' ? chooseModel(option.id) : chooseStyle(option.id))}
              ><span>{option.label}</span></button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    <button class="upload-file" type="button" disabled={converting} onclick={chooseFile} title={inputFile?.name}>
      {#if !inputFile}<span class="action-plus" aria-hidden="true"></span>{/if}
      <span>{inputFile ? inputFile.name : 'Upload File'}</span>
    </button>
    <textarea
      class="instructions-field"
      rows="2"
      maxlength="2000"
      placeholder="Wishes (optional)"
      aria-label="Extra wishes for the document"
      disabled={converting}
      bind:value={instructions}
    ></textarea>
    <p class:visible={Boolean(error)} class="panel-error" aria-live="polite">{error}</p>
  </section>

  <section class="panel-info">
    {#if !status}
      <h3>PDF Enhance:</h3>
      <p>Checking the <span>LaTeX engine</span>…</p>
    {:else if !status.engine}
      <h3>Unavailable:</h3>
      <p>The LaTeX engine is <span>not installed</span> here. Use the Docuflex desktop app.</p>
    {:else if !hasKey}
      <h3>API Key Needed:</h3>
      <p>Uses <span>your OpenRouter key</span>, like the AI chat. Add it in Settings.</p>
    {:else if converting}
      <h3>Converting:</h3>
      <p>{explainLatexStage(progress) || 'Starting…'}</p>
    {:else if result}
      <h3>Done:</h3>
      <p>Compiled <span>{result.file.name}</span>{result.attempts > 1 ? ` after ${result.attempts} attempts` : ''}.</p>
    {:else}
      <h3>How it Works:</h3>
      <p>The AI reads your PDF or scan and redesigns it as a <span>professional LaTeX</span> document with charts, diagrams and tables. Uses your API key.</p>
    {/if}
  </section>

  <footer class="panel-actions">
    {#if result}
      <div class="result-actions">
        <button class="panel-action" type="button" onclick={openResult}>Open</button>
        <button class="panel-action secondary" type="button" onclick={downloadResult}>Save PDF</button>
      </div>
      <button class="panel-link" type="button" onclick={downloadTex}>Save LaTeX Source (.tex)</button>
    {:else if converting}
      <div class="work-progress" role="status" aria-live="polite">
        <span class="progress-fill"></span>
        <span class="progress-label"><b>{stageText}</b><em>{formatElapsed(elapsed)}</em></span>
      </div>
      <button class="panel-link" type="button" onclick={cancel}>Cancel</button>
    {:else if status && !hasKey}
      <button class="panel-action" type="button" onclick={onNeedKey}>
        <img src="/brain.svg" alt="" />
        <span>Add API Key</span>
      </button>
    {:else}
      <button class="panel-action" type="button" disabled={!ready || !inputFile} onclick={convert}>
        <img src="/brain.svg" alt="" />
        <span>Enhance</span>
      </button>
      {#if failedTex}<button class="panel-link" type="button" onclick={downloadTex}>Save the uncompiled .tex</button>{/if}
    {/if}
  </footer>

  <input bind:this={fileInput} class="file-input" type="file" accept="application/pdf,.pdf" onchange={handleFile} />
</div>

<style>
  /* Mirrors TranslateFilesPanel, the other home panel with pickers. */
  .latex-panel {
    position: absolute;
    z-index: 45;
    top: 12px;
    left: 13px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    box-sizing: border-box;
    width: min(320px, calc(100% - 26px));
    max-height: calc(100% - 24px);
    overflow-y: auto;
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

  /* Pickers and upload match ConvertFilesPanel (.output-picker, .convert-action.upload). */
  .output-picker { position: relative; min-width: 0; }
  .output-picker > button { display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; width: 100%; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; font-size: 19px; letter-spacing: -0.19px; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 160ms ease, opacity 160ms ease; }
  .output-picker > button:hover:not(:disabled), .output-picker > button[aria-expanded='true'] { border-color: rgba(0, 0, 0, 0.18); }
  .output-picker > button:disabled { cursor: default; opacity: 0.55; }
  .output-picker span { white-space: nowrap; }
  .output-picker strong { overflow: hidden; color: rgba(0, 0, 0, 0.75); font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
  .output-menu { position: absolute; z-index: 80; top: calc(100% + 8px); right: 0; box-sizing: border-box; width: 226px; padding: 4px 5px; border: 1px solid rgba(0, 0, 0, 0.15); border-radius: 15px; background: rgba(255, 255, 255, 0.75); box-shadow: 0 0 100px rgba(0, 0, 0, 0.08); backdrop-filter: blur(4.05px); -webkit-backdrop-filter: blur(4.05px); transform-origin: top right; }
  .output-menu-item { display: flex; align-items: center; box-sizing: border-box; width: 100%; height: 39px; padding: 0 11px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: rgba(0, 0, 0, 0.75); font: inherit; font-size: 20px; letter-spacing: -0.2px; text-align: left; white-space: nowrap; cursor: pointer; transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease; }
  .output-menu-item.active, .output-menu-item:hover { border-color: rgba(0, 0, 0, 0.08); background: rgba(107, 107, 107, 0.05); color: #000; }

  .upload-file { display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; width: 100%; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; font-size: 19px; letter-spacing: -0.19px; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 160ms ease; }
  .upload-file:hover:not(:disabled) { border-color: rgba(0, 0, 0, 0.18); color: rgba(0, 0, 0, 0.75); }
  .upload-file:active:not(:disabled) { transform: scale(0.985); }
  .upload-file:disabled { cursor: default; opacity: 0.55; }
  .upload-file span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%, -50%); }
  .action-plus::after { transform: translate(-50%, -50%) rotate(90deg); }

  .instructions-field { display: block; box-sizing: border-box; width: 100%; min-height: 48px; padding: 12px 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; outline: 0; background: #fff; color: rgba(0, 0, 0, 0.75); font: inherit; font-size: 19px; line-height: 1.25; letter-spacing: -0.19px; resize: none; transition: border-color 150ms ease; }
  .instructions-field:focus { border-color: rgba(0, 0, 0, 0.18); }
  .instructions-field::placeholder { color: rgba(0, 0, 0, 0.5); opacity: 1; }

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
  .panel-action img { width: 24px; height: 24px; filter: brightness(0) invert(1); }

  .panel-action.secondary {
    border: 1px solid rgba(0, 0, 0, 0.1);
    background: #fff;
    color: rgba(0, 0, 0, 0.75);
  }

  .panel-action.secondary:hover { box-shadow: none; border-color: rgba(0, 0, 0, 0.18); }

  .panel-link {
    justify-self: center;
    margin: -2px 0 -4px;
    padding: 2px 6px;
    border: 0;
    background: transparent;
    color: rgba(0, 0, 0, 0.5);
    font: inherit;
    font-size: 16px;
    letter-spacing: -0.16px;
    cursor: pointer;
    transition: color 150ms ease;
  }

  .panel-link:hover { color: #0878f9; }

  /* Same blue bar as the Translate model download, running indeterminately while the AI works. */
  .work-progress {
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
    inset: 0;
    background: linear-gradient(180deg, #2a8cff 0%, #0878f9 55%, #006ae6 100%);
  }

  .progress-fill::before {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.22) 45%, transparent 70%) -120% 0 / 60% 100% no-repeat;
    content: '';
    animation: progress-sheen 2.2s ease-in-out infinite;
  }

  @keyframes progress-sheen { to { background-position: 220% 0; } }

  .progress-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 16px;
    color: #fff;
    font-size: 18px;
    letter-spacing: -0.18px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .progress-label b { overflow: hidden; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
  .progress-label em { flex: 0 0 auto; font-size: 17px; font-style: normal; opacity: 0.8; }

  .file-input { display: none; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .latex-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { border: 0; filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .panel-fields { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .output-picker > button { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .output-picker > button:hover:not(:disabled),
  :global(:root[data-theme="dark"]) .output-picker > button[aria-expanded='true'] { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .output-picker strong { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .output-menu { border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(24, 24, 24, 0.95); box-shadow: 0 0 100px rgba(0, 0, 0, 0.24); }
  :global(:root[data-theme="dark"]) .output-menu-item { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .output-menu-item.active,
  :global(:root[data-theme="dark"]) .output-menu-item:hover { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .upload-file { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .upload-file:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.144); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .action-plus::before,
  :global(:root[data-theme="dark"]) .action-plus::after { background: currentColor; }
  :global(:root[data-theme="dark"]) .instructions-field { border: 1px solid rgba(255, 255, 255, 0.08); outline: 0; background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .instructions-field:focus { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .instructions-field::placeholder { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-error { color: #c83e3e; }
  :global(:root[data-theme="dark"]) .panel-info { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-info h3 { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-info p { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-info p span { color: #0878f9; }
  :global(:root[data-theme="dark"]) .panel-action { border: 0; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .panel-action:hover:not(:disabled) { box-shadow: 0 5px 16px rgba(0, 0, 0, 0.48); }
  :global(:root[data-theme="dark"]) .panel-action img { filter: brightness(0); }
  :global(:root[data-theme="dark"]) .panel-action.secondary { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .panel-action.secondary:hover { box-shadow: none; border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .panel-link { border: 0; background: transparent; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-link:hover { color: #0878f9; }
  :global(:root[data-theme="dark"]) .work-progress { background: rgba(8, 120, 249, 0.1); box-shadow: inset 0 0 0 1px rgba(8, 120, 249, 0.48); }
  :global(:root[data-theme="dark"]) .progress-fill { background: linear-gradient(180deg, #2a8cff 0%, #0878f9 55%, #006ae6 100%); }
  :global(:root[data-theme="dark"]) .progress-fill::before { background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.026) 45%, transparent 70%) -120% 0 / 60% 100% no-repeat; }
  :global(:root[data-theme="dark"]) .progress-label { color: #111111; }
  /* dark theme: end generated */

  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .progress-label { color: #fff; }

</style>
