<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import PdfEditor from '$lib/PdfEditor.svelte';
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/geist/wght.css';
  import mergeIcon from '../../public/quicktools/merge.svg?raw';
  import splitIcon from '../../public/quicktools/split.svg?raw';
  import convertIcon from '../../public/quicktools/convert.svg?raw';
  import compressIcon from '../../public/quicktools/compress.svg?raw';
  import signIcon from '../../public/quicktools/sign.svg?raw';
  import protectIcon from '../../public/quicktools/protect.svg?raw';
  import translateIcon from '../../public/quicktools/translate.svg?raw';
  import flattenIcon from '../../public/quicktools/flatten.svg?raw';
  import ocrIcon from '../../public/quicktools/ocr.svg?raw';
  import expandIcon from '../../public/expand.svg?raw';
  import bigPlusIcon from '../../public/bigplus.svg?raw';

  const quickTools = [
    { name: 'Merge', shortcut: 'M', icon: mergeIcon },
    { name: 'Split', shortcut: 'L', icon: splitIcon },
    { name: 'Convert', shortcut: 'C', icon: convertIcon, wide: true },
    { name: 'Compress', shortcut: 'R', icon: compressIcon },
    { name: 'Sign', shortcut: 'S', icon: signIcon },
    { name: 'Protect', shortcut: 'P', icon: protectIcon },
    { name: 'Translate', shortcut: 'T', icon: translateIcon },
    { name: 'Flatten', shortcut: 'F', icon: flattenIcon },
    { name: 'OCR', shortcut: 'O', icon: ocrIcon }
  ];

  /** @type {{ id: number; name: string; type: 'pdf'; file: File }[]} */
  let tabs = [];
  /** @type {{ name: string; file: File }[]} */
  let recentDocuments = [];
  /** @type {number | null} */
  let activeTab = null;
  let nextTabId = 1;
  let closingTabs = new Set();
  let sortExpanded = false;
  let activeShortcut = '';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let shortcutTimer;
  /** @type {{ id: number; name: string; type: 'pdf'; file: File } | undefined} */
  let activeDocument;
  $: activeDocument = tabs.find((tab) => tab.id === activeTab);
  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {{ downloadPdf: () => Promise<void> } | undefined} */
  let pdfEditor;
  let isDownloading = false;

  /** @param {MouseEvent | KeyboardEvent} event @param {number} id */
  function closeTab(event, id) {
    event.stopPropagation();
    if (closingTabs.has(id)) return;
    closingTabs = new Set([...closingTabs, id]);
    window.setTimeout(() => finishClosingTab(id), 110);
  }

  /** @param {number} id */
  async function finishClosingTab(id) {
    const movingElements = [...document.querySelectorAll('[data-tab-motion]')];
    const previousLeft = new Map(movingElements.map((element) => [element.getAttribute('data-tab-motion'), element.getBoundingClientRect().left]));
    const index = tabs.findIndex((tab) => tab.id === id);
    tabs = tabs.filter((tab) => tab.id !== id);
    closingTabs = new Set([...closingTabs].filter((tabId) => tabId !== id));
    if (activeTab === id) {
      activeTab = tabs[index]?.id ?? tabs[index - 1]?.id ?? null;
    }
    await tick();
    document.querySelectorAll('[data-tab-motion]').forEach((element) => {
      const oldLeft = previousLeft.get(element.getAttribute('data-tab-motion'));
      if (oldLeft === undefined) return;
      const delta = oldLeft - element.getBoundingClientRect().left;
      if (Math.abs(delta) < 0.5) return;
      element.animate(
        [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
        { duration: 155, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
    });
  }

  function openFilePicker() {
    fileInput?.click();
  }

  async function downloadActiveDocument() {
    if (!pdfEditor || isDownloading) return;
    isDownloading = true;
    try {
      await pdfEditor.downloadPdf();
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not export this PDF.');
    } finally {
      isDownloading = false;
    }
  }

  /** @param {Event} event */
  function handleFileSelection(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0];
    if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) return;
    addFileTab(file);
    input.value = '';
  }

  /** @param {DragEvent} event */
  function handleFileDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) return;
    addFileTab(file);
  }

  /** @param {File} file */
  function addFileTab(file) {
    const id = nextTabId++;
    tabs = [...tabs, { id, name: file.name, type: 'pdf', file }];
    recentDocuments = [{ name: file.name, file }, ...recentDocuments.filter((document) => document.name !== file.name)];
    activeTab = id;
  }

  /** @param {{ name: string; file: File }} document */
  function openRecentDocument(document) {
    const existing = tabs.find((tab) => tab.name === document.name);
    if (existing) {
      activeTab = existing.id;
      return;
    }
    addFileTab(document.file);
  }

  /** @param {KeyboardEvent} event */
  function handleQuickToolShortcut(event) {
    const target = event.target;
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
    const shortcut = event.key.toUpperCase();
    if (!quickTools.some((tool) => tool.shortcut === shortcut)) return;
    const button = document.querySelector(`.quick-tool[data-shortcut="${shortcut.toLowerCase()}"]`);
    if (!(button instanceof HTMLButtonElement)) return;
    event.preventDefault();
    button.click();
    activeShortcut = shortcut;
    if (shortcutTimer) clearTimeout(shortcutTimer);
    shortcutTimer = setTimeout(() => (activeShortcut = ''), 150);
  }

  onMount(() => {
    window.addEventListener('keydown', handleQuickToolShortcut);
    return () => window.removeEventListener('keydown', handleQuickToolShortcut);
  });

  onDestroy(() => {
    if (shortcutTimer) clearTimeout(shortcutTimer);
  });
</script>

<svelte:head>
  <title>Docuflex Editor</title>
  <meta name="description" content="Docuflex document editor" />
</svelte:head>

<main class="editor-shell" class:editor-mode={activeTab !== null}>
  <header class="topbar">
    <div class="brand-area">
      <button class="logo-button" aria-label="Go to Home" title="Home" onclick={() => (activeTab = null)}>
        <img class="logo" src="/logo.svg" alt="Docuflex" />
      </button>
      <nav class="history" aria-label="History navigation">
        <button class="plain-button" aria-label="Go back" title="Go back">
          <img src="/arrowleft.svg" alt="" />
        </button>
        <button class="plain-button" aria-label="Go forward" title="Go forward">
          <img src="/arrowright.svg" alt="" />
        </button>
      </nav>
    </div>

    <div class="tab-strip" role="tablist" aria-label="Open documents">
      {#each tabs as tab (tab.id)}
        <button
          class:active={tab.id === activeTab}
          class:closing={closingTabs.has(tab.id)}
          class="document-tab"
          data-tab-motion={`tab-${tab.id}`}
          role="tab"
          aria-selected={tab.id === activeTab}
          onclick={() => (activeTab = tab.id)}
        >
          <img src="/pdficon.svg" alt="" />
          <span class="tab-title" class:long-title={tab.name.length > 22}>{tab.name}</span>
          <span
            class="close-tab"
            role="button"
            tabindex="0"
            aria-label={`Close ${tab.name}`}
            onclick={(event) => closeTab(event, tab.id)}
            onkeydown={(event) => (event.key === 'Enter' || event.key === ' ') && closeTab(event, tab.id)}
          >
            <img src="/close.svg" alt="" />
          </span>
        </button>
      {/each}

      <button class="add-tab" data-tab-motion="add" aria-label="Open another document" title="Open document" onclick={openFilePicker}>
        <img src="/plus.svg" alt="" />
      </button>
    </div>

    <nav class="utilities" aria-label="Editor utilities">
      {#if activeTab !== null}
        <button
          class="utility-button"
          aria-label={isDownloading ? 'Exporting PDF' : 'Download'}
          title={isDownloading ? 'Exporting PDF…' : 'Download'}
          disabled={isDownloading}
          onclick={downloadActiveDocument}
        >
          <img src="/download.svg" alt="" />
        </button>
      {/if}
      {#each [
        { id: 'home', icon: '/home.svg', label: 'Home' },
        { id: 'search', icon: '/search.svg', label: 'Search' },
        { id: 'assistant', icon: '/brain.svg', label: 'AI assistant' },
        { id: 'settings', icon: '/settings.svg', label: 'Settings' }
      ] as utility}
        <button
          class="utility-button"
          aria-label={utility.label}
          title={utility.label}
          onclick={() => utility.id === 'home' && (activeTab = null)}
        >
          <img src={utility.icon} alt="" />
        </button>
      {/each}
    </nav>
  </header>

  {#if activeTab === null || !activeDocument}
  <aside class="sidebar" aria-label="Document tools">
    <div class="quick-tools">
      {#each quickTools as tool}
        <button class="quick-tool" class:wide-icon={tool.wide} class:keyboard-active={activeShortcut === tool.shortcut} data-tool={tool.name.toLowerCase()} data-shortcut={tool.shortcut.toLowerCase()} aria-label={tool.name} title={tool.name}>
          <span class="quick-tool-icon" aria-hidden="true">{@html tool.icon}</span>
          <span class="quick-tool-name">{tool.name}</span>
          <kbd>{tool.shortcut}</kbd>
        </button>
      {/each}
    </div>
  </aside>
  <section class="workspace" aria-label="Document workspace">
    <button class="drop-zone" aria-label="Open or drop a document" onclick={openFilePicker} ondragover={(event) => event.preventDefault()} ondrop={handleFileDrop}>
      <span class="drop-zone-content">
        <img src="/bigplus.svg" alt="" />
        <span>Drop any Document to edit</span>
      </span>
    </button>

    <div class="document-browser">
      <button class="recent-heading">
        <span>Recent Documents</span>
        <span class="recent-arrow" aria-hidden="true">{@html expandIcon}</span>
      </button>

      <label class="document-search">
        <img src="/search.svg" alt="" />
        <input type="search" placeholder="Search" aria-label="Search recent documents" />
      </label>

      <div class="browser-actions">
        <div class="sort-button">
          <span>Sort By: <strong>Recent</strong></span>
          <button class="sort-arrow" class:expanded={sortExpanded} aria-label="Toggle sort options" aria-expanded={sortExpanded} onclick={() => (sortExpanded = !sortExpanded)}>
            <img src="/arrowright.svg" alt="" />
          </button>
        </div>
        <button class="filter-button">
          <span>Filter: <strong>0</strong></span>
          <img src="/filter.svg" alt="" />
        </button>
      </div>
    </div>

    <div class="recent-grid">
      {#each recentDocuments as document}
        <button class="recent-document" aria-label={`Open ${document.name}`} onclick={() => openRecentDocument(document)}>
          <span class="document-preview" aria-hidden="true"></span>
          <span class="document-name"><span>{document.name}</span></span>
        </button>
      {/each}

      <button class="recent-document open-document" aria-label="Open document" onclick={openFilePicker}>
        <span class="document-preview">
          <span class="open-document-plus" aria-hidden="true">{@html bigPlusIcon}</span>
        </span>
        <span class="document-name"><span>Open Document</span></span>
      </button>
    </div>
  </section>
  {:else}
    {#key activeDocument.id}
      <PdfEditor file={activeDocument.file} bind:this={pdfEditor} />
    {/key}
  {/if}

  <input bind:this={fileInput} class="file-input" type="file" accept="application/pdf,.pdf" onchange={handleFileSelection} />

</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html),
  :global(body) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
  }

  :global(body) {
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #111;
    background: #f5f5f5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  :global(button) {
    font: inherit;
  }

  .editor-shell {
    --ui-scale: 0.85;
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr);
    grid-template-rows: 56px minmax(0, 1fr);
    width: 117.6470588vw;
    height: 117.6470588dvh;
    min-width: 760px;
    background: #f5f5f5;
    zoom: var(--ui-scale);
  }

  .topbar {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr) auto;
    height: 56px;
    background: #fff;
    border-bottom: 1px solid #cecece;
    overflow: hidden;
  }

  .brand-area {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    padding: 0 17px 0 21px;
    border-right: 1px solid #cfcfcf;
  }

  .logo {
    display: block;
    width: 187px;
    height: 41px;
    flex: 0 0 auto;
  }

  .logo-button {
    display: grid;
    place-items: center;
    width: 187px;
    height: 41px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .history {
    display: flex;
    align-items: center;
    gap: 22px;
    margin-left: 12px;
  }

  .plain-button,
  .add-tab {
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    transition: opacity 150ms ease;
  }

  .plain-button {
    position: relative;
    width: 18px;
    height: 22px;
  }

  .plain-button img {
    width: 16px;
    height: 17px;
    transition: filter 150ms ease, opacity 150ms ease, transform 150ms ease;
  }

  .plain-button::after {
    position: absolute;
    width: 16px;
    height: 17px;
    background: #000;
    content: "";
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms ease, transform 150ms ease;
    -webkit-mask: center / contain no-repeat;
    mask: center / contain no-repeat;
  }

  .plain-button:first-child::after {
    -webkit-mask-image: url('/arrowleft.svg');
    mask-image: url('/arrowleft.svg');
  }

  .plain-button:last-child::after {
    -webkit-mask-image: url('/arrowright.svg');
    mask-image: url('/arrowright.svg');
  }

  .plain-button:hover::after {
    opacity: 0.7;
  }

  .tab-strip {
    display: flex;
    min-width: 0;
    height: 55px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tab-strip::-webkit-scrollbar {
    display: none;
  }

  .document-tab {
    display: flex;
    align-items: center;
    gap: 11px;
    flex: 0 0 auto;
    max-width: 300px;
    height: 55px;
    padding: 0 18px;
    border: 0;
    border-right: 1px solid #dedede;
    background: #f8f8f8;
    color: #111;
    font-size: 18px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 180ms ease, color 180ms ease, opacity 110ms ease;
  }

  .tab-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .tab-title.long-title {
    padding-right: 24px;
    -webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 26px), transparent 100%);
    mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 26px), transparent 100%);
  }

  .document-tab.active {
    background: #e9e9e9;
  }

  .document-tab.closing {
    opacity: 0;
    pointer-events: none;
  }

  .document-tab img {
    /* Resolves to exactly 18px after the editor's 0.85 scale in WebKit. */
    width: 21.1764706px;
    height: 21.1764706px;
    flex: 0 0 auto;
    image-rendering: -webkit-optimize-contrast;
    transform: translateZ(0);
    backface-visibility: hidden;
    transition: filter 160ms ease, opacity 160ms ease;
  }

  .close-tab {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-left: 2px;
    border-radius: 0;
    transition: opacity 150ms ease;
  }

  .close-tab img {
    width: 13px;
    height: 13px;
    transition: filter 150ms ease, transform 150ms ease;
  }

  .add-tab {
    flex: 0 0 57px;
    width: 57px;
    height: 55px;
  }

  .add-tab img {
    width: 18px;
    height: 18px;
    transition: filter 150ms ease, transform 150ms ease;
  }

  .utilities {
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 55px;
    padding: 0 9px 0 14px;
    background: #fff;
    box-shadow: -12px 0 18px rgba(255, 255, 255, 0.96);
  }

  .utility-button {
    display: grid;
    place-items: center;
    width: 41px;
    height: 41px;
    padding: 0;
    border: 1px solid #dedede;
    border-radius: 10px;
    background: #f8f8f8;
    cursor: pointer;
    transition: background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
  }

  .utility-button:hover {
    border-color: #c8c8c8;
    background: #eee;
  }

  .utility-button:disabled {
    cursor: progress;
    opacity: 0.55;
  }

  .utility-button img {
    width: 24px;
    height: 24px;
    transition: filter 160ms ease, opacity 160ms ease, transform 160ms ease;
  }

  .plain-button:hover img,
  .add-tab:hover img,
  .close-tab:hover img,
  .utility-button:hover img {
    filter: brightness(0.72);
  }

  .plain-button:active img,
  .add-tab:active img,
  .close-tab:active img,
  .utility-button:active img {
    transform: scale(0.94);
  }

  .plain-button:active::after {
    transform: scale(0.94);
  }

  @media (prefers-reduced-motion: reduce) {
    .plain-button,
    .plain-button img,
    .add-tab,
    .add-tab img,
    .document-tab,
    .document-tab img,
    .close-tab,
    .close-tab img,
    .utility-button,
    .utility-button img,
    .quick-tool,
    .quick-tool-icon :global(svg),
    .quick-tool kbd {
      transition: none;
    }
  }

  .utility-button:nth-child(3) img {
    width: 23px;
  }

  .utility-button:nth-child(4) img {
    width: 26px;
    height: 26px;
  }

  .sidebar {
    grid-column: 1;
    grid-row: 2;
    min-height: 0;
    overflow-y: auto;
    background: #f1f1f1;
    border-right: 1px solid #cfcfcf;
    box-shadow: inset -11px 0 25px 0 rgba(0, 0, 0, 0.03);
    scrollbar-width: none;
  }

  .sidebar::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }

  .quick-tools {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 12px 0;
  }

  .quick-tool {
    display: flex;
    align-items: center;
    width: 286px;
    height: 61px;
    min-height: 61px;
    padding: 0 15px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: rgba(107, 107, 107, 0.05);
    color: rgba(0, 0, 0, 0.7);
    cursor: pointer;
    transition: background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, transform 160ms ease;
  }

  .quick-tool-icon {
    display: grid;
    place-items: center;
    justify-items: start;
    flex: 0 0 42px;
    height: 39px;
    overflow: visible;
    line-height: 0;
  }

  .quick-tool-icon :global(svg) {
    display: block;
    width: auto;
    height: auto;
    max-width: 35px;
    max-height: 39px;
    overflow: visible;
    transition: transform 160ms ease;
  }

  .quick-tool[data-tool="merge"] .quick-tool-icon :global(svg) {
    width: 27px;
    height: 27px;
  }

  .quick-tool.wide-icon .quick-tool-icon {
    flex-basis: 117px;
    justify-content: start;
  }

  .quick-tool.wide-icon .quick-tool-icon :global(svg) {
    width: 99px;
    max-width: 99px;
    height: 27px;
  }

  .quick-tool[data-tool="split"] .quick-tool-icon {
    flex-basis: 45px;
  }

  .quick-tool[data-tool="compress"] .quick-tool-icon {
    flex-basis: 45px;
  }

  .quick-tool[data-tool="sign"] {
    padding-left: 12px;
  }

  .quick-tool[data-tool="sign"] .quick-tool-icon,
  .quick-tool[data-tool="translate"] .quick-tool-icon {
    flex-basis: 38px;
  }

  .quick-tool[data-tool="protect"] {
    padding-left: 9px;
  }

  .quick-tool[data-tool="protect"] .quick-tool-icon {
    flex-basis: 41px;
  }

  .quick-tool[data-tool="translate"],
  .quick-tool[data-tool="flatten"],
  .quick-tool[data-tool="ocr"] {
    padding-left: 12px;
  }

  .quick-tool[data-tool="flatten"] .quick-tool-icon,
  .quick-tool[data-tool="ocr"] .quick-tool-icon {
    flex-basis: 40px;
  }

  .quick-tool-name {
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.2px;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
  }

  .quick-tool kbd {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    margin-left: auto;
    border: 1px solid rgba(0, 0, 0, 0.04);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.055);
    color: rgba(0, 0, 0, 0.165);
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 1.8px;
    text-indent: 1.8px;
    transition: background-color 160ms ease, color 160ms ease;
    -webkit-font-smoothing: antialiased;
  }

  .quick-tool:hover,
  .quick-tool.keyboard-active {
    border-color: rgba(0, 0, 0, 0.13);
    background: rgba(107, 107, 107, 0.09);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.035);
  }

  .quick-tool-icon :global([stroke="#777777"]),
  .quick-tool-icon :global([stroke="#7C7D7F"]),
  .quick-tool-icon :global([stroke="#888888"]),
  .quick-tool-icon :global([stroke="#404040"]),
  .quick-tool-icon :global([stroke="black"]) {
    transition: filter 160ms ease, stroke-opacity 160ms ease;
  }

  .quick-tool:hover .quick-tool-icon :global([stroke="#777777"]),
  .quick-tool:hover .quick-tool-icon :global([stroke="#7C7D7F"]),
  .quick-tool:hover .quick-tool-icon :global([stroke="#888888"]),
  .quick-tool:hover .quick-tool-icon :global([stroke="#404040"]),
  .quick-tool:hover .quick-tool-icon :global([stroke="black"]),
  .quick-tool.keyboard-active .quick-tool-icon :global([stroke="#777777"]),
  .quick-tool.keyboard-active .quick-tool-icon :global([stroke="#7C7D7F"]),
  .quick-tool.keyboard-active .quick-tool-icon :global([stroke="#888888"]),
  .quick-tool.keyboard-active .quick-tool-icon :global([stroke="#404040"]),
  .quick-tool.keyboard-active .quick-tool-icon :global([stroke="black"]) {
    filter: brightness(0.7);
    stroke-opacity: 1;
  }

  .quick-tool:hover kbd,
  .quick-tool.keyboard-active kbd {
    background: rgba(0, 0, 0, 0.075);
    color: rgba(0, 0, 0, 0.25);
  }

  .quick-tool:active {
    transform: scale(0.985);
  }

  .quick-tool.keyboard-active {
    transform: scale(0.985);
  }

  .quick-tool:active .quick-tool-icon :global(svg) {
    transform: scale(0.96);
  }

  .workspace {
    grid-column: 2;
    grid-row: 2;
    display: grid;
    grid-template-rows: 155px 65px minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    background: #f5f5f5;
  }

  .drop-zone {
    position: relative;
    display: grid;
    grid-row: 1;
    place-items: center;
    height: 126px;
    margin: 14px 17px 15px 14px;
    padding: 0;
    overflow: hidden;
    border: 1px solid rgba(202, 202, 202, 0.65);
    border-radius: 12px;
    background: rgba(83, 83, 83, 0.05) url('/pattern.jpg') center / cover;
    color: rgba(0, 0, 0, 0.375);
    cursor: pointer;
    transition: border-color 180ms ease, box-shadow 180ms ease, color 180ms ease;
  }

  .drop-zone::after {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 18px rgba(0, 0, 0, 0.025);
    content: "";
    pointer-events: none;
  }

  .drop-zone-content {
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 13px;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 28px;
    font-weight: 200;
    line-height: 1;
    letter-spacing: -0.28px;
    -webkit-font-smoothing: antialiased;
  }

  .drop-zone-content img {
    width: 24px;
    height: 24px;
    transition: filter 160ms ease, transform 180ms ease;
  }

  .drop-zone:hover {
    border-color: rgba(150, 150, 150, 0.7);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.035);
    color: rgba(0, 0, 0, 0.55);
  }

  .drop-zone:hover .drop-zone-content img {
    filter: brightness(0.78);
    transform: scale(1.04);
  }

  .drop-zone:active .drop-zone-content img {
    transform: scale(0.96);
  }

  .drop-zone:active {
    color: rgba(0, 0, 0, 0.65);
  }

  .document-browser {
    display: flex;
    align-items: center;
    grid-row: 2;
    height: 65px;
    padding: 0 42px;
    border-top: 1px solid #e0e0e0;
    border-bottom: 1px solid #e0e0e0;
    background: rgba(255, 255, 255, 0.65);
    color: rgba(0, 0, 0, 0.7);
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 18px;
    font-weight: 400;
    letter-spacing: -0.18px;
    -webkit-font-smoothing: antialiased;
  }

  .recent-heading {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 200px;
    height: 40px;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(0, 0, 0, 0.7);
    cursor: pointer;
    white-space: nowrap;
    transition: color 160ms ease;
  }

  .recent-arrow {
    display: grid;
    place-items: center;
    width: 17px;
    height: 9px;
    transform: translateY(2px);
  }

  .recent-arrow :global(svg) {
    display: block;
    width: 17px;
    height: 9px;
    overflow: visible;
  }

  .recent-arrow :global(path) {
    transition: stroke-opacity 160ms ease;
  }

  .recent-heading:hover {
    color: rgba(0, 0, 0, 0.9);
  }

  .recent-heading:hover .recent-arrow :global(path) {
    stroke-opacity: 0.75;
  }

  .document-search {
    display: flex;
    align-items: center;
    width: 314px;
    height: 40px;
    padding: 0 8px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: rgba(107, 107, 107, 0.05);
    transition: background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
  }

  .document-search:focus-within {
    border-color: rgba(0, 0, 0, 0.16);
    background: rgba(255, 255, 255, 0.75);
    box-shadow: none;
  }

  .document-search img {
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
  }

  .document-search input {
    width: 100%;
    min-width: 0;
    height: 38px;
    padding: 0 0 0 6px;
    border: 0;
    outline: 0;
    background: transparent;
    color: rgba(0, 0, 0, 0.75);
    font: inherit;
    appearance: none;
    -webkit-appearance: none;
  }

  .document-search input::placeholder {
    color: rgba(0, 0, 0, 0.47);
    opacity: 1;
  }

  .document-search input::-webkit-search-cancel-button {
    display: none;
  }

  .browser-actions {
    display: flex;
    align-items: center;
    gap: 13px;
    margin-left: auto;
  }

  .sort-button,
  .filter-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 40px;
    padding: 0 9px 0 12px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: rgba(107, 107, 107, 0.05);
    color: rgba(0, 0, 0, 0.7);
    cursor: pointer;
    transition: background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, transform 150ms ease;
  }

  .sort-button {
    width: 175px;
    padding-right: 3px;
    cursor: default;
  }

  .filter-button {
    width: 120px;
  }

  .sort-button strong,
  .filter-button strong {
    color: #000;
    font-weight: 400;
  }

  .sort-arrow {
    display: grid;
    place-items: center;
    width: 28px;
    height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .sort-arrow img {
    width: 16px;
    height: 17px;
    transform: rotate(90deg) translateY(2px);
    transition: filter 150ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .sort-arrow.expanded img {
    transform: rotate(270deg) translateY(-2px);
  }

  .filter-button img {
    width: 24px;
    height: 24px;
    transition: filter 150ms ease;
  }

  .sort-button:hover,
  .filter-button:hover {
    border-color: rgba(0, 0, 0, 0.13);
    background: rgba(107, 107, 107, 0.09);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.025);
  }

  .filter-button:hover img {
    filter: brightness(0.75);
  }

  .sort-arrow:active,
  .filter-button:active {
    transform: scale(0.98);
  }

  .recent-grid {
    display: grid;
    grid-row: 3;
    grid-template-columns: repeat(5, minmax(0, 264px));
    grid-auto-rows: auto;
    gap: 45px clamp(18px, 2.4vw, 46px);
    justify-content: space-between;
    align-content: start;
    padding: 37px 42px 42px;
    overflow: auto;
    scrollbar-width: none;
  }

  .recent-grid::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }

  .recent-document {
    display: grid;
    grid-template-rows: auto 50px;
    width: 100%;
    height: auto;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(0, 0, 0, 0.5);
    cursor: pointer;
    transition: color 180ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .document-preview {
    display: grid;
    place-items: center;
    width: 100%;
    height: auto;
    aspect-ratio: 264 / 355;
    overflow: hidden;
    border: 1px solid #dadada;
    border-radius: 7px;
    background: #fff;
    box-shadow: 3px 8px 16px rgba(0, 0, 0, 0.05);
    transition: border-color 180ms ease, box-shadow 180ms ease, background-color 180ms ease;
  }

  .document-name {
    display: grid;
    place-items: center;
    width: 100%;
    height: 50px;
    overflow: hidden;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.18px;
    text-align: center;
    white-space: nowrap;
    -webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 28px), transparent 100%);
    mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 28px), transparent 100%);
    -webkit-font-smoothing: antialiased;
  }

  .document-name > span {
    display: block;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
  }

  .open-document .document-preview {
    background: rgba(255, 255, 255, 0.36);
  }

  .open-document-plus {
    display: grid;
    place-items: center;
    width: 70px;
    height: 70px;
    transition: filter 180ms ease, transform 180ms ease;
    opacity: 0.5;
  }

  .open-document-plus :global(svg) {
    display: block;
    width: 70px;
    height: 70px;
    overflow: visible;
  }

  .open-document-plus :global(path) {
    stroke-width: 0.75px;
    transition: opacity 180ms ease, stroke 180ms ease;
  }

  .recent-document:hover {
    color: rgba(0, 0, 0, 0.7);
    transform: translateY(-2px);
  }

  .recent-document:hover .document-preview {
    border-color: #cfcfcf;
    box-shadow: 3px 10px 20px rgba(0, 0, 0, 0.075);
  }

  .open-document:hover .open-document-plus {
    filter: brightness(0.78);
    transform: scale(1.035);
  }

  .recent-document:active {
    transform: translateY(0) scale(0.99);
  }

  .file-input {
    display: none;
  }

  @media (max-width: 935px) {
    .editor-shell {
      grid-template-columns: 260px minmax(0, 1fr);
    }

    .topbar {
      grid-template-columns: 260px minmax(0, 1fr) auto;
    }

    .brand-area {
      padding-left: 14px;
      padding-right: 12px;
    }

    .logo {
      width: 154px;
      height: auto;
    }

    .logo-button {
      width: 154px;
    }

    .history {
      gap: 12px;
    }

    .document-tab {
      padding: 0 14px;
      font-size: 16px;
    }

    .quick-tools {
      padding-right: 14px;
      padding-left: 14px;
    }

    .quick-tool {
      width: 232px;
    }

    .quick-tool.wide-icon .quick-tool-icon {
      flex-basis: 106px;
    }
  }
</style>
