<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { scale } from 'svelte/transition';
  import PdfEditor from '$lib/PdfEditor.svelte';
  import { trackEvent } from '$lib/analytics.js';
  import CompressFilesPanel from '$lib/CompressFilesPanel.svelte';
  import ConvertFilesPanel from '$lib/ConvertFilesPanel.svelte';
  import FlattenFilesPanel from '$lib/FlattenFilesPanel.svelte';
  import HomeProtectPanel from '$lib/HomeProtectPanel.svelte';
  import QuickToolPagesPanel from '$lib/QuickToolPagesPanel.svelte';
  import SettingsPanel from '$lib/SettingsPanel.svelte';
  import McpPanel from '$lib/McpPanel.svelte';
  import AiChatPanel from '$lib/AiChatPanel.svelte';
  import TranslateFilesPanel from '$lib/TranslateFilesPanel.svelte';
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/geist/wght.css';
  import '@fontsource-variable/geist-mono/wght.css';
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/inter/wght.css';
  import '$lib/theme-dark.css';
  import { visitorKey } from '$lib/ai-web.js';
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

  /** @type {{ id: number; name: string; type: 'pdf'; file: File; protection: { enabled: boolean; password: string }; initialTool?: string; sourcePath?: string | null }[]} */
  let tabs = [];
  /** @type {RecentDocument[]} */
  let recentDocuments = [];
  /** @type {number | null} */
  let activeTab = null;
  /** The public website (no desktop shell): one header row with the logo top-left; search and home move to the toolbar. */
  let isWebsite = false;
  /** On the website, the browser's Back button returns from a document to the home screen instead of leaving the page. */
  let documentHistoryEntry = false;
  $: if (isWebsite && typeof window !== 'undefined') {
    if (activeTab !== null && !documentHistoryEntry) {
      history.pushState({ docuflexDocument: true }, '');
      documentHistoryEntry = true;
    } else if (activeTab === null && documentHistoryEntry) {
      documentHistoryEntry = false;
      if (history.state?.docuflexDocument) history.back();
    }
  }
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
  /** @type {{ id: number; name: string; type: 'pdf'; file: File; protection: { enabled: boolean; password: string }; initialTool?: string; sourcePath?: string | null } | undefined} */
  let activeDocument;
  $: activeDocument = tabs.find((tab) => tab.id === activeTab);
  /** Set for a moment after a document opens, so the editor fades in and its pages settle instead of popping in. */
  let documentEntering = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let documentEnterTimer;
  /** @type {number | null} */
  let previousActiveTab = null;
  $: if (activeTab !== previousActiveTab) {
    if (activeTab !== null && previousActiveTab === null) playDocumentEnter();
    previousActiveTab = activeTab;
  }

  /** @type {HTMLElement | undefined} */
  let shellElement;

  async function playDocumentEnter() {
    clearTimeout(documentEnterTimer);
    // Drop the class and force a style pass so the animation restarts when it is already running.
    documentEntering = false;
    await tick();
    void shellElement?.offsetWidth;
    documentEntering = true;
    documentEnterTimer = setTimeout(() => (documentEntering = false), 1100);
  }
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
  /** @type {{ downloadPdf: () => Promise<void>; exportPdfForSave: () => Promise<{ blob: Blob; suggestedName: string }>; openSearchPanel: () => void; openRasterPanel: () => void; mcpCall: (name: string, args: Record<string, any>) => Promise<any>; aiContext: () => any; undo: () => Promise<void>; redo: () => Promise<void> } | undefined} */
  let pdfEditor;
  /** @type {Record<number, any>} */
  let editorRefs = {};
  $: pdfEditor = activeTab !== null ? editorRefs[activeTab] : undefined;
  let isDownloading = false;
  let isSaving = false;
  /** @type {{ id: number; title: string; message: string } | null} */
  let errorToast = null;
  /** Comment view, shared across open documents. */
  let commentMode = false;
  let mcpPanelOpen = false;
  /** Local MCP server state; null until known, available=false on the hosted web app. */
  /** @type {{ available: boolean; enabled: boolean; url: string; connectedApps: number; toolCount: number; lastCall: { name: string; at: number } | null } | null} */
  let mcpStatus = null;
  /** @type {EventSource | null} */
  let mcpStream = null;
  /** Id the local server gave this window's connection; used for heartbeats and acknowledgements. */
  /** @type {number | null} */
  let mcpClientId = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let mcpHeartbeat;
  let aiPanelOpen = false;
  /** Whether the AI chat can run here (desktop app or dev with a saved OpenRouter key); configurable: a key can be saved in Settings. */
  /** @type {{ available: boolean; configurable?: boolean; keyHint?: string | null; model?: string; fallbackModel?: string; tools?: { name: string; title: string; readOnly: boolean; needsApproval: boolean }[] } | null} */
  let aiStatus = null;
  /** The agent keeps working while its panel is closed; the brain button shows it. */
  let aiBusy = false;
  /** The AI chat is still in testing: its button stays greyed out until this is true. */
  const AI_CHAT_ENABLED = true;

  async function refreshAiStatus() {
    if (!AI_CHAT_ENABLED) {
      aiStatus = { available: false };
      return;
    }
    try {
      const response = await fetch('/api/ai/status', { cache: 'no-store' });
      const status = response.ok ? await response.json() : { available: false };
      // Website: the chat runs with the visitor's own key, kept in this browser.
      if (status.mode === 'web') {
        const key = visitorKey();
        aiStatus = { ...status, available: Boolean(key), keyHint: key ? key.slice(-4) : null };
      } else aiStatus = status;
    } catch {
      aiStatus = { available: false };
    }
  }

  /** What the AI chat knows about the window when it asks the model. */
  function aiContext() {
    return {
      documents: tabs.map((tab) => ({ documentId: tab.id, name: tab.name, active: tab.id === activeTab })),
      active: activeTab !== null && pdfEditor ? pdfEditor.aiContext() : null
    };
  }

  /** @param {Record<string, unknown>} message */
  function postToMcpBridge(message) {
    return fetch('/api/mcp/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, clientId: mcpClientId })
    }).catch(() => null);
  }

  async function refreshMcpStatus() {
    try {
      const response = await fetch('/api/mcp/status', { cache: 'no-store' });
      mcpStatus = response.ok ? await response.json() : { ...(mcpStatus ?? {}), available: false };
    } catch {
      // Keep the last known state while the local server restarts.
    }
  }

  /** @param {boolean} enabled */
  async function setMcpEnabled(enabled) {
    const response = await fetch('/api/mcp/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    }).catch(() => null);
    if (response?.ok) mcpStatus = await response.json();
  }

  /** Waits until the active tab's editor exists (after opening or switching). */
  /** @param {typeof pdfEditor} [previous] the editor that must be replaced first */
  async function waitForEditor(previous) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await tick();
      if (pdfEditor && pdfEditor !== previous) return pdfEditor;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The document did not open.');
  }

  /**
   * Runs an MCP tool call relayed from the local server. Document and view
   * management happens here; everything else is handled by the open editor.
   * @param {string} name @param {Record<string, any>} args
   */
  async function runMcpTool(name, args) {
    switch (name) {
      case 'list_documents':
        return { documents: tabs.map((tab) => ({ documentId: tab.id, name: tab.name, active: tab.id === activeTab })) };
      case 'open_document': {
        const binary = atob(String(args.base64 ?? ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const previous = pdfEditor;
        addFileTab(new File([bytes], String(args.name || 'document.pdf'), { type: 'application/pdf' }));
        const id = activeTab;
        const editor = await waitForEditor(previous);
        if (args.password) return { documentId: id, ...(await editor.mcpCall('unlock_document', { password: args.password })) };
        try {
          return { documentId: id, ...(await editor.mcpCall('get_document_info', {})) };
        } catch (error) {
          if (error instanceof Error && /password/i.test(error.message)) {
            return { documentId: id, passwordRequired: true, hint: 'This PDF needs a password to open. Call unlock_document with it.' };
          }
          throw error;
        }
      }
      case 'switch_document': {
        const tab = tabs.find((entry) => entry.id === Number(args.documentId));
        if (!tab) throw new Error(`No document with id ${args.documentId}. Use list_documents.`);
        const previous = tab.id === activeTab ? undefined : pdfEditor;
        activeTab = tab.id;
        const editor = await waitForEditor(previous);
        return { documentId: tab.id, ...(await editor.mcpCall('get_document_info', {})) };
      }
      case 'close_document': {
        const tab = tabs.find((entry) => entry.id === Number(args.documentId));
        if (!tab) throw new Error(`No document with id ${args.documentId}.`);
        requestCloseTab(tab.id);
        return { closed: tab.id };
      }
      case 'set_view': {
        if (typeof args.commentMode === 'boolean') commentMode = args.commentMode;
        const result = activeTab !== null && pdfEditor ? await pdfEditor.mcpCall('set_view', args) : {};
        return { ...result, commentMode };
      }
      default: {
        if (activeTab === null || !pdfEditor) throw new Error('No document is open. Use open_document first.');
        return pdfEditor.mcpCall(name, args);
      }
    }
  }

  /**
   * Browsers stop animation frames while a window is hidden. pdf.js draws
   * pages and Svelte runs transitions on them, so an agent working while
   * Docuflex sits behind its terminal would stall. While hidden, frame
   * requests run as ordinary tasks instead; when visible nothing changes.
   */
  function keepRenderingWhileHidden() {
    const scope = /** @type {any} */ (window);
    if (scope.__docuflexHiddenFrames) return;
    scope.__docuflexHiddenFrames = true;
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const channel = new MessageChannel();
    /** @type {Map<number, { native?: number; callback?: FrameRequestCallback }>} */
    const frames = new Map();
    let nextFrame = 1;
    channel.port1.onmessage = (event) => {
      const frame = frames.get(event.data);
      if (!frame?.callback) return;
      frames.delete(event.data);
      frame.callback(performance.now());
    };
    window.requestAnimationFrame = (callback) => {
      const id = nextFrame++;
      if (document.hidden) {
        frames.set(id, { callback });
        channel.port2.postMessage(id);
      } else {
        frames.set(id, { callback, native: nativeRequest((time) => { frames.delete(id); callback(time); }) });
      }
      return id;
    };
    // Frames requested just before the window hid would otherwise wait for it to return.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      for (const [id, frame] of frames) {
        if (frame.native === undefined) continue;
        nativeCancel(frame.native);
        frame.native = undefined;
        channel.port2.postMessage(id);
      }
    });
    window.cancelAnimationFrame = (id) => {
      const frame = frames.get(id);
      frames.delete(id);
      if (frame?.native !== undefined) nativeCancel(frame.native);
    };
  }

  function connectMcpBridge() {
    if (mcpStream || typeof EventSource === 'undefined') return;
    keepRenderingWhileHidden();
    mcpStream = new EventSource('/api/mcp/bridge');
    mcpStream.onmessage = async (event) => {
      /** @type {{ type: string; id?: string; name?: string; args?: Record<string, any> }} */
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        mcpClientId = Number(/** @type {any} */ (message).clientId);
        clearInterval(mcpHeartbeat);
        mcpHeartbeat = setInterval(() => void postToMcpBridge({ type: 'alive' }), 10_000);
        return;
      }
      if (message.type !== 'call' || !message.id || !message.name) return;
      // Tell the server right away that this window took the call.
      void postToMcpBridge({ type: 'ack', id: message.id });
      /** @type {{ id: string; ok: boolean; result?: unknown; error?: string }} */
      let reply;
      try {
        reply = { id: message.id, ok: true, result: await runMcpTool(message.name, message.args ?? {}) };
      } catch (error) {
        reply = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      await postToMcpBridge({ type: 'result', ...reply });
      if (mcpPanelOpen) void refreshMcpStatus();
    };
  }
  /** @type {ReturnType<typeof setTimeout>} */
  let errorToastTimer;

  /** @param {string} title @param {string} message */
  function showErrorToast(title, message) {
    clearTimeout(errorToastTimer);
    errorToast = { id: Date.now(), title, message };
    errorToastTimer = setTimeout(() => (errorToast = null), 7000);
  }

  /** @type {'merge' | 'split' | null} */
  let activePagesQuickTool = null;
  let convertPanelOpen = false;
  let compressPanelOpen = false;
  let protectHomePanelOpen = false;
  let translatePanelOpen = false;
  let flattenPanelOpen = false;
  let settingsPanelOpen = false;
  /** Opened from the AI button without a key: Settings focuses the key field. */
  let settingsKeyFocus = false;
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
    trackEvent('tool_open', { tool: toolName.replace(/[^a-z0-9-]/g, '').slice(0, 40) });
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
    editorStates.delete(id);
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
    trackEvent('export');
    try {
      await pdfEditor.downloadPdf();
    } catch (error) {
      // PdfEditor already opened its own "PDF Edit Locked" panel to handle this.
      if (error instanceof Error && error.message === 'EDIT_LOCKED') return;
      console.error(error);
      showErrorToast('Could not download this PDF', error instanceof Error ? error.message : 'Could not export this PDF.');
    } finally {
      isDownloading = false;
    }
  }

  /**
   * Saves the active document back to the file it was opened from: overwrites in
   * place if we know the original disk path (desktop file-association opens), or
   * prompts once via a native save dialog and remembers the chosen path for next
   * time otherwise. Falls back to a normal download when there's no native bridge
   * (web build), since a browser can't write to an arbitrary path.
   */
  async function saveActiveDocument() {
    if (!pdfEditor || isSaving) return;
    const tab = tabs.find((entry) => entry.id === activeTab);
    if (!tab) return;
    const bridge = /** @type {any} */ (window).__docuflexNative;
    if (!bridge) {
      await downloadActiveDocument();
      return;
    }
    isSaving = true;
    try {
      const { blob, suggestedName } = await pdfEditor.exportPdfForSave();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (tab.sourcePath) {
        await bridge.overwrite(tab.sourcePath, bytes);
      } else {
        const savedPath = await bridge.promptAndSave(suggestedName, bytes);
        if (savedPath) tabs = tabs.map((entry) => (entry.id === tab.id ? { ...entry, sourcePath: savedPath } : entry));
      }
    } catch (error) {
      // PdfEditor already opened its own "PDF Edit Locked" panel to handle this.
      if (error instanceof Error && error.message === 'EDIT_LOCKED') return;
      if (error !== 'cancelled') {
        console.error(error);
        // The native save bridge (desktop/src-tauri) rejects with a plain string, not an Error.
        const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not save this PDF.';
        showErrorToast('Could not save this PDF', message);
      }
    } finally {
      isSaving = false;
    }
  }

  /** @param {Event} event */
  function handleFileSelection(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0];
    if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) return;
    trackEvent('file_open');
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
      // pdfjs-dist dropped PDFDocumentProxy.destroy(); only the loading task has one.
      await loadingTask?.destroy?.()?.catch(() => {});
    }
  }

  /** @type {Map<number, any>} */
  const editorStates = new Map();

  /**
   * Keeps a tab's unsaved edits, comments and undo history while another tab
   * is shown; the editor restores them when the tab comes back.
   * @param {number | null} id @param {any} state
   */
  function saveEditorState(id, state) {
    // A plain map, not the reactive tab list: this runs while the old editor
    // is torn down, and rewriting `tabs` then dropped a tab that was just added.
    if (id !== null && tabs.some((tab) => tab.id === id)) editorStates.set(id, state);
  }

  /** @param {File} file @param {{ enabled: boolean; password: string }} [protection] @param {string} [thumbnailUrl] @param {string} [initialTool] */
  function addFileTab(file, protection = { enabled: false, password: '' }, thumbnailUrl, initialTool = 'select') {
    const id = nextTabId++;
    // Desktop file-association opens (double-click / "Open With Docuflex") stash the
    // originating disk path on the File object; see desktop/runtime/chrome.js.
    const sourcePath = /** @type {any} */ (file).__docuflexSourcePath ?? null;
    tabs = [...tabs, { id, name: file.name, type: 'pdf', file, protection, initialTool, sourcePath }];
    const recent = { name: file.name, file, protection, thumbnailUrl, openedAt: Date.now() };
    recentDocuments = [recent, ...recentDocuments.filter((document) => document.name !== file.name)].slice(0, MAX_RECENT_DOCUMENTS);
    void persistRecentDocument(recent);
    if (!thumbnailUrl) void renderRecentThumbnail(file, protection.password);
    if (activeTab !== null) playDocumentEnter();
    activeTab = id;
  }

  /** Open tabs survive a reload: their names (and the active one) are kept, the files come from the recent-documents store. */
  const OPEN_TABS_KEY = 'docuflex-open-tabs';
  let openTabsRestored = false;
  $: if (openTabsRestored && typeof window !== 'undefined') {
    try {
      const active = tabs.find((tab) => tab.id === activeTab)?.name ?? null;
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ names: tabs.map((tab) => tab.name), active }));
    } catch {}
  }

  function restoreOpenTabs() {
    try {
      const saved = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? 'null');
      if (saved && Array.isArray(saved.names) && !tabs.length) {
        const before = activeTab;
        for (const name of saved.names) {
          const recent = recentDocuments.find((document) => document.name === name);
          if (recent && !tabs.some((tab) => tab.name === name)) addFileTab(recent.file, recent.protection, recent.thumbnailUrl);
        }
        const active = tabs.find((tab) => tab.name === saved.active);
        activeTab = saved.active === null ? before : active?.id ?? activeTab;
      }
    } catch {}
    openTabsRestored = true;
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
      flattenPanelOpen = false;
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
    isWebsite = !document.documentElement.dataset.docuflexDesktop;
    const handleHistoryBack = () => {
      if (!isWebsite || !documentHistoryEntry) return;
      documentHistoryEntry = false;
      activeTab = null;
    };
    window.addEventListener('popstate', handleHistoryBack);
    void restoreRecentDocuments().finally(restoreOpenTabs);
    /** @param {PointerEvent} event */
    const closeHomepageMenus = (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.sort-button')) sortExpanded = false;
      if (!(target instanceof Element) || !target.closest('.recent-context-menu')) recentContextMenu = null;
    };
    /** @param {CustomEvent<{ title: string; message: string }>} event */
    const handleNativeError = (event) => showErrorToast(event.detail.title, event.detail.message);
    window.addEventListener('pointerdown', closeHomepageMenus);
    window.addEventListener('keydown', handleQuickToolShortcut);
    window.addEventListener('scroll', hideQuickTooltip, true);
    window.addEventListener('resize', hideQuickTooltip);
    window.addEventListener('docuflex:error', /** @type {EventListener} */ (handleNativeError));
    void refreshMcpStatus().then(() => {
      if (mcpStatus?.available) connectMcpBridge();
    });
    void refreshAiStatus();
    return () => {
      mcpStream?.close();
      mcpStream = null;
      clearInterval(mcpHeartbeat);
      window.removeEventListener('popstate', handleHistoryBack);
      window.removeEventListener('pointerdown', closeHomepageMenus);
      window.removeEventListener('keydown', handleQuickToolShortcut);
      window.removeEventListener('docuflex:error', /** @type {EventListener} */ (handleNativeError));
      window.removeEventListener('scroll', hideQuickTooltip, true);
      window.removeEventListener('resize', hideQuickTooltip);
    };
  });

  onDestroy(() => {
    clearTimeout(documentEnterTimer);
    if (shortcutTimer) clearTimeout(shortcutTimer);
    if (quickTooltipTimer) clearTimeout(quickTooltipTimer);
  });
</script>

<svelte:head>
  <title>Docuflex Editor — Edit PDFs Online, Free</title>
  <meta name="description" content="Edit, sign, merge, split, compress and convert PDFs online for free with Docuflex. Private, open source and hosted in the EU." />
  <link rel="canonical" href="https://docuflex.eu/editor" />
  <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
  <link rel="icon" href="/favicon-64.png" sizes="64x64" type="image/png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
</svelte:head>

<main bind:this={shellElement} class="editor-shell" class:website={isWebsite} class:editor-mode={activeTab !== null} class:document-entering={documentEntering} class:ai-docked={aiPanelOpen && aiStatus?.available}>
  <header class="topbar">
    <div class="window-head">
      <span class="window-head-texture" aria-hidden="true"></span>
      {#if isWebsite}
        <button class="web-logo" aria-label="Go to Home" title="Home" onclick={() => (activeTab = null)}>
          <img src="/redesign/docuflex-logo1.svg" alt="Docuflex" />
        </button>
      {:else}
        <img class="sidebar-toggle" src="/redesign/sidebar-toggle.svg" alt="" />
      {/if}
      <nav class="history" aria-label="History navigation">
        <button class="history-button back" aria-label="Undo" title="Undo" onclick={() => pdfEditor?.undo()}>
          <img src="/redesign/vector543.svg" alt="" />
        </button>
        <button class="history-button forward" aria-label="Redo" title="Redo" onclick={() => pdfEditor?.redo()}>
          <img src="/redesign/vector542.svg" alt="" />
        </button>
      </nav>
    </div>
    <span class="topbar-backdrop" aria-hidden="true"><img src="/redesign/rectangle997.png" alt="" /></span>

    <div class="tab-strip" role="tablist" aria-label="Open documents">
      {#each tabs as tab (tab.id)}
        {@const tabLabel = tab.name.replace(/\.pdf$/i, '')}
        <button
          class:active={tab.id === activeTab}
          class:closing={closingTabs.has(tab.id)}
          class="document-tab"
          data-tab-motion={`tab-${tab.id}`}
          role="tab"
          aria-selected={tab.id === activeTab}
          onclick={() => (activeTab = tab.id)}
        >
          <img class="tab-file-icon" src={tab.id === activeTab ? '/redesign/subtract2.svg' : '/redesign/pdf-tab-inactive.svg'} alt="" />
          {#if tab.protection.enabled}
            <img class="tab-lock-icon" src="/lock.svg" alt="Encrypted" title="Encrypted" />
          {/if}
          <span class="tab-title" class:long-title={tabLabel.length > 22}>{tabLabel}</span>
          <span
            class="close-tab"
            role="button"
            tabindex="0"
            aria-label={`Close ${tab.name}`}
            onclick={(event) => closeTab(event, tab.id)}
            onkeydown={(event) => (event.key === 'Enter' || event.key === ' ') && closeTab(event, tab.id)}
          >
            <img class="close-tab-cross" src="/redesign/tab-close.svg" alt="" />
          </span>
        </button>
      {/each}

      <button class="add-tab" data-tab-motion="add" aria-label="Open another document" title="Open document" onclick={() => openFilePicker()}>
        <img class="add-tab-cross" src="/redesign/add-tab-plus.svg" alt="" />
      </button>
    </div>

    <nav class="utilities" aria-label="Editor utilities">
      {#if mcpStatus?.available}
        {@const mcpUtility = { label: 'MCP Server', description: mcpStatus.enabled ? 'AI agents can control Docuflex. Click for the address.' : 'The MCP server is off.' }}
        <button
          class="utility-button mcp-button"
          class:active={mcpPanelOpen}
          class:mcp-live={mcpStatus.enabled && mcpStatus.connectedApps > 0}
          aria-label={mcpUtility.label}
          aria-pressed={mcpPanelOpen}
          aria-describedby={utilityTooltip?.label === mcpUtility.label ? 'utility-tooltip' : undefined}
          onmouseenter={(event) => scheduleUtilityTooltip(mcpUtility, event.currentTarget)}
          onmouseleave={hideUtilityTooltip}
          onfocus={(event) => scheduleUtilityTooltip(mcpUtility, event.currentTarget)}
          onblur={hideUtilityTooltip}
          onclick={() => { hideUtilityTooltip(); mcpPanelOpen = !mcpPanelOpen; if (mcpPanelOpen) { settingsPanelOpen = false; aiPanelOpen = false; void refreshMcpStatus(); } }}
        >
          <img class="utility-icon-mcp" src="/redesign/icon-code-xml.svg" alt="" />
        </button>
      {/if}
      {#if activeTab !== null && isWebsite}
        {@const webSearchUtility = { label: 'Search', description: 'Find text in the current PDF.' }}
        {@const webHomeUtility = { label: 'Home', description: 'Return to the document overview.' }}
        <button
          class="utility-button"
          aria-label={webSearchUtility.label}
          aria-describedby={utilityTooltip?.label === webSearchUtility.label ? 'utility-tooltip' : undefined}
          onmouseenter={(event) => scheduleUtilityTooltip(webSearchUtility, event.currentTarget)}
          onmouseleave={hideUtilityTooltip}
          onfocus={(event) => scheduleUtilityTooltip(webSearchUtility, event.currentTarget)}
          onblur={hideUtilityTooltip}
          onclick={() => { hideUtilityTooltip(); pdfEditor?.openSearchPanel(); }}
        >
          <img class="utility-icon-search" src="/redesign/icon-search.svg" alt="" />
        </button>
        <button
          class="utility-button"
          aria-label={webHomeUtility.label}
          aria-describedby={utilityTooltip?.label === webHomeUtility.label ? 'utility-tooltip' : undefined}
          onmouseenter={(event) => scheduleUtilityTooltip(webHomeUtility, event.currentTarget)}
          onmouseleave={hideUtilityTooltip}
          onfocus={(event) => scheduleUtilityTooltip(webHomeUtility, event.currentTarget)}
          onblur={hideUtilityTooltip}
          onclick={() => { hideUtilityTooltip(); activeTab = null; }}
        >
          <img class="utility-icon-home" src="/redesign/vector537.svg" alt="" />
        </button>
      {/if}
      {#if activeTab !== null}
        {@const commentUtility = { label: 'Comments', description: commentMode ? 'Hide comments.' : 'Show comments. Click or select text to comment.' }}
        <button
          class="utility-button"
          class:active={commentMode}
          aria-label={commentUtility.label}
          aria-pressed={commentMode}
          aria-describedby={utilityTooltip?.label === commentUtility.label ? 'utility-tooltip' : undefined}
          onmouseenter={(event) => scheduleUtilityTooltip(commentUtility, event.currentTarget)}
          onmouseleave={hideUtilityTooltip}
          onfocus={(event) => scheduleUtilityTooltip(commentUtility, event.currentTarget)}
          onblur={hideUtilityTooltip}
          onclick={() => { hideUtilityTooltip(); commentMode = !commentMode; }}
        >
          <img class="utility-icon-comments" src="/redesign/icon-message-square-quote.svg" alt="" />
        </button>
        {@const rasterUtility = { label: 'Adjust & Rasterize', description: 'Rotate, color-correct and rasterize pages.' }}
        <button
          class="utility-button"
          data-keeps-page-selection
          aria-label={rasterUtility.label}
          aria-describedby={utilityTooltip?.label === rasterUtility.label ? 'utility-tooltip' : undefined}
          onmouseenter={(event) => scheduleUtilityTooltip(rasterUtility, event.currentTarget)}
          onmouseleave={hideUtilityTooltip}
          onfocus={(event) => scheduleUtilityTooltip(rasterUtility, event.currentTarget)}
          onblur={hideUtilityTooltip}
          onclick={() => { hideUtilityTooltip(); pdfEditor?.openRasterPanel(); }}
        >
          <img class="utility-icon-palette" src="/redesign/icon-palette.svg" alt="" />
        </button>
        <button
          class="utility-button"
          aria-label={isSaving ? 'Saving PDF' : 'Save'}
          title={isSaving ? 'Saving…' : 'Save'}
          disabled={isSaving}
          onclick={saveActiveDocument}
        >
          <img src="/save.svg" alt="" />
        </button>
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
        { id: 'home', icon: '/redesign/vector537.svg', label: 'Home', description: 'Return to the document overview.' },
        { id: 'search', icon: '/search.svg', label: 'Search', description: 'Find text in the current PDF.' },
        { id: 'assistant', icon: '/redesign/icon-brain.svg', label: 'AI Chat', description: aiStatus?.available ? (aiBusy ? 'Docuflex AI is working…' : 'Ask AI about your document or let it edit for you.') : aiStatus?.configurable ? 'Add your OpenRouter API key in Settings to chat with AI.' : 'Chat with AI about your document.' },
        { id: 'settings', icon: '/redesign/icon-settings2.svg', label: 'Settings', description: 'Open Docuflex settings.' }
      ].filter((utility) => activeTab === null ? utility.id !== 'search' : utility.id !== 'home' && utility.id !== 'search') as utility (utility.id)}
        {@const aiUtility = utility.id === 'assistant'}
        <button
          class="utility-button"
          class:ai-disabled={aiUtility && !aiStatus?.configurable}
          class:ai-button={aiUtility}
          class:ai-busy={aiUtility && aiBusy}
          class:active={aiUtility && aiPanelOpen && aiStatus?.available}
          data-utility={utility.id}
          aria-label={utility.label}
          aria-pressed={aiUtility ? aiPanelOpen : undefined}
          disabled={aiUtility && !aiStatus?.configurable}
          aria-describedby={utilityTooltip?.label === utility.label ? 'utility-tooltip' : undefined}
          onmouseenter={(event) => scheduleUtilityTooltip(utility, event.currentTarget)}
          onmouseleave={hideUtilityTooltip}
          onfocus={(event) => scheduleUtilityTooltip(utility, event.currentTarget)}
          onblur={hideUtilityTooltip}
          onclick={() => {
            hideUtilityTooltip();
            if (utility.id === 'home') activeTab = null;
            else if (utility.id === 'search') pdfEditor?.openSearchPanel();
            else if (utility.id === 'settings') { settingsKeyFocus = false; settingsPanelOpen = !settingsPanelOpen; mcpPanelOpen = false; if (settingsPanelOpen) aiPanelOpen = false; }
            else if (utility.id === 'assistant' && !aiStatus?.available) { settingsKeyFocus = true; settingsPanelOpen = true; mcpPanelOpen = false; aiPanelOpen = false; }
            else if (utility.id === 'assistant') { aiPanelOpen = !aiPanelOpen; if (aiPanelOpen) { settingsPanelOpen = false; mcpPanelOpen = false; } }
          }}
        >
          <img src={utility.icon} alt="" />
        </button>
      {/each}
    </nav>
  </header>

  {#if !isWebsite}
  <div class="sidebar-head">
    <button class="sidebar-logo" aria-label="Go to Home" title="Home" onclick={() => (activeTab = null)}>
      <img src="/redesign/docuflex-logo1.svg" alt="Docuflex" />
    </button>
    {#if activeTab !== null}
      {@const searchUtility = { label: 'Search', description: 'Find text in the current PDF.' }}
      {@const homeUtility = { label: 'Home', description: 'Return to the document overview.' }}
      <button
        class="sidebar-head-button"
        aria-label={searchUtility.label}
        aria-describedby={utilityTooltip?.label === searchUtility.label ? 'utility-tooltip' : undefined}
        onmouseenter={(event) => scheduleUtilityTooltip(searchUtility, event.currentTarget)}
        onmouseleave={hideUtilityTooltip}
        onfocus={(event) => scheduleUtilityTooltip(searchUtility, event.currentTarget)}
        onblur={hideUtilityTooltip}
        onclick={() => { hideUtilityTooltip(); pdfEditor?.openSearchPanel(); }}
      >
        <img class="sidebar-search-icon" src="/redesign/icon-search.svg" alt="" />
      </button>
      <button
        class="sidebar-head-button"
        aria-label={homeUtility.label}
        aria-describedby={utilityTooltip?.label === homeUtility.label ? 'utility-tooltip' : undefined}
        onmouseenter={(event) => scheduleUtilityTooltip(homeUtility, event.currentTarget)}
        onmouseleave={hideUtilityTooltip}
        onfocus={(event) => scheduleUtilityTooltip(homeUtility, event.currentTarget)}
        onblur={hideUtilityTooltip}
        onclick={() => { hideUtilityTooltip(); activeTab = null; }}
      >
        <img class="sidebar-home-icon" src="/redesign/vector537.svg" alt="" />
      </button>
    {/if}
  </div>
  {/if}

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
        <img src="/redesign/add-tab-plus.svg" alt="" />
        <span>Drop any Document to edit</span>
      </span>
    </button>

    <div class="document-browser">
      <button class="recent-heading">
        <span>Recent Documents</span>
        <span class="recent-arrow" aria-hidden="true">{@html expandIcon}</span>
      </button>

      <label class="document-search">
        <img src="/redesign/icon-search.svg" alt="" />
        <input bind:value={searchQuery} type="search" placeholder="Search" aria-label="Search recent documents" />
      </label>

      <div class="browser-actions">
        <div class="sort-button">
          <span>Sort By: <strong>{sortModeText}</strong></span>
          <button class="sort-arrow" class:expanded={sortExpanded} aria-label="Toggle sort options" aria-expanded={sortExpanded} onclick={(event) => { event.stopPropagation(); sortExpanded = !sortExpanded; }}>
            <span class="chevron" aria-hidden="true"></span>
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
          <img src="/redesign/icon-trash1.svg" alt="" />
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
      <TranslateFilesPanel onClose={() => (translatePanelOpen = false)} onOpen={(file) => addFileTab(file)} />
    {/if}
    {#if flattenPanelOpen}
      <FlattenFilesPanel onClose={() => (flattenPanelOpen = false)} />
    {/if}
  </section>
  {/if}

  <!-- One editor per open tab stays mounted, so switching tabs never reloads a PDF. -->
  {#each tabs as tab (tab.id)}
    <PdfEditor
      file={tab.file}
      protection={tab.protection}
      initialTool={tab.initialTool ?? 'select'}
      active={tab.id === activeTab}
      {commentMode}
      documentId={tab.id}
      savedState={editorStates.get(tab.id) ?? null}
      onSaveState={saveEditorState}
      onProtectionChange={(protection) => updateDocumentProtection(tab.id, protection)}
      onRequestClose={() => requestCloseTab(tab.id)}
      bind:this={editorRefs[tab.id]}
    />
  {/each}

  {#if aiStatus?.available}
    <AiChatPanel
      open={aiPanelOpen}
      status={aiStatus}
      getContext={aiContext}
      hasDocument={activeTab !== null}
      onClose={() => (aiPanelOpen = false)}
      onBusyChange={(busy) => (aiBusy = busy)}
      runLocalTool={runMcpTool}
    />
  {/if}

  {#if mcpPanelOpen && mcpStatus?.available}
    <McpPanel status={mcpStatus} onClose={() => (mcpPanelOpen = false)} onToggle={setMcpEnabled} onRefresh={refreshMcpStatus} />
  {/if}

  {#if settingsPanelOpen}
    <SettingsPanel aiStatus={aiStatus} focusKey={settingsKeyFocus} onAiKeyChange={refreshAiStatus} onClose={() => (settingsPanelOpen = false)} />
  {/if}

  {#if errorToast}
    {#key errorToast.id}
      <div class="error-toast" role="alert" transition:scale={{ duration: 150, easing: cubicOut, start: 0.96, opacity: 0 }}>
        <div class="error-toast-body">
          <strong>{errorToast.title}</strong>
          <span>{errorToast.message}</span>
        </div>
      </div>
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

  /*
   * The AI chat docks on the right, the full height of the window: the shell
   * reserves its width as right padding (top bar and document shrink), and the
   * panel sits in that padding. Padding rather than a third grid column, which
   * WebKit did not collapse to zero while the chat was closed.
   */
  .editor-shell {
    --ui-scale: 0.85;
    --ai-dock: 0px;
    position: relative;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr);
    padding-right: var(--ai-dock);
    grid-template-rows: 56px minmax(0, 1fr);
    width: calc(100vw / var(--ui-scale));
    height: calc(100dvh / var(--ui-scale));
    min-width: 760px;
    overflow: clip;
    background: #f5f5f5;
    zoom: var(--ui-scale);
    transition: padding-right 280ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .editor-shell.ai-docked {
    --ai-dock: 440px;
  }

  .topbar {
    grid-column: 1 / -1;
    min-width: 0;
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr) auto;
    height: 56px;
    background: #fff;
    border-bottom: 1px solid #cecece;
    overflow: hidden;
  }

  .history {
    display: flex;
    align-items: center;
    gap: 22px;
    margin-left: 12px;
  }

  .add-tab {
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    transition: opacity 150ms ease;
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

  .mcp-button {
    position: relative;
  }

  .ai-button {
    position: relative;
  }

  /* Pulsing dot while the agent works with its panel closed. */
  .ai-button.ai-busy::after {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 7px;
    height: 7px;
    border: 1.5px solid #f8f8f8;
    border-radius: 50%;
    background: #0878f9;
    content: '';
    animation: ai-busy-pulse 1.2s ease-in-out infinite;
  }

  .ai-button.active.ai-busy::after {
    border-color: #171717;
  }

  @keyframes ai-busy-pulse {
    50% { opacity: 0.35; }
  }

  /* While the MCP server is on and this window is serving it, the button's fill slowly breathes 5% darker. */
  .mcp-button.mcp-live:not(.active):not(:hover) {
    animation: mcp-live-pulse 2.6s ease-in-out infinite alternate;
  }

  @keyframes mcp-live-pulse {
    from { background-color: #f8f8f8; }
    to { background-color: #ececec; }
  }

  .utility-button.active,
  .utility-button.active:hover {
    border-color: #171717;
    background: #171717;
  }

  .utility-button.active img,
  .utility-button.active:hover img {
    filter: brightness(0) invert(1);
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

  .add-tab:hover img,
  .close-tab:hover img,
  .utility-button:hover img {
    filter: brightness(0.72);
  }

  .add-tab:active img,
  .close-tab:active img,
  .utility-button:active img {
    transform: scale(0.94);
  }

  @media (prefers-reduced-motion: reduce) {
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

  .error-toast {
    position: fixed;
    z-index: 1400;
    right: 24px;
    top: 80px;
    width: 320px;
    padding: 11px 13px 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 9px;
    background: #222222;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2), 0 2px 7px rgba(0, 0, 0, 0.12);
    -webkit-font-smoothing: antialiased;
    transform-origin: top right;
  }

  .error-toast-body {
    display: grid;
    gap: 3px;
    width: 100%;
    color: #ffffff;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 17px;
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: -0.15px;
  }

  .error-toast-body strong {
    font: inherit;
    color: #ffffff;
  }

  .error-toast-body span {
    color: #aaaaaa;
  }

  @keyframes utility-tooltip-in {
    from { opacity: 0; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
  }

  .sidebar {
    position: relative;
    z-index: 2;
    grid-column: 1;
    grid-row: 2;
    min-height: 0;
    overflow-y: auto;
    background: #efefef;
    border-right: 1px solid #c7c7c7;
    box-shadow: 0 0 98.6px rgba(0, 0, 0, 0.06);
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
    gap: 10px;
    /* Clears the 61px logo row that sits over the sidebar, like the editor's thumbnails. */
    padding: 79px 13px 24px 12px;
  }

  .quick-tool {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    height: 68px;
    min-height: 68px;
    padding: 0 12px 0 15px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.6);
    color: rgba(0, 0, 0, 0.75);
    cursor: pointer;
    transition: background-color 180ms ease, border-color 180ms ease, transform 160ms ease;
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
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 21px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.21px;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
  }

  .quick-tool kbd {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 26px;
    height: 27px;
    margin-left: auto;
    border: 1px solid rgba(0, 0, 0, 0.015);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.025);
    color: rgba(0, 0, 0, 0.165);
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 20px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0;
    transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
    -webkit-font-smoothing: antialiased;
  }

  .quick-tool:hover,
  .quick-tool.keyboard-active {
    border-color: rgba(0, 0, 0, 0.18);
    background: #fff;
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
    border-color: rgba(0, 0, 0, 0.02);
    background: rgba(0, 0, 0, 0.055);
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
    grid-template-rows: 154px 76px minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    background:
      linear-gradient(90deg, rgba(0, 0, 0, 0.045) 1px, transparent 1px) 58px 122px / 140px 140px,
      linear-gradient(180deg, rgba(0, 0, 0, 0.045) 1px, transparent 1px) 58px 122px / 140px 140px,
      #e2e2e2;
  }

  .drop-zone {
    position: relative;
    display: grid;
    grid-row: 1;
    place-items: center;
    height: 130px;
    margin: 12px 13px 12px;
    padding: 0;
    overflow: hidden;
    border: 1.5px solid #c3c2c2;
    border-radius: 21px;
    background: rgba(240, 236, 236, 0.75);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
    color: rgba(0, 0, 0, 0.5);
    cursor: pointer;
    backdrop-filter: blur(1.3px);
    -webkit-backdrop-filter: blur(1.3px);
    transition: border-color 180ms ease, background-color 180ms ease, color 180ms ease;
  }

  .drop-zone-content {
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 14px;
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 28px;
    font-weight: 300;
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
    border-color: #b3b1b1;
    background: rgba(246, 243, 243, 0.85);
    color: rgba(0, 0, 0, 0.75);
  }

  .drop-zone:hover .drop-zone-content img {
    filter: brightness(0.6);
    transform: scale(1.04);
  }

  .drop-zone:active .drop-zone-content img {
    transform: scale(0.96);
  }

  .drop-zone:active {
    color: #000;
  }

  .document-browser {
    position: relative;
    z-index: 3;
    display: flex;
    align-items: center;
    grid-row: 2;
    box-sizing: border-box;
    height: 64px;
    margin: 0 13px 12px;
    padding: 0 7px 0 18px;
    border: 1.5px solid #c3c2c2;
    border-radius: 21px;
    background: rgba(240, 236, 236, 0.75);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
    color: rgba(0, 0, 0, 0.75);
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 21px;
    font-weight: 400;
    letter-spacing: -0.21px;
    backdrop-filter: blur(1.3px);
    -webkit-backdrop-filter: blur(1.3px);
    -webkit-font-smoothing: antialiased;
  }

  .recent-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    height: 48px;
    margin-right: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(0, 0, 0, 0.75);
    font: inherit;
    letter-spacing: inherit;
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
    color: #000;
  }

  .recent-heading:hover .recent-arrow :global(path) {
    stroke-opacity: 0.75;
  }

  .document-search {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    width: 314px;
    height: 48px;
    padding: 0 13px 0 11px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 15px;
    background: #fff;
    transition: border-color 180ms ease;
  }

  .document-search:focus-within {
    border-color: rgba(0, 0, 0, 0.18);
  }

  .document-search img {
    width: 25px;
    height: 25px;
    flex: 0 0 auto;
    opacity: 0.75;
  }

  .document-search input {
    width: 100%;
    min-width: 0;
    height: 46px;
    padding: 0 0 0 7px;
    border: 0;
    outline: 0;
    background: transparent;
    color: rgba(0, 0, 0, 0.75);
    font: inherit;
    letter-spacing: inherit;
    appearance: none;
    -webkit-appearance: none;
  }

  .document-search input::placeholder {
    color: rgba(0, 0, 0, 0.5);
    opacity: 1;
  }

  .document-search input::-webkit-search-cancel-button {
    display: none;
  }

  .browser-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }

  .sort-button,
  .filter-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    height: 48px;
    padding: 0 11px 0 13px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 15px;
    background: #fff;
    color: rgba(0, 0, 0, 0.5);
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
    transition: border-color 180ms ease, transform 150ms ease;
  }

  .sort-button {
    position: relative;
    width: 212px;
    padding-right: 4px;
    white-space: nowrap;
    cursor: default;
  }

  .filter-button {
    width: 128px;
  }

  .sort-button strong,
  .filter-button strong {
    color: rgba(0, 0, 0, 0.75);
    font-weight: 400;
  }

  .sort-arrow {
    display: grid;
    place-items: center;
    width: 32px;
    height: 40px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .sort-arrow .chevron {
    width: 8px;
    height: 8px;
    margin-top: -5px;
    border-right: 1.5px solid rgba(0, 0, 0, 0.45);
    border-bottom: 1.5px solid rgba(0, 0, 0, 0.45);
    transform: rotate(45deg);
    transition: border-color 150ms ease, margin-top 200ms cubic-bezier(0.22, 1, 0.36, 1), transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .sort-arrow:hover .chevron {
    border-color: rgba(0, 0, 0, 0.75);
  }

  .sort-arrow.expanded .chevron {
    margin-top: 4px;
    transform: rotate(-135deg);
  }

  .sort-menu {
    position: absolute;
    z-index: 70;
    top: calc(100% + 10px);
    right: 0;
    box-sizing: border-box;
    width: 206px;
    padding: 4px 5px;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.75);
    box-shadow: 0 0 100px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(4.05px);
    -webkit-backdrop-filter: blur(4.05px);
    transform-origin: top right;
  }

  .sort-menu-item {
    display: grid;
    grid-template-columns: 28px 1fr 26px;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    height: 39px;
    padding: 0 5px 0 6px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: rgba(0, 0, 0, 0.75);
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 20px;
    letter-spacing: -0.2px;
    text-align: left;
    cursor: pointer;
    transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease;
  }

  .sort-menu-item.active {
    border-color: rgba(0, 0, 0, 0.08);
    background: rgba(107, 107, 107, 0.05);
    color: #000;
  }

  .sort-menu-item:hover {
    border-color: rgba(0, 0, 0, 0.08);
    background: rgba(107, 107, 107, 0.05);
    color: #000;
  }

  .sort-check {
    opacity: 0;
    color: #0073ff;
    text-align: center;
  }

  .sort-menu-item.active .sort-check {
    opacity: 1;
  }

  .filter-button img {
    width: 24px;
    height: 24px;
    opacity: 0.75;
    transition: filter 150ms ease, opacity 150ms ease;
  }

  .sort-button:hover,
  .filter-button:hover {
    border-color: rgba(0, 0, 0, 0.18);
  }

  .filter-button:hover img {
    opacity: 1;
  }

  .sort-arrow:active,
  .filter-button:active {
    transform: scale(0.98);
  }

  .recent-grid {
    display: grid;
    grid-row: 3;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    grid-auto-rows: auto;
    gap: 17px clamp(9px, 1.2vw, 23px);
    align-content: start;
    padding: 13px 21px 21px;
    overflow: auto;
    scrollbar-width: none;
  }

  /* Home fades in when you come back to it. */
  .quick-tools,
  .workspace > :is(.drop-zone, .document-browser, .recent-grid) {
    animation: home-view-in 240ms ease-out both;
  }

  @keyframes home-view-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* Opening a document: the editor fades in and its pages and thumbnails settle into place. */
  .editor-shell.document-entering :global(.pdf-workspace:not(.editor-inactive)),
  .editor-shell.document-entering :global(.editor-sidebar:not(.editor-inactive)) {
    animation: document-view-in 220ms ease-out both;
  }

  .editor-shell.document-entering :global(.pdf-workspace:not(.editor-inactive) .pdf-page),
  .editor-shell.document-entering :global(.editor-sidebar:not(.editor-inactive) .thumbnail-page) {
    animation: document-page-in 480ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes -global-document-view-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes -global-document-page-in {
    from { opacity: 0; transform: translateY(14px) scale(0.985); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .quick-tools,
    .workspace > :is(.drop-zone, .document-browser, .recent-grid),
    .editor-shell.document-entering :global(.pdf-workspace),
    .editor-shell.document-entering :global(.editor-sidebar),
    .editor-shell.document-entering :global(.pdf-page),
    .editor-shell.document-entering :global(.thumbnail-page) {
      animation: none;
    }
  }

  .recent-grid::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }

  .recent-document {
    display: grid;
    grid-template-rows: auto 48px;
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
    box-sizing: border-box;
    width: 100%;
    height: auto;
    aspect-ratio: 266 / 355;
    overflow: hidden;
    border: 1px solid #dadada;
    border-radius: 8px;
    background: #fff;
    box-shadow: 3px 8px 16px rgba(0, 0, 0, 0.05);
    transition: border-color 170ms ease, box-shadow 170ms ease, background-color 170ms ease;
  }

  .recent-thumbnail {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 7px;
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
    min-width: 0;
    overflow: hidden;
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 20px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.2px;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
  }


  .document-name > span {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
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
    border-color: #c3c2c2;
    background: rgba(240, 236, 236, 0.75);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
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
    color: rgba(0, 0, 0, 0.75);
    transform: translateY(-2px);
  }

  .recent-document:hover .document-preview {
    border-color: #bbb;
    box-shadow: 4px 8px 18px rgba(0, 0, 0, 0.08);
  }

  .open-document:hover .document-preview {
    border-color: #b3b1b1;
    background: rgba(246, 243, 243, 0.85);
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
    width: 206px;
    padding: 4px 5px;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.75);
    box-shadow: 0 0 100px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(4.05px);
    -webkit-backdrop-filter: blur(4.05px);
    transform-origin: top left;
  }

  .recent-menu-item {
    display: grid;
    grid-template-columns: 28px 1fr 26px;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    height: 39px;
    padding: 0 5px 0 6px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: rgba(0, 0, 0, 0.75);
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 20px;
    letter-spacing: -0.2px;
    text-align: left;
    cursor: pointer;
    transition:
      color 180ms cubic-bezier(0.2, 0.7, 0.2, 1),
      background-color 180ms cubic-bezier(0.2, 0.7, 0.2, 1),
      border-color 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .recent-menu-item:hover,
  .recent-menu-item:focus-visible {
    border-color: rgba(0, 0, 0, 0.08);
    background: rgba(107, 107, 107, 0.05);
    color: #000;
    outline: none;
  }

  .recent-menu-item img {
    display: block;
    width: 20px;
    height: 20px;
    object-fit: contain;
    transition: filter 180ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 180ms ease;
  }

  .recent-menu-item.export-document img {
    width: 24px;
    height: 24px;
    margin-left: -2px;
  }

  .recent-menu-item:hover:not(.delete-document) img,
  .recent-menu-item:focus-visible:not(.delete-document) img {
    filter: brightness(0);
  }

  .recent-menu-item kbd {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 26px;
    height: 27px;
    border: 1px solid rgba(0, 0, 0, 0.015);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.025);
    color: rgba(0, 0, 0, 0.165);
    font-family: inherit;
    font-size: 20px;
    letter-spacing: 0;
    transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease;
  }

  .recent-menu-item:hover kbd,
  .recent-menu-item:focus-visible kbd {
    border-color: rgba(0, 0, 0, 0.02);
    background: rgba(0, 0, 0, 0.055);
  }

  .recent-menu-item.delete-document {
    color: rgba(255, 0, 0, 0.85);
  }

  .file-input {
    display: none;
  }

  /* ---- Redesign (Figma "Redesign" frame), shared by home and the document view. Values are frame px; the shell's 0.85 zoom maps them to the screen. ---- */
  .editor-shell,
  .editor-shell.editor-mode {
    background: #e2e2e2;
  }

  .editor-shell .topbar {
    position: relative;
    z-index: 6;
    grid-template-columns: 310px minmax(0, 1fr) auto;
    isolation: isolate;
    overflow: visible;
    border-bottom: 0;
    background: transparent;
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .window-head {
    position: relative;
    z-index: 1;
    grid-column: 1;
    height: 56px;
    overflow: hidden;
  }

  .window-head-texture {
    position: absolute;
    inset: -2px;
    background: #efefef;
    pointer-events: none;
  }

  .window-head-texture::before,
  .window-head-texture::after {
    position: absolute;
    inset: 2px;
    content: '';
  }

  /* The exported texture already carries the layer's 50% opacity in its alpha channel. */
  .window-head-texture::before {
    background: url('/redesign/rectangle992.png') center / 100% 100% no-repeat;
  }

  .window-head-texture::after {
    background:
      linear-gradient(90deg, rgba(255, 255, 255, 0) 43.47%, #fff 100%),
      linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #fff 100%);
  }

  .sidebar-toggle {
    position: absolute;
    top: 18px;
    left: 186px;
    width: 20px;
    height: 20px;
    pointer-events: none;
  }

  .editor-shell .history {
    position: static;
    margin: 0;
  }

  .history-button {
    position: absolute;
    top: 14px;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .history-button.back {
    left: 226px;
  }

  .history-button.forward {
    left: 266px;
  }

  .history-button img {
    display: block;
    transition: opacity 150ms ease;
  }

  .history-button.back img {
    width: 18.4px;
    height: 16.649px;
    transform: rotate(-90deg) scaleY(-1);
  }

  .history-button.forward img {
    width: 18.5px;
    height: 16.7668px;
    transform: rotate(-90deg);
  }

  .history-button:hover img {
    opacity: 0.7;
  }

  .history-button:active img {
    opacity: 0.55;
  }

  .topbar-backdrop {
    position: absolute;
    z-index: 0;
    top: 0;
    right: 0;
    bottom: 0;
    left: 310px;
    overflow: hidden;
    border-bottom: 1px solid #b3b0b0;
    background: rgba(255, 255, 255, 0.65);
    box-shadow: 0 4px 50px rgba(0, 0, 0, 0.1);
    pointer-events: none;
  }

  /* The exported texture already carries the layer's 25% opacity in its alpha channel. */
  .topbar-backdrop img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
  }

  .topbar-backdrop::after {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(90deg, rgba(255, 255, 255, 0) 33.804%, #fff 100%),
      linear-gradient(90deg, #fff 0%, rgba(255, 255, 255, 0) 54.345%);
    content: '';
  }

  .editor-shell .tab-strip {
    position: relative;
    z-index: 1;
    height: 56px;
  }

  .editor-shell .document-tab {
    position: relative;
    gap: 11px;
    max-width: 340px;
    height: 56px;
    margin-right: -1px;
    padding: 0 27px 0 17px;
    border: 1px solid #b0b0b0;
    border-top: 0;
    background: linear-gradient(180deg, rgba(209, 209, 209, 0.15) 0%, rgba(156, 156, 156, 0.15) 100%);
    color: rgba(154, 63, 63, 0.75);
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 21px;
    font-weight: 400;
    letter-spacing: -0.21px;
  }

  .editor-shell .document-tab.active {
    z-index: 1;
    padding-right: 16.5px;
    border-color: #c5c3c3;
    background: linear-gradient(180deg, #efefef 0%, #fff 100%);
    color: #000;
  }

  .editor-shell .document-tab img.tab-file-icon {
    width: 21px;
    height: 21px;
  }

  /* Inactive tabs keep the close button folded away; hovering grows the tab to its selected width and reveals it. */
  .editor-shell .document-tab {
    transition: padding-right 220ms cubic-bezier(0.22, 1, 0.36, 1), background-color 180ms ease, color 180ms ease, opacity 110ms ease;
  }

  .editor-shell .close-tab {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    margin-left: 3px;
    overflow: hidden;
    transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1), margin-left 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease;
  }

  .editor-shell .document-tab:not(.active):not(:hover):not(:focus-within) {
    padding-right: 27px;
  }

  .editor-shell .document-tab:not(.active):hover,
  .editor-shell .document-tab:not(.active):focus-within {
    padding-right: 16.5px;
  }

  .editor-shell .document-tab:not(.active):not(:hover):not(:focus-within) .close-tab {
    width: 0;
    margin-left: -11px;
    opacity: 0;
  }

  .editor-shell .close-tab img.close-tab-cross {
    flex: 0 0 auto;
  }

  .close-tab-cross,
  .add-tab-cross {
    display: block;
    max-width: none;
  }

  .editor-shell .close-tab img.close-tab-cross {
    width: 14.4px;
    height: 14.4px;
  }

  .editor-shell .close-tab:hover img.close-tab-cross {
    filter: brightness(0.6);
  }

  .editor-shell .add-tab {
    flex-basis: 55px;
    width: 55px;
    height: 56px;
  }

  .editor-shell .add-tab img.add-tab-cross {
    width: 19.5px;
    height: 19.5px;
  }

  .editor-shell .add-tab:hover img.add-tab-cross {
    filter: brightness(0.75);
  }

  .editor-shell .add-tab:active img.add-tab-cross {
    transform: scale(0.94);
  }

  .editor-shell .utilities {
    position: relative;
    z-index: 1;
    gap: 10px;
    height: 56px;
    padding: 0 13px 0 14px;
    background: transparent;
    box-shadow: none;
  }

  .editor-shell .utility-button {
    width: 40px;
    height: 40px;
    border: 1px solid rgba(0, 0, 0, 0.05);
    border-radius: 15px;
    background: rgba(0, 0, 0, 0.05);
  }

  .editor-shell .utility-button:hover {
    border-color: rgba(0, 0, 0, 0.07);
    background: rgba(0, 0, 0, 0.08);
  }

  .editor-shell .utility-button:disabled:hover {
    border-color: rgba(0, 0, 0, 0.05);
    background: rgba(0, 0, 0, 0.05);
  }

  .editor-shell .utility-button.active,
  .editor-shell .utility-button.active:hover {
    border-color: #171717;
    background: #171717;
  }

  .editor-shell .utility-button img,
  .editor-shell .utility-button:nth-child(n) img {
    width: 24px;
    height: 24px;
  }

  .editor-shell .utility-button img.utility-icon-mcp,
  .editor-shell .utility-button img.utility-icon-comments {
    width: 25px;
    height: 25px;
  }

  .editor-shell .utility-button.ai-button img {
    width: 23px;
    height: 24px;
  }

  .editor-shell .utility-button[data-utility='settings'] img {
    width: 26px;
    height: 26px;
  }

  .editor-shell .ai-button.ai-busy::after {
    border-color: #ececec;
  }

  .editor-shell .mcp-button.mcp-live:not(.active):not(:hover) {
    animation-name: mcp-live-pulse-editor;
  }

  @keyframes mcp-live-pulse-editor {
    from { background-color: rgba(0, 0, 0, 0.05); }
    to { background-color: rgba(0, 0, 0, 0.1); }
  }

  .sidebar-head {
    position: relative;
    z-index: 5;
    grid-column: 1;
    grid-row: 2;
    align-self: start;
    box-sizing: border-box;
    width: 310px;
    height: 61px;
    border: 1px solid #d3d0d0;
    border-left: 0;
    background: #fff;
  }

  /* 5% larger than the Figma logo, same left edge, centred in the 59px row. */
  .sidebar-logo {
    position: absolute;
    /* The wordmark sits high inside the asset; this centres the letters themselves. */
    top: calc((100% - 45.15px) / 2 + 2.6px);
    left: 15px;
    width: 204.75px;
    height: 45.15px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .sidebar-logo img {
    display: block;
    width: 204.75px;
    height: 45.15px;
  }

  .sidebar-head-button {
    position: absolute;
    top: 9px;
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid rgba(0, 0, 0, 0.05);
    border-radius: 15px;
    background: rgba(0, 0, 0, 0.05);
    cursor: pointer;
    transition: background-color 180ms ease, border-color 180ms ease;
  }

  .sidebar-head-button:nth-of-type(2) {
    left: 207px;
  }

  .sidebar-head-button:nth-of-type(3) {
    left: 257px;
  }

  .sidebar-head-button:hover {
    border-color: rgba(0, 0, 0, 0.07);
    background: rgba(0, 0, 0, 0.08);
  }

  .sidebar-head-button img {
    display: block;
    transition: filter 160ms ease, transform 160ms ease;
  }

  .sidebar-head-button:hover img {
    filter: brightness(0.72);
  }

  .sidebar-head-button:active img {
    transform: scale(0.94);
  }

  .sidebar-search-icon {
    width: 27px;
    height: 27px;
  }

  .sidebar-home-icon {
    width: 21.4px;
    height: 21.7397px;
    margin-top: 1px;
  }

  /* macOS app and website: 95% of the base 0.85 scale. The shell's traffic-light
     position (desktop/src-tauri/src/lib.rs) is derived from this value. */
  :global(html[data-docuflex-desktop='macos']) .editor-shell,
  .editor-shell.website {
    --ui-scale: 0.8075;
  }

  /* Public website: a wider sidebar, and one header row
     (logo + history on the left, search and home in the toolbar on the right). */
  .editor-shell.website {
    grid-template-columns: 340px minmax(0, 1fr);
  }

  /* The logo corner closes the header and sidebar lines: its bottom edge continues the
     top bar's line and its right edge continues the sidebar's, meeting in one cross. */
  .editor-shell.website .window-head {
    box-sizing: border-box;
    border-right: 1px solid #c7c7c7;
    border-bottom: 1px solid #b3b0b0;
  }

  .editor-shell.website .topbar {
    grid-template-columns: 340px minmax(0, 1fr) auto;
  }

  .editor-shell.website .topbar-backdrop {
    left: 340px;
  }

  .editor-shell.website .quick-tools {
    padding-top: 18px;
  }

  .editor-shell.website :global(.thumbnail-list) {
    padding-top: 34px;
  }

  .editor-shell.website .history-button.back {
    left: 246px;
  }

  .editor-shell.website .history-button.forward {
    left: 286px;
  }

  .web-logo {
    position: absolute;
    top: calc((100% - 42.63px) / 2 + 1px);
    left: 20px;
    display: block;
    width: 193.2px;
    height: 42.63px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .web-logo img {
    display: block;
    width: 193.2px;
    height: 42.63px;
  }

  .utility-icon-search,
  .utility-icon-home {
    width: 22px;
    height: 22px;
  }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"] body) { color: rgba(255, 255, 255, 0.859); background: #131313; }
  :global(:root[data-theme="dark"]) .editor-shell { background: #131313; }
  :global(:root[data-theme="dark"]) .topbar { background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid #272727; }
  :global(:root[data-theme="dark"]) .add-tab { border: 0; background: transparent; }
  :global(:root[data-theme="dark"]) .document-tab { border: 0; border-right: 1px solid #202020; background: #141414; color: rgba(255, 255, 255, 0.859); }
  :global(:root[data-theme="dark"]) .document-tab.active { background: #101010; }
  :global(:root[data-theme="dark"]) .utilities { background: rgba(22, 22, 22, 0.96); box-shadow: -12px 0 18px rgba(0, 0, 0, 0.5); }
  :global(:root[data-theme="dark"]) .utility-button { border: 1px solid #202020; background: #141414; }
  :global(:root[data-theme="dark"]) .utility-button:hover { border-color: #2a2a2a; background: #111111; }
  :global(:root[data-theme="dark"]) .ai-button.ai-busy::after { border: 1.5px solid rgba(255, 255, 255, 0.08); background: #0878f9; }
  :global(:root[data-theme="dark"]) .ai-button.active.ai-busy::after { border-color: #ececec; }
  :global(:root[data-theme="dark"]) .utility-button.active,
  :global(:root[data-theme="dark"]) .utility-button.active:hover { border-color: #ececec; background: #ececec; }
  :global(:root[data-theme="dark"]) .utility-button.active img,
  :global(:root[data-theme="dark"]) .utility-button.active:hover img { filter: brightness(0); }
  :global(:root[data-theme="dark"]) .utility-button:disabled:hover { border-color: #202020; background: #141414; }
  :global(:root[data-theme="dark"]) .error-toast { border: 1px solid rgba(0, 0, 0, 0.064); background: #ececec; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6), 0 2px 7px rgba(0, 0, 0, 0.36); }
  :global(:root[data-theme="dark"]) .error-toast-body { color: #111111; }
  :global(:root[data-theme="dark"]) .error-toast-body strong { color: #111111; }
  :global(:root[data-theme="dark"]) .error-toast-body span { color: rgba(255, 255, 255, 0.333); }
  :global(:root[data-theme="dark"]) .sidebar { background: #111111; border-right: 1px solid #2a2a2a; box-shadow: 0 0 98.6px rgba(0, 0, 0, 0.18); }
  :global(:root[data-theme="dark"]) .quick-tool { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.07); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .quick-tool kbd { border: 1px solid rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.033); color: rgba(255, 255, 255, 0.165); }
  :global(:root[data-theme="dark"]) .quick-tool:hover,
  :global(:root[data-theme="dark"]) .quick-tool.keyboard-active { border-color: rgba(255, 255, 255, 0.144); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .quick-tool:hover kbd,
  :global(:root[data-theme="dark"]) .quick-tool.keyboard-active kbd { border-color: rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.072); }
  :global(:root[data-theme="dark"]) .workspace { background: linear-gradient(90deg, rgba(255, 255, 255, 0.058) 1px, transparent 1px) 58px 122px / 140px 140px,
      linear-gradient(180deg, rgba(255, 255, 255, 0.058) 1px, transparent 1px) 58px 122px / 140px 140px,
      #0e0e0e; }
  :global(:root[data-theme="dark"]) .drop-zone { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .drop-zone:hover { border-color: #343434; background: rgba(22, 22, 22, 0.96); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .drop-zone:active { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .document-browser { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .recent-heading { border: 0; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .recent-heading:hover { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .document-search { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .document-search:focus-within { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .document-search input { border: 0; outline: 0; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .document-search input::placeholder { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .sort-button,
  :global(:root[data-theme="dark"]) .filter-button { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .sort-button strong,
  :global(:root[data-theme="dark"]) .filter-button strong { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .sort-arrow { border: 0; background: transparent; }
  :global(:root[data-theme="dark"]) .sort-arrow .chevron { border-right: 1.5px solid rgba(255, 255, 255, 0.36); border-bottom: 1.5px solid rgba(255, 255, 255, 0.36); }
  :global(:root[data-theme="dark"]) .sort-arrow:hover .chevron { border-color: rgba(255, 255, 255, 0.6); }
  :global(:root[data-theme="dark"]) .sort-menu { border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(24, 24, 24, 0.95); box-shadow: 0 0 100px rgba(0, 0, 0, 0.24); }
  :global(:root[data-theme="dark"]) .sort-menu-item { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .sort-menu-item.active { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .sort-menu-item:hover { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .sort-check { color: #0073ff; }
  :global(:root[data-theme="dark"]) .sort-button:hover,
  :global(:root[data-theme="dark"]) .filter-button:hover { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .recent-document { border: 0; background: transparent; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .document-preview { border: 1px solid #212121; background: rgba(22, 22, 22, 0.96); box-shadow: 3px 8px 16px rgba(0, 0, 0, 0.15); }
  :global(:root[data-theme="dark"]) .recent-thumbnail { background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .open-document .document-preview { border-color: #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); }
  :global(:root[data-theme="dark"]) .recent-document:hover { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .recent-document:hover .document-preview { border-color: #2f2f2f; box-shadow: 4px 8px 18px rgba(0, 0, 0, 0.24); }
  :global(:root[data-theme="dark"]) .open-document:hover .document-preview { border-color: #343434; background: rgba(22, 22, 22, 0.96); }
  :global(:root[data-theme="dark"]) .recent-context-menu { border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(24, 24, 24, 0.95); box-shadow: 0 0 100px rgba(0, 0, 0, 0.24); }
  :global(:root[data-theme="dark"]) .recent-menu-item { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .recent-menu-item:hover,
  :global(:root[data-theme="dark"]) .recent-menu-item:focus-visible { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.92); outline: none; }
  :global(:root[data-theme="dark"]) .recent-menu-item:hover:not(.delete-document) img,
  :global(:root[data-theme="dark"]) .recent-menu-item:focus-visible:not(.delete-document) img { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .recent-menu-item kbd { border: 1px solid rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.033); color: rgba(255, 255, 255, 0.165); }
  :global(:root[data-theme="dark"]) .recent-menu-item:hover kbd,
  :global(:root[data-theme="dark"]) .recent-menu-item:focus-visible kbd { border-color: rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.072); }
  :global(:root[data-theme="dark"]) .recent-menu-item.delete-document { color: rgba(255, 0, 0, 0.85); }
  :global(:root[data-theme="dark"]) .editor-shell,
  :global(:root[data-theme="dark"]) .editor-shell.editor-mode { background: #0e0e0e; }
  :global(:root[data-theme="dark"]) .editor-shell .topbar { border-bottom: 0; background: transparent; }
  :global(:root[data-theme="dark"]) .window-head-texture { background: #111111; }
  :global(:root[data-theme="dark"]) .window-head-texture::before { background: url('/redesign/rectangle992.png') center / 100% 100% no-repeat; }
  :global(:root[data-theme="dark"]) .window-head-texture::after { background: linear-gradient(90deg, rgba(255, 255, 255, 0) 43.47%, rgba(255, 255, 255, 0.05) 100%),
      linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.05) 100%); }
  :global(:root[data-theme="dark"]) .history-button { border: 0; background: transparent; }
  :global(:root[data-theme="dark"]) .topbar-backdrop { border-bottom: 1px solid #343434; background: rgba(24, 24, 24, 0.95); box-shadow: 0 4px 50px rgba(0, 0, 0, 0.3); }
  :global(:root[data-theme="dark"]) .topbar-backdrop::after { background: linear-gradient(90deg, rgba(255, 255, 255, 0) 33.804%, rgba(255, 255, 255, 0.05) 100%),
      linear-gradient(90deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0) 54.345%); }
  :global(:root[data-theme="dark"]) .editor-shell .document-tab { border: 1px solid #343434; border-top: 0; background: linear-gradient(180deg, rgba(0, 0, 0, 0.09) 0%, rgba(255, 255, 255, 0.12) 100%); color: rgba(154, 63, 63, 0.75); }
  :global(:root[data-theme="dark"]) .editor-shell .document-tab.active { border-color: #2b2b2b; background: linear-gradient(180deg, #111111 0%, rgba(255, 255, 255, 0.05) 100%); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .editor-shell .utilities { background: transparent; box-shadow: none; }
  :global(:root[data-theme="dark"]) .editor-shell .utility-button { border: 1px solid rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.065); }
  :global(:root[data-theme="dark"]) .editor-shell .utility-button:hover { border-color: rgba(255, 255, 255, 0.056); background: rgba(255, 255, 255, 0.104); }
  :global(:root[data-theme="dark"]) .editor-shell .utility-button:disabled:hover { border-color: rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.065); }
  :global(:root[data-theme="dark"]) .editor-shell .utility-button.active,
  :global(:root[data-theme="dark"]) .editor-shell .utility-button.active:hover { border-color: #ececec; background: #ececec; }
  :global(:root[data-theme="dark"]) .editor-shell .ai-button.ai-busy::after { border-color: rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .sidebar-head { border: 1px solid #252525; border-left: 0; background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .sidebar-logo { border: 0; background: transparent; }
  :global(:root[data-theme="dark"]) .sidebar-head-button { border: 1px solid rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.065); }
  :global(:root[data-theme="dark"]) .sidebar-head-button:hover { border-color: rgba(255, 255, 255, 0.056); background: rgba(255, 255, 255, 0.104); }
  :global(:root[data-theme="dark"]) .editor-shell.website .window-head { border-right: 1px solid #2a2a2a; border-bottom: 1px solid #343434; }
  :global(:root[data-theme="dark"]) .web-logo { border: 0; background: transparent; }
  /* dark theme: end generated */

  /* dark theme: manual */
  /* Shell, after the Figma dark frame (Docuflex › Redesign): black glass top bar and sidebar. */
  :global(:root[data-theme="dark"]) .topbar-backdrop img { filter: invert(1) brightness(0.6) contrast(1.2); }
  /* Dark window head: Figma's starry Rectangle 992 (node 801:1490) with its black fade, not the inverted marble. */
  :global(:root[data-theme="dark"]) .window-head-texture { background: #000; }
  :global(:root[data-theme="dark"]) .window-head-texture::before { background: url('/redesign/rectangle992-dark.png') center bottom / 100% 100% no-repeat; filter: none; }
  /* The marble runs under the whole bar, including the buttons on the right, and fades
     smoothly into black at both ends, like the light bar fades into white. */
  :global(:root[data-theme="dark"]) .topbar-backdrop { border-bottom-color: #222121; background: rgba(0, 0, 0, 0.2); box-shadow: 0 4px 42.5px rgba(0, 0, 0, 0.3); }
  :global(:root[data-theme="dark"]) .topbar-backdrop::after {
    background:
      linear-gradient(90deg, rgba(0, 0, 0, 0) 33.804%, rgba(0, 0, 0, 0.6) 100%),
      linear-gradient(90deg, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0) 54.345%);
  }
  :global(:root[data-theme="dark"]) .window-head-texture::after { background: linear-gradient(180.54deg, rgba(0, 0, 0, 0) 2.67%, #000 97.32%); }
  :global(:root[data-theme="dark"]) .topbar { border-bottom-color: #222121; background: rgba(0, 0, 0, 0.35); }
  /* Home grid matches the editor canvas: about 5% lighter than the shell. */
  :global(:root[data-theme="dark"]) .workspace { background-color: #1a1a1a; }
  :global(:root[data-theme="dark"]) .sidebar { border-color: #202020; background: rgba(12, 12, 12, 0.85); }
  :global(:root[data-theme="dark"]) .sidebar-head { border-color: #232323; background: linear-gradient(180deg, #000 0%, #080808 100%); }
  :global(:root[data-theme="dark"]) .sidebar-head-button { border-color: rgba(255, 255, 255, 0.05); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .sidebar-head-button:hover { border-color: rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.09); }
  /* Tabs: inactive PDF tabs carry a dark red wash, the active tab a lifted grey glass with a soft glow. */
  :global(:root[data-theme="dark"]) .editor-shell .document-tab { border-color: #3b3a3a; background: linear-gradient(180deg, rgba(45, 45, 45, 0.15) 0%, rgba(104, 0, 0, 0.15) 100%); color: rgba(254, 206, 206, 0.5); }
  :global(:root[data-theme="dark"]) .editor-shell .document-tab.active { border-color: #575757; background: linear-gradient(180deg, rgba(77, 77, 77, 0.15) 0%, rgba(255, 255, 255, 0.15) 100%); color: #fff; text-shadow: 0 0 10px rgba(255, 255, 255, 0.25); }
  /* Inline quick-tool icons: grey line work turns light, tile outlines soften. */
  :global(:root[data-theme="dark"]) .quick-tool-icon :global([stroke="#777777"]),
  :global(:root[data-theme="dark"]) .quick-tool-icon :global([stroke="#7C7D7F"]),
  :global(:root[data-theme="dark"]) .quick-tool-icon :global([stroke="#888888"]),
  :global(:root[data-theme="dark"]) .quick-tool-icon :global([stroke="#404040"]),
  :global(:root[data-theme="dark"]) .quick-tool-icon :global([stroke="black"]) { stroke: rgba(255, 255, 255, 0.78); }
  :global(:root[data-theme="dark"]) .quick-tool-icon :global([stroke="#353535"]),
  :global(:root[data-theme="dark"]) .quick-tool-icon :global([stroke="#474747"]) { stroke: #2a2a2c; }
  :global(:root[data-theme="dark"]) .quick-tool:hover .quick-tool-icon :global([stroke]),
  :global(:root[data-theme="dark"]) .quick-tool.keyboard-active .quick-tool-icon :global([stroke]) { filter: brightness(1.35); }

</style>
