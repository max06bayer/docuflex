<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { scale } from 'svelte/transition';
  import PdfEditor from '$lib/PdfEditor.svelte';
  import CompressFilesPanel from '$lib/CompressFilesPanel.svelte';
  import ConvertFilesPanel from '$lib/ConvertFilesPanel.svelte';
  import FlattenFilesPanel from '$lib/FlattenFilesPanel.svelte';
  import HomeProtectPanel from '$lib/HomeProtectPanel.svelte';
  import QuickToolPagesPanel from '$lib/QuickToolPagesPanel.svelte';
  import SettingsPanel from '$lib/SettingsPanel.svelte';
  import TranslateFilesPanel from '$lib/TranslateFilesPanel.svelte';
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/geist/wght.css';
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/inter/wght.css';
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

  /** @typedef {{ name: string; file: File; protection: { enabled: boolean; password: string }; thumbnailUrl?: string; openedAt: number }} RecentDocument */

  const RECENT_DOCUMENT_DATABASE = 'docuflex-recent-documents';
  const RECENT_DOCUMENT_STORE = 'documents';
  const MAX_RECENT_DOCUMENTS = 20;
  /** @type {Promise<IDBDatabase> | null} */
  let recentDatabasePromise = null;

  const quickTools = [
    { name: 'Merge', shortcut: 'M', icon: mergeIcon, description: 'Combine multiple PDFs into one document.' },
    { name: 'Split', shortcut: 'L', icon: splitIcon, description: 'Separate PDF pages into individual files.' },
    { name: 'Convert', shortcut: 'C', icon: convertIcon, wide: true, description: 'Convert PDFs and Office files to another format.' },
    { name: 'Compress', shortcut: 'R', icon: compressIcon, description: 'Reduce a PDF’s file size.' },
    { name: 'Sign', shortcut: 'S', icon: signIcon, description: 'Open a PDF and add your signature.' },
    { name: 'Protect', shortcut: 'P', icon: protectIcon, description: 'Encrypt a PDF with a password.' },
    { name: 'Translate', shortcut: 'T', icon: translateIcon, description: 'Translate PDF text into another language.' },
    { name: 'Flatten', shortcut: 'F', icon: flattenIcon, description: 'Remove editable layers or rasterize the PDF.' },
    { name: 'OCR', shortcut: 'O', icon: ocrIcon, description: 'Recognize text in scanned PDF pages.' }
  ];

  /** @type {{ id: number; name: string; type: 'pdf'; file: File; protection: { enabled: boolean; password: string }; initialTool?: string }[]} */
  let tabs = [];
  /** @type {RecentDocument[]} */
  let recentDocuments = [];
  /** @type {number | null} */
  let activeTab = null;
  let nextTabId = 1;
  let closingTabs = new Set();
  let sortExpanded = false;
  let searchQuery = '';
  /** @type {'recent' | 'size' | 'name'} */
  let sortMode = 'recent';
  let sortModeText = 'Recent';
  /** @type {{ document: RecentDocument; x: number; y: number } | null} */
  let recentContextMenu = null;
  /** @type {RecentDocument[]} */
  let visibleRecentDocuments = [];
  let activeShortcut = '';
  /** @type {{ name: string; description: string; x: number; y: number } | null} */
  let quickTooltip = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let quickTooltipTimer;
  /** @type {{ label: string; description: string; x: number; y: number } | null} */
  let utilityTooltip = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let utilityTooltipTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let shortcutTimer;
  /** @type {{ id: number; name: string; type: 'pdf'; file: File; protection: { enabled: boolean; password: string }; initialTool?: string } | undefined} */
  let activeDocument;
  $: activeDocument = tabs.find((tab) => tab.id === activeTab);
  $: visibleRecentDocuments = recentDocuments
    .filter((document) => document.name.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))
    .sort((left, right) => {
      if (sortMode === 'size') return right.file.size - left.file.size || left.name.localeCompare(right.name);
      if (sortMode === 'name') return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      return right.openedAt - left.openedAt;
    });
  $: sortModeText = sortMode === 'size' ? 'Size' : sortMode === 'name' ? 'Name' : 'Recent';
  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {{ downloadPdf: () => Promise<void>; openSearchPanel: () => void; undo: () => Promise<void>; redo: () => Promise<void> } | undefined} */
  let pdfEditor;
  let isDownloading = false;
  /** @type {'merge' | 'split' | null} */
  let activePagesQuickTool = null;
  let convertPanelOpen = false;
  let compressPanelOpen = false;
  let protectHomePanelOpen = false;
  let translatePanelOpen = false;
  let flattenPanelOpen = false;
  let settingsPanelOpen = false;
  let pendingInitialTool = 'select';

  /** @param {{ name: string; description: string }} tool @param {HTMLElement} element */
  function scheduleQuickTooltip(tool, element) {
    clearTimeout(quickTooltipTimer);
    quickTooltip = null;
    quickTooltipTimer = setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const uiScale = rect.width / Math.max(1, element.offsetWidth);
      const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1;
      const tooltipWidth = 270 * scale;
      const rightX = rect.right + 8;
      const x = rightX + tooltipWidth <= window.innerWidth - 10
        ? rightX
        : Math.max(10, rect.left - tooltipWidth - 8);
      quickTooltip = {
        name: tool.name,
        description: tool.description,
        x: x / scale,
        y: Math.max(50, Math.min(window.innerHeight - 50, rect.top + rect.height / 2)) / scale
      };
    }, 680);
  }

  function hideQuickTooltip() {
    clearTimeout(quickTooltipTimer);
    quickTooltip = null;
  }

  /** @param {{ label: string; description: string }} utility @param {HTMLElement} element */
  function scheduleUtilityTooltip(utility, element) {
    clearTimeout(utilityTooltipTimer);
    utilityTooltip = null;
    utilityTooltipTimer = setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const uiScale = rect.width / Math.max(1, element.offsetWidth);
      const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1;
      const tooltipWidth = 220 * scale;
      const centeredX = rect.left + rect.width / 2 - tooltipWidth / 2;
      utilityTooltip = {
        label: utility.label,
        description: utility.description,
        x: Math.max(10, Math.min(window.innerWidth - tooltipWidth - 10, centeredX)) / scale,
        y: (rect.bottom + 8) / scale
      };
    }, 680);
  }

  function hideUtilityTooltip() {
    clearTimeout(utilityTooltipTimer);
    utilityTooltip = null;
  }

  /** @param {{ name: string }} tool */
  function openQuickTool(tool) {
    const toolName = tool.name.toLowerCase();
    if (toolName === 'merge' || toolName === 'split') {
      activePagesQuickTool = /** @type {'merge' | 'split'} */ (toolName);
      convertPanelOpen = false;
      compressPanelOpen = false;
      protectHomePanelOpen = false;
      translatePanelOpen = false;
      flattenPanelOpen = false;
    } else if (toolName === 'convert') {
      activePagesQuickTool = null;
      convertPanelOpen = true;
      compressPanelOpen = false;
      protectHomePanelOpen = false;
      translatePanelOpen = false;
      flattenPanelOpen = false;
    } else if (toolName === 'compress') {
      activePagesQuickTool = null;
      convertPanelOpen = false;
      compressPanelOpen = true;
      protectHomePanelOpen = false;
      translatePanelOpen = false;
      flattenPanelOpen = false;
    } else if (toolName === 'sign') {
      activePagesQuickTool = null;
      convertPanelOpen = false;
      compressPanelOpen = false;
      protectHomePanelOpen = false;
      translatePanelOpen = false;
      flattenPanelOpen = false;
      openFilePicker('sign');
    } else if (toolName === 'protect') {
      activePagesQuickTool = null;
      convertPanelOpen = false;
      compressPanelOpen = false;
      protectHomePanelOpen = true;
      translatePanelOpen = false;
      flattenPanelOpen = false;
    } else if (toolName === 'translate') {
      activePagesQuickTool = null;
      convertPanelOpen = false;
      compressPanelOpen = false;
      protectHomePanelOpen = false;
      translatePanelOpen = true;
      flattenPanelOpen = false;
    } else if (toolName === 'flatten') {
      activePagesQuickTool = null;
      convertPanelOpen = false;
      compressPanelOpen = false;
      protectHomePanelOpen = false;
      translatePanelOpen = false;
      flattenPanelOpen = true;
    } else if (toolName === 'ocr') {
      activePagesQuickTool = null;
      convertPanelOpen = false;
      compressPanelOpen = false;
      protectHomePanelOpen = false;
      translatePanelOpen = false;
      flattenPanelOpen = false;
      openFilePicker('ocr');
    }
  }

  function openRecentDatabase() {
    if (recentDatabasePromise) return recentDatabasePromise;
    recentDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(RECENT_DOCUMENT_DATABASE, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RECENT_DOCUMENT_STORE)) {
          database.createObjectStore(RECENT_DOCUMENT_STORE, { keyPath: 'name' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open recent document storage.'));
      request.onblocked = () => reject(new Error('Recent document storage is blocked by another app window.'));
    });
    return recentDatabasePromise;
  }

  /** @param {IDBTransaction} transaction */
  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not update recent document storage.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('The recent document storage update was cancelled.'));
    });
  }

  /** @param {RecentDocument} recent */
  async function persistRecentDocument(recent) {
    try {
      const database = await openRecentDatabase();
      const transaction = database.transaction(RECENT_DOCUMENT_STORE, 'readwrite');
      const store = transaction.objectStore(RECENT_DOCUMENT_STORE);
      store.put({
        name: recent.name,
        blob: recent.file,
        type: recent.file.type || 'application/pdf',
        lastModified: recent.file.lastModified,
        protection: recent.protection,
        thumbnailUrl: recent.thumbnailUrl,
        openedAt: recent.openedAt
      });
      const allDocuments = store.getAll();
      allDocuments.onsuccess = () => {
        const staleDocuments = allDocuments.result
          .sort((left, right) => Number(right.openedAt ?? 0) - Number(left.openedAt ?? 0))
          .slice(MAX_RECENT_DOCUMENTS);
        staleDocuments.forEach((stored) => store.delete(stored.name));
      };
      await transactionComplete(transaction);
    } catch (error) {
      console.warn(`Could not remember ${recent.name}:`, error);
    }
  }

  async function restoreRecentDocuments() {
    try {
      const database = await openRecentDatabase();
      const transaction = database.transaction(RECENT_DOCUMENT_STORE, 'readonly');
      const completion = transactionComplete(transaction);
      const request = transaction.objectStore(RECENT_DOCUMENT_STORE).getAll();
      const storedDocuments = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Could not read recent documents.'));
      });
      await completion;
      const restored = /** @type {any[]} */ (storedDocuments)
        .filter((stored) => stored.blob instanceof Blob && stored.name)
        .sort((left, right) => Number(right.openedAt ?? 0) - Number(left.openedAt ?? 0))
        .slice(0, MAX_RECENT_DOCUMENTS)
        .map((stored) => ({
          name: String(stored.name),
          file: new File([stored.blob], String(stored.name), {
            type: stored.type || stored.blob.type || 'application/pdf',
            lastModified: Number(stored.lastModified ?? Date.now())
          }),
          protection: stored.protection ?? { enabled: false, password: '' },
          thumbnailUrl: typeof stored.thumbnailUrl === 'string' ? stored.thumbnailUrl : undefined,
          openedAt: Number(stored.openedAt ?? 0)
        }));
      const currentNames = new Set(recentDocuments.map((recent) => recent.name));
      recentDocuments = [...recentDocuments, ...restored.filter((recent) => !currentNames.has(recent.name))]
        .sort((left, right) => right.openedAt - left.openedAt)
        .slice(0, MAX_RECENT_DOCUMENTS);
      recentDocuments.filter((recent) => !recent.thumbnailUrl).forEach((recent) => {
        void renderRecentThumbnail(recent.file, recent.protection.password);
      });
    } catch (error) {
      console.warn('Could not restore recent documents:', error);
    }
  }

  /** @param {MouseEvent | KeyboardEvent} event @param {number} id */
  function closeTab(event, id) {
    event.stopPropagation();
    requestCloseTab(id);
  }

  /** @param {number} id */
  function requestCloseTab(id) {
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

  /** @param {string} [initialTool] */
  function openFilePicker(initialTool = 'select') {
    pendingInitialTool = initialTool;
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
    addFileTab(file, { enabled: false, password: '' }, undefined, pendingInitialTool);
    pendingInitialTool = 'select';
    input.value = '';
  }

  /** @param {DragEvent} event */
  function handleFileDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) return;
    addFileTab(file);
  }

  /** @param {File} file @param {string} [password] */
  async function renderRecentThumbnail(file, password = '') {
    /** @type {import('pdfjs-dist').PDFDocumentLoadingTask | undefined} */
    let loadingTask;
    /** @type {import('pdfjs-dist').PDFDocumentProxy | undefined} */
    let document;
    try {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.mjs?url')
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      loadingTask = pdfjs.getDocument({
        data: await file.arrayBuffer(),
        ...(password ? { password } : {})
      });
      document = await loadingTask.promise;
      const page = await document.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = 528 / Math.max(1, baseViewport.width);
      const viewport = page.getViewport({ scale });
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Could not create the PDF thumbnail canvas.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const thumbnailUrl = canvas.toDataURL('image/webp', 0.86);
      /** @type {RecentDocument | undefined} */
      let updatedRecent;
      recentDocuments = recentDocuments.map((recent) => {
        if (recent.file !== file) return recent;
        updatedRecent = { ...recent, thumbnailUrl };
        return updatedRecent;
      });
      if (updatedRecent) void persistRecentDocument(updatedRecent);
    } catch (error) {
      console.warn(`Could not render a thumbnail for ${file.name}:`, error);
    } finally {
      await document?.destroy().catch(() => {});
      if (!document) await loadingTask?.destroy().catch(() => {});
    }
  }

  /** @param {File} file @param {{ enabled: boolean; password: string }} [protection] @param {string} [thumbnailUrl] @param {string} [initialTool] */
  function addFileTab(file, protection = { enabled: false, password: '' }, thumbnailUrl, initialTool = 'select') {
    const id = nextTabId++;
    tabs = [...tabs, { id, name: file.name, type: 'pdf', file, protection, initialTool }];
    const recent = { name: file.name, file, protection, thumbnailUrl, openedAt: Date.now() };
    recentDocuments = [recent, ...recentDocuments.filter((document) => document.name !== file.name)].slice(0, MAX_RECENT_DOCUMENTS);
    void persistRecentDocument(recent);
    if (!thumbnailUrl) void renderRecentThumbnail(file, protection.password);
    activeTab = id;
  }

  /** @param {RecentDocument} document */
  function openRecentDocument(document) {
    const existing = tabs.find((tab) => tab.name === document.name);
    if (existing) {
      activeTab = existing.id;
      return;
    }
    addFileTab(document.file, document.protection, document.thumbnailUrl);
  }

  /** @param {'recent' | 'size' | 'name'} mode */
  function selectSortMode(mode) {
    sortMode = mode;
    sortExpanded = false;
  }

  /** @param {MouseEvent} event @param {RecentDocument} document */
  function openRecentContextMenu(event, document) {
    event.preventDefault();
    event.stopPropagation();
    sortExpanded = false;
    const menuWidth = 204;
    const menuHeight = 92;
    recentContextMenu = {
      document,
      x: Math.max(10, Math.min(event.clientX, window.innerWidth - menuWidth - 10)),
      y: Math.max(10, Math.min(event.clientY, window.innerHeight - menuHeight - 10))
    };
  }

  /** @param {RecentDocument} document */
  async function downloadRecentDocument(document) {
    recentContextMenu = null;
    try {
      const bytes = await document.file.arrayBuffer();
      const url = URL.createObjectURL(new Blob([bytes], { type: document.file.type || 'application/pdf' }));
      const link = globalThis.document.createElement('a');
      link.href = url;
      link.download = document.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error(`Could not download ${document.name}:`, error);
    }
  }

  /** @param {RecentDocument} document */
  async function deleteRecentDocument(document) {
    recentContextMenu = null;
    recentDocuments = recentDocuments.filter((recent) => recent.name !== document.name);
    try {
      const database = await openRecentDatabase();
      const transaction = database.transaction(RECENT_DOCUMENT_STORE, 'readwrite');
      transaction.objectStore(RECENT_DOCUMENT_STORE).delete(document.name);
      await transactionComplete(transaction);
    } catch (error) {
      console.warn(`Could not delete ${document.name} from recent documents:`, error);
    }
  }

  /** @param {number} id @param {{ enabled: boolean; password: string }} protection */
  function updateDocumentProtection(id, protection) {
    const document = tabs.find((tab) => tab.id === id);
    if (!document) return;
    tabs = tabs.map((tab) => tab.id === id ? { ...tab, protection } : tab);
    recentDocuments = recentDocuments.map((recent) =>
      recent.name === document.name ? { ...recent, protection } : recent
    );
    const updatedRecent = recentDocuments.find((recent) => recent.name === document.name);
    if (updatedRecent) void persistRecentDocument(updatedRecent);
  }

  /** @param {KeyboardEvent} event */
  function handleQuickToolShortcut(event) {
    if (event.key === 'Escape') {
      sortExpanded = false;
      recentContextMenu = null;
      activePagesQuickTool = null;
      convertPanelOpen = false;
      compressPanelOpen = false;
      protectHomePanelOpen = false;
      return;
    }
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
    void restoreRecentDocuments();
    /** @param {PointerEvent} event */
    const closeHomepageMenus = (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.sort-button')) sortExpanded = false;
      if (!(target instanceof Element) || !target.closest('.recent-context-menu')) recentContextMenu = null;
    };
    window.addEventListener('pointerdown', closeHomepageMenus);
    window.addEventListener('keydown', handleQuickToolShortcut);
    window.addEventListener('scroll', hideQuickTooltip, true);
    window.addEventListener('resize', hideQuickTooltip);
    return () => {
      window.removeEventListener('pointerdown', closeHomepageMenus);
      window.removeEventListener('keydown', handleQuickToolShortcut);
      window.removeEventListener('scroll', hideQuickTooltip, true);
      window.removeEventListener('resize', hideQuickTooltip);
    };
  });

  onDestroy(() => {
    if (shortcutTimer) clearTimeout(shortcutTimer);
    if (quickTooltipTimer) clearTimeout(quickTooltipTimer);
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
        <button class="plain-button" aria-label="Undo" title="Undo" onclick={() => pdfEditor?.undo()}>
          <img src="/arrowleft.svg" alt="" />
        </button>
        <button class="plain-button" aria-label="Redo" title="Redo" onclick={() => pdfEditor?.redo()}>
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
          {#if tab.protection.enabled}
            <img class="tab-lock-icon" src="/lock.svg" alt="Encrypted" title="Encrypted" />
          {/if}
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

      <button class="add-tab" data-tab-motion="add" aria-label="Open another document" title="Open document" onclick={() => openFilePicker()}>
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
        { id: 'home', icon: '/home.svg', label: 'Home', description: 'Return to the document overview.' },
        { id: 'search', icon: '/search.svg', label: 'Search', description: 'Find text in the current PDF.' },
        { id: 'assistant', icon: '/brain.svg', label: 'AI Chat', description: 'Chat with AI about your document.' },
        { id: 'settings', icon: '/settings.svg', label: 'Settings', description: 'Open Docuflex settings.' }
      ].filter((utility) => utility.id !== 'search' || activeTab !== null) as utility (utility.id)}
        <button
          class="utility-button"
          class:ai-disabled={utility.id === 'assistant'}
          aria-label={utility.label}
          disabled={utility.id === 'assistant'}
          aria-describedby={utilityTooltip?.label === utility.label ? 'utility-tooltip' : undefined}
          onmouseenter={(event) => scheduleUtilityTooltip(utility, event.currentTarget)}
          onmouseleave={hideUtilityTooltip}
          onfocus={(event) => scheduleUtilityTooltip(utility, event.currentTarget)}
          onblur={hideUtilityTooltip}
          onclick={() => {
            hideUtilityTooltip();
            if (utility.id === 'home') activeTab = null;
            else if (utility.id === 'search') pdfEditor?.openSearchPanel();
            else if (utility.id === 'settings') settingsPanelOpen = !settingsPanelOpen;
          }}
        >
          <img src={utility.icon} alt="" />
        </button>
      {/each}
    </nav>
  </header>

  {#if utilityTooltip}
    <div
      id="utility-tooltip"
      class="utility-tooltip"
      role="tooltip"
      style:left={`${utilityTooltip.x}px`}
      style:top={`${utilityTooltip.y}px`}
    >
      <strong>{utilityTooltip.label}</strong>
      <span>{utilityTooltip.description}</span>
    </div>
  {/if}

  {#if activeTab === null || !activeDocument}
  <aside class="sidebar" aria-label="Document tools">
    <div class="quick-tools">
      {#each quickTools as tool}
        <button
          class="quick-tool"
          class:wide-icon={tool.wide}
          class:keyboard-active={activeShortcut === tool.shortcut}
          data-tool={tool.name.toLowerCase()}
          data-shortcut={tool.shortcut.toLowerCase()}
          aria-label={tool.name}
          aria-describedby={quickTooltip?.name === tool.name ? 'quick-tool-tooltip' : undefined}
          onmouseenter={(event) => scheduleQuickTooltip(tool, event.currentTarget)}
          onmouseleave={hideQuickTooltip}
          onfocus={(event) => scheduleQuickTooltip(tool, event.currentTarget)}
          onblur={hideQuickTooltip}
          onclick={() => { hideQuickTooltip(); openQuickTool(tool); }}
        >
          <span class="quick-tool-icon" aria-hidden="true">{@html tool.icon}</span>
          <span class="quick-tool-name">{tool.name}</span>
          <kbd>{tool.shortcut}</kbd>
        </button>
      {/each}
    </div>
  </aside>
  {#if quickTooltip}
    <div
      id="quick-tool-tooltip"
      class="quick-tool-tooltip"
      role="tooltip"
      style:left={`${quickTooltip.x}px`}
      style:top={`${quickTooltip.y}px`}
    >
      <strong>{quickTooltip.name} Tool</strong>
      <span>{quickTooltip.description}</span>
    </div>
  {/if}
  <section class="workspace" aria-label="Document workspace">
    <button class="drop-zone" aria-label="Open or drop a document" onclick={() => openFilePicker()} ondragover={(event) => event.preventDefault()} ondrop={handleFileDrop}>
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
        <input bind:value={searchQuery} type="search" placeholder="Search" aria-label="Search recent documents" />
      </label>

      <div class="browser-actions">
        <div class="sort-button">
          <span>Sort By: <strong>{sortModeText}</strong></span>
          <button class="sort-arrow" class:expanded={sortExpanded} aria-label="Toggle sort options" aria-expanded={sortExpanded} onclick={(event) => { event.stopPropagation(); sortExpanded = !sortExpanded; }}>
            <img src="/arrowright.svg" alt="" />
          </button>
          {#if sortExpanded}
            <div class="sort-menu" transition:scale={{ duration: 125, easing: cubicOut, start: 0.94, opacity: 0 }}>
              {#each [
                { id: 'recent', label: 'Recent' },
                { id: 'size', label: 'Size' },
                { id: 'name', label: 'Name' }
              ] as option (option.id)}
                <button
                  class:active={sortMode === option.id}
                  class="sort-menu-item"
                  aria-pressed={sortMode === option.id}
                  onclick={() => selectSortMode(/** @type {'recent' | 'size' | 'name'} */ (option.id))}
                >
                  <span aria-hidden="true"></span>
                  <span>{option.label}</span>
                  <span class="sort-check" aria-hidden="true">✓</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <button class="filter-button">
          <span>Filter: <strong>0</strong></span>
          <img src="/filter.svg" alt="" />
        </button>
      </div>
    </div>

    <div class="recent-grid">
      {#each visibleRecentDocuments as document (document.name)}
        <button
          class="recent-document"
          aria-label={`Open ${document.name}`}
          onclick={() => openRecentDocument(document)}
          oncontextmenu={(event) => openRecentContextMenu(event, document)}
        >
          <span class="document-preview" aria-hidden="true">
            {#if document.thumbnailUrl}
              <img class="recent-thumbnail" src={document.thumbnailUrl} alt="" />
            {/if}
          </span>
          <span class="document-name">
            {#if document.protection.enabled}<img class="recent-lock-icon" src="/lock.svg" alt="Encrypted" />{/if}
            <span>{document.name}</span>
          </span>
        </button>
      {/each}

      <button class="recent-document open-document" aria-label="Open document" onclick={() => openFilePicker()}>
        <span class="document-preview">
          <span class="open-document-plus" aria-hidden="true">{@html bigPlusIcon}</span>
        </span>
        <span class="document-name"><span>Open Document</span></span>
      </button>
    </div>

    {#if recentContextMenu}
      {@const contextDocument = recentContextMenu.document}
      <div
        class="recent-context-menu"
        role="menu"
        tabindex="-1"
        aria-label={`Actions for ${recentContextMenu.document.name}`}
        style:left={`${recentContextMenu.x}px`}
        style:top={`${recentContextMenu.y}px`}
        in:scale={{ duration: 190, easing: cubicOut, start: 0.92, opacity: 0 }}
        out:scale={{ duration: 145, easing: cubicOut, start: 0.96, opacity: 0 }}
      >
        <button class="recent-menu-item export-document" role="menuitem" onclick={() => downloadRecentDocument(contextDocument)}>
          <img src="/download.svg" alt="" />
          <span>Download</span>
          <kbd>E</kbd>
        </button>
        <button class="recent-menu-item delete-document" role="menuitem" onclick={() => deleteRecentDocument(contextDocument)}>
          <img src="/pages/trash.svg" alt="" />
          <span>Delete</span>
          <kbd>D</kbd>
        </button>
      </div>
    {/if}

    {#if activePagesQuickTool}
      {#key activePagesQuickTool}
        <QuickToolPagesPanel tool={activePagesQuickTool} onClose={() => (activePagesQuickTool = null)} />
      {/key}
    {/if}
    {#if convertPanelOpen}
      <ConvertFilesPanel onClose={() => (convertPanelOpen = false)} />
    {/if}
    {#if compressPanelOpen}
      <CompressFilesPanel onClose={() => (compressPanelOpen = false)} />
    {/if}
    {#if protectHomePanelOpen}
      <HomeProtectPanel onClose={() => (protectHomePanelOpen = false)} />
    {/if}
    {#if translatePanelOpen}
      <TranslateFilesPanel onClose={() => (translatePanelOpen = false)} />
    {/if}
    {#if flattenPanelOpen}
      <FlattenFilesPanel onClose={() => (flattenPanelOpen = false)} />
    {/if}
  </section>
  {:else}
    {#key activeDocument.id}
      <PdfEditor
        file={activeDocument.file}
        protection={activeDocument.protection}
        initialTool={activeDocument.initialTool ?? 'select'}
        onProtectionChange={(protection) => updateDocumentProtection(activeDocument.id, protection)}
        onRequestClose={() => requestCloseTab(activeDocument.id)}
        bind:this={pdfEditor}
      />
    {/key}
  {/if}

  {#if settingsPanelOpen}
    <SettingsPanel onClose={() => (settingsPanelOpen = false)} />
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

  .document-tab .tab-lock-icon {
    width: 22px;
    height: 22px;
    margin-left: -4px;
    margin-right: -7px;
    animation: protection-lock-in 190ms cubic-bezier(0.22, 1, 0.36, 1) both;
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

  .utility-button.ai-disabled:disabled {
    cursor: default;
  }

  .utility-button:disabled:hover {
    border-color: #dedede;
    background: #f8f8f8;
  }

  .utility-button:disabled:hover img {
    filter: none;
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

  .utility-tooltip {
    position: fixed;
    z-index: 1300;
    display: grid;
    gap: 3px;
    width: 220px;
    padding: 9px 11px 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 9px;
    background: #222222;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2), 0 2px 7px rgba(0, 0, 0, 0.12);
    color: #ffffff;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 17px;
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: -0.15px;
    transform-origin: top center;
    pointer-events: none;
    animation: utility-tooltip-in 150ms cubic-bezier(0.22, 1, 0.36, 1) both;
    -webkit-font-smoothing: antialiased;
  }

  .utility-tooltip strong {
    font: inherit;
    color: #ffffff;
  }

  .utility-tooltip span {
    color: #aaaaaa;
  }

  @keyframes utility-tooltip-in {
    from { opacity: 0; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
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

  .quick-tool-tooltip {
    position: fixed;
    z-index: 1200;
    display: grid;
    gap: 3px;
    box-sizing: border-box;
    width: 270px;
    padding: 10px 12px 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 9px;
    background: #222222;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2), 0 2px 7px rgba(0, 0, 0, 0.12);
    color: #ffffff;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 17px;
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: -0.15px;
    transform: translateY(-50%);
    transform-origin: left center;
    pointer-events: none;
    animation: quick-tool-tooltip-in 150ms cubic-bezier(0.22, 1, 0.36, 1) both;
    -webkit-font-smoothing: antialiased;
  }

  .quick-tool-tooltip strong {
    font: inherit;
    color: #ffffff;
  }

  .quick-tool-tooltip span {
    color: #aaaaaa;
  }

  @keyframes quick-tool-tooltip-in {
    from { opacity: 0; transform: translateY(-50%) scale(0.96); }
    to { opacity: 1; transform: translateY(-50%) scale(1); }
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
    position: relative;
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
    position: relative;
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

  .sort-menu {
    position: absolute;
    z-index: 70;
    top: calc(100% + 13px);
    right: 0;
    width: 204px;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.18);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.78);
    box-shadow: 0 7px 18px rgba(0, 0, 0, 0.11), 0 2px 5px rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    transform-origin: top right;
  }

  .sort-menu-item {
    display: grid;
    grid-template-columns: 28px 1fr 28px;
    align-items: center;
    width: 100%;
    height: 40px;
    padding: 0 7px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: #3f3f3f;
    font-size: 18px;
    text-align: left;
    cursor: pointer;
  }

  .sort-menu-item.active {
    border-color: rgba(0, 0, 0, 0.08);
    background: rgba(234, 234, 234, 0.574);
  }

  .sort-menu-item:hover {
    color: #000;
  }

  .sort-check {
    opacity: 0;
    color: #1684f8;
    text-align: center;
  }

  .sort-menu-item.active .sort-check {
    opacity: 1;
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

  .recent-thumbnail {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #fff;
    animation: recent-thumbnail-in 180ms ease both;
  }

  @keyframes recent-thumbnail-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .document-name {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
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

  .document-name .recent-lock-icon {
    width: 17px;
    height: 17px;
    flex: 0 0 auto;
    animation: protection-lock-in 190ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes protection-lock-in {
    from { opacity: 0; transform: scale(0.78); }
    to { opacity: 1; transform: scale(1); }
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

  .recent-context-menu {
    position: fixed;
    z-index: 70;
    box-sizing: border-box;
    width: 204px;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.18);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.78);
    box-shadow: 0 7px 18px rgba(0, 0, 0, 0.11), 0 2px 5px rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    transform-origin: top left;
  }

  .recent-menu-item {
    display: grid;
    grid-template-columns: 28px 1fr 28px;
    align-items: center;
    width: 100%;
    height: 40px;
    padding: 0 7px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: #3f3f3f;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 18px;
    text-align: left;
    cursor: pointer;
    transition:
      color 180ms cubic-bezier(0.2, 0.7, 0.2, 1),
      background-color 180ms cubic-bezier(0.2, 0.7, 0.2, 1),
      border-color 180ms cubic-bezier(0.2, 0.7, 0.2, 1),
      transform 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .recent-menu-item:hover,
  .recent-menu-item:focus-visible {
    border-color: rgba(0, 0, 0, 0.07);
    background: rgba(234, 234, 234, 0.62);
    color: #111;
    outline: none;
    transform: translateX(1px);
  }

  .recent-menu-item img {
    display: block;
    width: 20px;
    height: 20px;
    object-fit: contain;
    transform: translateX(-2px);
    transition: filter 180ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 180ms ease;
  }

  .recent-menu-item.export-document img {
    width: 24px;
    height: 24px;
  }

  .recent-menu-item:hover:not(.delete-document) img,
  .recent-menu-item:focus-visible:not(.delete-document) img {
    filter: brightness(0);
  }

  .recent-menu-item kbd {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid rgba(0, 0, 0, 0.04);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.045);
    color: rgba(0, 0, 0, 0.22);
    font-family: inherit;
    font-size: 17px;
    transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease;
  }

  .recent-menu-item:hover kbd,
  .recent-menu-item:focus-visible kbd {
    border-color: rgba(0, 0, 0, 0.06);
    background: rgba(0, 0, 0, 0.065);
    color: rgba(0, 0, 0, 0.34);
  }

  .recent-menu-item.delete-document {
    color: #ff2f38;
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
