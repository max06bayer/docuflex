(() => {
  const desktopBlobUrls = new Map();
  const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
  const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    const url = originalCreateObjectUrl(object);
    if (object instanceof Blob) desktopBlobUrls.set(url, object);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    desktopBlobUrls.delete(String(url));
    originalRevokeObjectUrl(url);
  };

  const installDurableDesktopBlobReads = () => {
    const blobPrototype = globalThis.Blob?.prototype;
    if (!blobPrototype || blobPrototype.datasetDocuflexDurableReads) return;
    const originalArrayBuffer = blobPrototype.arrayBuffer;
    const activeReads = new WeakMap();
    const cacheDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open('docuflex-desktop-file-bytes', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('files')) {
          request.result.createObjectStore('files', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open desktop document storage.'));
    });
    const transactionComplete = (transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Desktop document storage failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Desktop document storage was cancelled.'));
    });
    const fileKey = (file) => `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`;
    const readCachedBytes = async (key) => {
      const database = await cacheDatabase;
      const transaction = database.transaction('files', 'readonly');
      const completion = transactionComplete(transaction);
      const request = transaction.objectStore('files').get(key);
      const record = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Could not read cached document bytes.'));
      });
      await completion;
      return record?.bytes instanceof ArrayBuffer ? record.bytes : null;
    };
    const persistBytes = async (key, bytes) => {
      const database = await cacheDatabase;
      const transaction = database.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      store.put({ key, bytes: bytes.slice(0), touchedAt: Date.now() });
      const all = store.getAll();
      all.onsuccess = () => {
        all.result
          .sort((left, right) => Number(right.touchedAt ?? 0) - Number(left.touchedAt ?? 0))
          .slice(20)
          .forEach((record) => store.delete(record.key));
      };
      await transactionComplete(transaction);
    };
    Object.defineProperty(blobPrototype, 'datasetDocuflexDurableReads', {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    Object.defineProperty(blobPrototype, 'arrayBuffer', {
      configurable: true,
      enumerable: false,
      value() {
        if (!(this instanceof File)) return originalArrayBuffer.call(this);
        let active = activeReads.get(this);
        if (!active) {
          const key = fileKey(this);
          active = (async () => {
            try {
              const cached = await readCachedBytes(key);
              if (cached) return cached;
            } catch {
              // Fall through to the original File while storage is unavailable.
            }
            const bytes = await originalArrayBuffer.call(this);
            try {
              await persistBytes(key, bytes);
            } catch (error) {
              console.warn('Could not retain desktop document bytes:', error);
            }
            return bytes;
          })();
          activeReads.set(this, active);
          void active.then(
            () => activeReads.delete(this),
            () => activeReads.delete(this),
          );
        }
        return active.then((bytes) => bytes.slice(0));
      },
      writable: true,
    });
  };

  installDurableDesktopBlobReads();

  const desktopStyle = `
    html[data-docuflex-desktop="macos"] {
      background: #f8f8f8;
    }

    html[data-docuflex-desktop="macos"] .editor-shell {
      --desktop-sidebar-width: 310px;
      grid-template-columns: var(--desktop-sidebar-width) minmax(0, 1fr) !important;
    }

    html[data-docuflex-desktop="macos"] .topbar {
      grid-template-columns: var(--desktop-sidebar-width) minmax(0, 1fr) auto !important;
      overflow: visible !important;
      position: relative !important;
      z-index: 40 !important;
    }

    html[data-docuflex-desktop="macos"] .topbar,
    html[data-docuflex-desktop="macos"] .brand-area,
    html[data-docuflex-desktop="macos"] .tab-strip,
    html[data-docuflex-desktop="macos"] .utilities {
      -webkit-app-region: drag;
    }

    html[data-docuflex-desktop="macos"] .brand-area {
      justify-content: flex-end !important;
      padding: 0 22px 0 108px !important;
      position: relative !important;
    }

    html[data-docuflex-desktop="macos"] .brand-area::after {
      background: #fff;
      border-bottom: 1px solid #e5e5e5;
      border-right: 1px solid #e5e5e5;
      box-sizing: border-box;
      content: "";
      height: 56px;
      left: 0;
      pointer-events: none;
      position: absolute;
      top: 56px;
      width: var(--desktop-sidebar-width);
      z-index: 1;
    }

    html[data-docuflex-desktop="macos"] .logo-button {
      height: 56px !important;
      left: 16px;
      margin: 0 !important;
      padding: 0 !important;
      position: absolute !important;
      top: 56px;
      width: 180px !important;
      z-index: 2;
    }

    html[data-docuflex-desktop="macos"] .logo {
      height: auto !important;
      width: 180px !important;
    }

    html[data-docuflex-desktop="macos"] .history {
      gap: 24px !important;
      margin-left: 0 !important;
    }

    html[data-docuflex-desktop="macos"] .topbar button,
    html[data-docuflex-desktop="macos"] .topbar a,
    html[data-docuflex-desktop="macos"] .topbar input {
      -webkit-app-region: no-drag;
    }

    html[data-docuflex-desktop="macos"] .sidebar .quick-tools {
      padding-top: 72px !important;
    }

    html[data-docuflex-desktop="macos"] .add-tab {
      position: relative !important;
    }

    html[data-docuflex-desktop="macos"] .add-tab img {
      display: none !important;
    }

    html[data-docuflex-desktop="macos"] .add-tab::before,
    html[data-docuflex-desktop="macos"] .add-tab::after {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 18px;
      height: 1.5px;
      border-radius: 99px;
      background: #9d9d9d;
      content: "";
      pointer-events: none;
      transform: translate(-50%, -50%);
      transition: background-color 150ms ease, transform 150ms ease;
    }

    html[data-docuflex-desktop="macos"] .add-tab::after {
      transform: translate(-50%, -50%) rotate(90deg);
    }

    html[data-docuflex-desktop="macos"] .add-tab:hover::before,
    html[data-docuflex-desktop="macos"] .add-tab:hover::after {
      background: #727272;
    }

    html[data-docuflex-desktop="macos"] .add-tab:active::before {
      transform: translate(-50%, -50%) scale(0.94);
    }

    html[data-docuflex-desktop="macos"] .add-tab:active::after {
      transform: translate(-50%, -50%) rotate(90deg) scale(0.94);
    }

    html[data-docuflex-desktop="macos"] .editor-mode .editor-sidebar .thumbnail-list {
      padding-top: 78px !important;
    }

    html[data-docuflex-desktop="macos"] .editor-mode .utilities .utility-button[aria-label="Home"],
    html[data-docuflex-desktop="macos"] .editor-mode .utilities .utility-button[aria-label="Search"] {
      position: absolute !important;
      top: 63px;
      z-index: 4;
    }

    html[data-docuflex-desktop="macos"] .editor-mode .utilities {
      z-index: 3 !important;
    }

    html[data-docuflex-desktop="macos"] .editor-mode .utilities .utility-button[aria-label="Home"] {
      left: calc(var(--desktop-sidebar-width) - 104px);
    }

    html[data-docuflex-desktop="macos"] .editor-mode .utilities .utility-button[aria-label="Search"] {
      left: calc(var(--desktop-sidebar-width) - 52px);
    }

    html[data-docuflex-desktop="macos"] .editor-mode .utilities .utility-button[aria-label="Home"]::before,
    html[data-docuflex-desktop="macos"] .editor-mode .utilities .utility-button[aria-label="Search"]::before {
      border-radius: inherit;
      content: "";
      inset: 0;
      position: absolute;
    }

    .docuflex-desktop-export-menu {
      -webkit-backdrop-filter: blur(18px);
      animation: docuflex-desktop-export-menu-in 125ms cubic-bezier(0.215, 0.61, 0.355, 1);
      backdrop-filter: blur(18px);
      background: rgba(255, 255, 255, 0.78);
      border: 1px solid rgba(0, 0, 0, 0.18);
      border-radius: 15px;
      box-shadow: 0 7px 18px rgba(0, 0, 0, 0.11), 0 2px 5px rgba(0, 0, 0, 0.05);
      padding: 5px;
      position: fixed;
      transform-origin: top right;
      width: 204px;
      z-index: 10000;
    }

    @keyframes docuflex-desktop-export-menu-in {
      from { opacity: 0; transform: scale(0.94); }
      to { opacity: 1; transform: scale(1); }
    }

    .docuflex-desktop-export-option {
      align-items: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 9px;
      color: #3f3f3f;
      cursor: pointer;
      display: grid;
      font: inherit;
      font-size: 18px;
      height: 40px;
      padding: 0 7px;
      text-align: left;
      width: 100%;
    }

    .docuflex-desktop-export-option:hover,
    .docuflex-desktop-export-option:focus-visible {
      color: #000;
      outline: none;
    }

  `;

  const installDesktopChrome = () => {
    document.documentElement.dataset.docuflexDesktop = 'macos';

    if (!document.getElementById('docuflex-desktop-chrome')) {
      const style = document.createElement('style');
      style.id = 'docuflex-desktop-chrome';
      style.textContent = desktopStyle;
      (document.head || document.documentElement).append(style);
    }

    const markDragRegion = () => {
      document
        .querySelectorAll('.topbar, .brand-area, .tab-strip, .utilities')
        .forEach((element) => element.setAttribute('data-tauri-drag-region', 'deep'));
    };

    markDragRegion();
    new MutationObserver(markDragRegion).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installDesktopChrome, { once: true });
  } else {
    installDesktopChrome();
  }

  const exportButtonSelector = '.utilities .utility-button[aria-label="Download"], .utilities .utility-button[aria-label="Exporting PDF"]';
  const exportFormats = [
    ['pdf', 'PDF'],
    ['docx', 'Word (.docx)'],
    ['doc', 'Word (.doc)'],
    ['xlsx', 'Excel (.xlsx)'],
    ['pptx', 'PowerPoint (.pptx)'],
  ];
  let exportMenu = null;
  let allowExportButtonClick = false;
  let pendingExportFormat = null;

  const exportButton = () => document.querySelector(exportButtonSelector);
  const closeExportMenu = () => {
    exportMenu?.remove();
    exportMenu = null;
  };
  const placeExportMenu = () => {
    const button = exportButton();
    if (!(button instanceof HTMLElement) || !(exportMenu instanceof HTMLElement)) return;
    const bounds = button.getBoundingClientRect();
    const shell = document.querySelector('.editor-shell');
    const scale = shell instanceof HTMLElement
      ? Number.parseFloat(getComputedStyle(shell).getPropertyValue('--ui-scale')) || 1
      : 1;
    exportMenu.style.right = `${Math.max(8, window.innerWidth - bounds.right) / scale}px`;
    exportMenu.style.top = `${Math.min(window.innerHeight / scale - exportMenu.offsetHeight - 8, (bounds.bottom + 8) / scale)}px`;
  };
  const beginExport = (format) => {
    const button = exportButton();
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    closeExportMenu();
    pendingExportFormat = format;
    const expectedFormat = format;
    window.setTimeout(() => {
      if (pendingExportFormat === expectedFormat) pendingExportFormat = null;
    }, 180_000);
    allowExportButtonClick = true;
    button.click();
    allowExportButtonClick = false;
  };
  const openExportMenu = () => {
    if (exportMenu) {
      closeExportMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'docuflex-desktop-export-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Export format');
    for (const [format, label] of exportFormats) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'docuflex-desktop-export-option';
      option.setAttribute('role', 'menuitem');
      const optionLabel = document.createElement('span');
      optionLabel.textContent = label;
      option.append(optionLabel);
      option.addEventListener('click', () => beginExport(format));
      menu.append(option);
    }
    (document.querySelector('.editor-shell') || document.body).append(menu);
    exportMenu = menu;
    placeExportMenu();
    menu.querySelector('button')?.focus({ preventScroll: true });
  };

  const convertedFileName = (pdfName, format) => `${pdfName.replace(/\.pdf$/i, '')}.${format}`;
  const convertExportedPdf = async (anchor, format) => {
    try {
      const retainedPdfBlob = desktopBlobUrls.get(anchor.href);
      const pdfResponse = retainedPdfBlob ? null : await fetch(anchor.href);
      if (pdfResponse && !pdfResponse.ok) throw new Error('Could not read the edited PDF.');
      const pdfBlob = retainedPdfBlob ?? await pdfResponse.blob();
      const pdfName = anchor.download || 'document-edited.pdf';
      const form = new FormData();
      form.set('file', new File([pdfBlob], pdfName, { type: 'application/pdf' }));
      form.set('outputFormat', format);
      const response = await fetch('/api/convert', { method: 'POST', body: form });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error || `Could not export ${format.toUpperCase()}.`);
      }
      const outputUrl = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = outputUrl;
      download.download = convertedFileName(pdfName, format);
      download.dataset.docuflexFinalExport = 'true';
      download.style.display = 'none';
      document.body.append(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(outputUrl), 60_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not export ${format.toUpperCase()}.`;
      window.alert(message);
    }
  };

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function desktopExportClick() {
    if (this.dataset.docuflexFinalExport === 'true') {
      return originalAnchorClick.call(this);
    }
    if (pendingExportFormat && this.download?.toLowerCase().endsWith('.pdf') && this.href.startsWith('blob:')) {
      const format = pendingExportFormat;
      pendingExportFormat = null;
      if (format === 'pdf') return originalAnchorClick.call(this);
      void convertExportedPdf(this, format);
      return;
    }
    return originalAnchorClick.call(this);
  };

  window.addEventListener('click', (event) => {
    const clickedExportButton = event.target instanceof Element ? event.target.closest(exportButtonSelector) : null;
    if (clickedExportButton) {
      if (allowExportButtonClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openExportMenu();
      return;
    }

    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor) return;
    if (anchor.dataset.docuflexFinalExport === 'true') return;
    const target = new URL(anchor.href, window.location.href);
    if (target.origin === window.location.origin && target.pathname === '/') {
      event.preventDefault();
      window.location.replace('/editor');
    }
  }, true);

  window.addEventListener('pointerdown', (event) => {
    if (!exportMenu) return;
    if (event.target instanceof Node && exportMenu.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest(exportButtonSelector)) return;
    closeExportMenu();
  }, true);

  window.addEventListener('resize', placeExportMenu);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && exportMenu) {
      event.preventDefault();
      closeExportMenu();
      return;
    }
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
    if (event.key.toLowerCase() !== 's') return;
    const download = exportButton();
    if (!(download instanceof HTMLButtonElement) || download.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    beginExport('pdf');
  }, true);
})();
