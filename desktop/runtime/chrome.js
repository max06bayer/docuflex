(() => {
  const desktopPlatform = /Windows/i.test(navigator.userAgent)
    ? 'windows'
    : /Linux/i.test(navigator.userAgent)
      ? 'linux'
      : 'macos';
  const desktopBlobUrls = new Map();
  const NativeDesktopFile = globalThis.File;
  const desktopConstructedFileBytes = new WeakMap();
  if (typeof NativeDesktopFile === 'function') {
    const DocuflexDesktopFile = function (parts, name, options) {
      const file = new NativeDesktopFile(parts, name, options);
      if (parts?.length === 1) {
        const part = parts[0];
        if (part instanceof ArrayBuffer) {
          desktopConstructedFileBytes.set(file, part.slice(0));
        } else if (ArrayBuffer.isView(part)) {
          desktopConstructedFileBytes.set(
            file,
            part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
          );
        }
      }
      return file;
    };
    Object.setPrototypeOf(DocuflexDesktopFile, NativeDesktopFile);
    DocuflexDesktopFile.prototype = NativeDesktopFile.prototype;
    globalThis.File = DocuflexDesktopFile;
  }
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
        if (!(this instanceof NativeDesktopFile)) return originalArrayBuffer.call(this);
        const constructedBytes = desktopConstructedFileBytes.get(this);
        if (constructedBytes) return Promise.resolve(constructedBytes.slice(0));
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

  const arrayBufferToBase64 = (bufferLike) => {
    const bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  };

  const isDesktopRuntime = () => typeof window.__TAURI__ !== 'undefined';

  // Bridge used by DocuflexApp.svelte's Save button (desktop/src-tauri commands
  // docuflex_save_prompt / docuflex_save_overwrite) to write PDF bytes straight
  // to disk instead of going through a browser download.
  window.__docuflexNative = isDesktopRuntime()
    ? {
        async promptAndSave(suggestedName, bytes) {
          return window.__TAURI__.core.invoke('docuflex_save_prompt', {
            suggestedName,
            base64: arrayBufferToBase64(bytes),
          });
        },
        async overwrite(path, bytes) {
          return window.__TAURI__.core.invoke('docuflex_save_overwrite', {
            path,
            base64: arrayBufferToBase64(bytes),
          });
        },
      }
    : null;

  const desktopStyle = `
    html[data-docuflex-desktop="macos"] {
      background: #f8f8f8;
    }

    html[data-docuflex-desktop="macos"] .topbar,
    html[data-docuflex-desktop="macos"] .brand-area,
    html[data-docuflex-desktop="macos"] .tab-strip,
    html[data-docuflex-desktop="macos"] .utilities {
      -webkit-app-region: drag;
    }

    html[data-docuflex-desktop="macos"] .topbar button,
    html[data-docuflex-desktop="macos"] .topbar a,
    html[data-docuflex-desktop="macos"] .topbar input {
      -webkit-app-region: no-drag;
    }

    html[data-docuflex-desktop="linux"] .editor-shell {
      height: 117.6470588dvh !important;
      transform: scale(0.85);
      transform-origin: top left;
      width: 117.6470588vw !important;
      zoom: 1 !important;
    }

    html[data-docuflex-desktop="linux"] .text-highlight-layer .text-highlight,
    html[data-docuflex-desktop="linux"] [data-docuflex-annotation-type="highlight"] rect {
      mix-blend-mode: multiply !important;
      opacity: 0.42 !important;
    }

    html[data-docuflex-desktop="windows"] .topbar,
    html[data-docuflex-desktop="windows"] .brand-area,
    html[data-docuflex-desktop="windows"] .tab-strip,
    html[data-docuflex-desktop="windows"] .utilities,
    html[data-docuflex-desktop="linux"] .topbar,
    html[data-docuflex-desktop="linux"] .brand-area,
    html[data-docuflex-desktop="linux"] .tab-strip,
    html[data-docuflex-desktop="linux"] .utilities {
      -webkit-app-region: drag;
    }

    html[data-docuflex-desktop="windows"] .utilities,
    html[data-docuflex-desktop="linux"] .utilities {
      padding-right: 168px !important;
    }

    html[data-docuflex-desktop="windows"] .topbar button,
    html[data-docuflex-desktop="windows"] .topbar a,
    html[data-docuflex-desktop="windows"] .topbar input,
    html[data-docuflex-desktop="linux"] .topbar button,
    html[data-docuflex-desktop="linux"] .topbar a,
    html[data-docuflex-desktop="linux"] .topbar input,
    html[data-docuflex-desktop="windows"] .docuflex-window-controls,
    html[data-docuflex-desktop="linux"] .docuflex-window-controls {
      -webkit-app-region: no-drag;
    }

    .docuflex-window-controls {
      display: none;
    }

    html[data-docuflex-desktop="windows"] .docuflex-window-controls,
    html[data-docuflex-desktop="linux"] .docuflex-window-controls {
      display: flex;
      height: 32px;
      position: fixed;
      right: 0;
      top: 0;
      z-index: 10002;
    }

    .docuflex-window-control {
      align-items: center;
      background: transparent;
      border: 0;
      color: #616161;
      display: flex;
      height: 32px;
      justify-content: center;
      padding: 0;
      position: relative;
      width: 46px;
    }

    .docuflex-window-control:hover {
      background: rgba(0, 0, 0, 0.07);
      color: #171717;
    }

    .docuflex-window-control.close:hover {
      background: #c42b1c;
      color: #fff;
    }

    .docuflex-window-control::before,
    .docuflex-window-control::after {
      box-sizing: border-box;
      content: "";
      position: absolute;
    }

    .docuflex-window-control.minimize::before {
      border-top: 1px solid currentColor;
      height: 1px;
      width: 10px;
    }

    .docuflex-window-control.maximize::before {
      border: 1px solid currentColor;
      height: 10px;
      width: 10px;
    }

    .docuflex-window-control.close::before,
    .docuflex-window-control.close::after {
      background: currentColor;
      height: 1px;
      transform: rotate(45deg);
      width: 12px;
    }

    .docuflex-window-control.close::after {
      transform: rotate(-45deg);
    }

    /* Linux: one compact framed group at the end of the header's button row. */
    html[data-docuflex-desktop="linux"] .utilities .docuflex-window-controls {
      align-items: center;
      background: #f8f8f8;
      border: 1px solid #dedede;
      border-radius: 10px;
      box-sizing: border-box;
      flex: none;
      gap: 2px;
      height: 41px;
      margin-left: 6px;
      padding: 0 3px;
      position: static;
    }

    html[data-docuflex-desktop="linux"] .utilities .docuflex-window-control {
      border-radius: 7px;
      color: #4a4a4a;
      cursor: pointer;
      height: 33px;
      width: 38px;
    }

    html[data-docuflex-desktop="linux"] .utilities .docuflex-window-control.close:hover {
      background: #e5484d;
    }

    html[data-docuflex-desktop="linux"] .utilities:has(.docuflex-window-controls) {
      padding-right: 9px !important;
    }

    html[data-docuflex-desktop="linux"][data-theme="dark"] .utilities .docuflex-window-controls {
      background: rgba(255, 255, 255, 0.065);
      border-color: rgba(255, 255, 255, 0.04);
    }

    html[data-docuflex-desktop="linux"][data-theme="dark"] .utilities .docuflex-window-control {
      color: #c8c8c8;
    }

    html[data-docuflex-desktop="linux"][data-theme="dark"] .utilities .docuflex-window-control:hover {
      background: rgba(255, 255, 255, 0.09);
      color: #fff;
    }

    html[data-docuflex-desktop="linux"][data-theme="dark"] .utilities .docuflex-window-control.close:hover {
      background: #e5484d;
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
    document.documentElement.dataset.docuflexDesktop = desktopPlatform;

    if (!document.getElementById('docuflex-desktop-chrome')) {
      const style = document.createElement('style');
      style.id = 'docuflex-desktop-chrome';
      style.textContent = desktopStyle;
      (document.head || document.documentElement).append(style);
    }

    const markDragRegion = () => {
      document.querySelectorAll('.topbar, .brand-area, .tab-strip, .utilities, .ai-header').forEach((element) => {
        element.setAttribute('data-tauri-drag-region', '');
        element.querySelectorAll('*').forEach((child) => {
          if (!child.closest('button, a, input, select, textarea, [role="button"]')) {
            child.setAttribute('data-tauri-drag-region', '');
          }
        });
      });
    };

    // The header is re-rendered between pages, so keep the controls in it.
    const placeWindowControls = () => {
      if (desktopPlatform !== 'linux') return;
      const controls = document.querySelector('.docuflex-window-controls');
      const utilities = document.querySelector('.utilities');
      if (!controls) return;
      if (utilities && controls.parentElement !== utilities) utilities.append(controls);
      else if (!utilities && controls.parentElement !== document.body) document.body.append(controls);
    };

    markDragRegion();
    new MutationObserver(() => {
      markDragRegion();
      placeWindowControls();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    if (desktopPlatform !== 'macos' && !document.querySelector('.docuflex-window-controls')) {
      const controls = document.createElement('div');
      controls.className = 'docuflex-window-controls';
      controls.setAttribute('aria-label', 'Window controls');
      for (const [action, label] of [
        ['minimize', 'Minimize'],
        ['maximize', 'Maximize or restore'],
        ['close', 'Close'],
      ]) {
        const button = document.createElement('button');
        button.className = `docuflex-window-control ${action}`;
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.addEventListener('click', () => {
          window.location.assign(`/__docuflex/window/${action}`);
        });
        controls.append(button);
      }
      document.body.append(controls);
      placeWindowControls();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installDesktopChrome, { once: true });
  } else {
    installDesktopChrome();
  }

  if (desktopPlatform !== 'macos') {
    const forwardedZoomEvents = new WeakSet();
    window.addEventListener('wheel', (event) => {
      if (forwardedZoomEvents.has(event) || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const slowed = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX * 0.32,
        deltaY: event.deltaY * 0.32,
        deltaZ: event.deltaZ * 0.32,
      });
      forwardedZoomEvents.add(slowed);
      event.target?.dispatchEvent(slowed);
    }, { capture: true, passive: false });
  }

  // The editor's own input, not the ones inside the tool panels (Convert, Compress, ...).
  const desktopPdfInputSelector = 'main.editor-shell > input.file-input[type="file"]';
  // The app renders client-side only, so on a cold start (e.g. double-clicking a PDF
  // while Docuflex is closed) the input does not exist yet when this script first runs.
  const waitForDesktopPdfInput = (timeoutMs = 60_000) => new Promise((resolve) => {
    const existing = document.querySelector(desktopPdfInputSelector);
    if (existing instanceof HTMLInputElement) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const input = document.querySelector(desktopPdfInputSelector);
      if (!(input instanceof HTMLInputElement)) return;
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve(input);
    });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });

  const openPendingNativePdf = async () => {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (typeof invoke !== 'function') return;
    // Wait for the editor before taking the PDF: taking it clears it on the native side.
    const input = await waitForDesktopPdfInput();
    if (!(input instanceof HTMLInputElement)) {
      console.error('Could not find the desktop PDF input.');
      return;
    }
    const pending = await invoke('take_pending_pdf').catch((error) => {
      console.error('Could not read the PDF opened by the operating system:', error);
      return null;
    });
    if (!pending?.base64 || !pending?.name) return;
    const binary = atob(pending.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const file = new File([bytes], pending.name, { type: 'application/pdf', lastModified: Date.now() });
    // Lets DocuflexApp.svelte's Save button overwrite this exact file in place.
    if (pending.path) file.__docuflexSourcePath = pending.path;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  window.addEventListener('docuflex-native-open-pdf', () => void openPendingNativePdf());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void openPendingNativePdf(), { once: true });
  } else {
    void openPendingNativePdf();
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

  // Finalizes a completed export anchor. On desktop this always routes through
  // the native Finder save panel (docuflex_save_prompt) instead of letting the
  // browser handle the blob download itself: a plain anchor.click() on a
  // blob: URL can silently save straight to ~/Downloads in WKWebView without
  // ever prompting, which is exactly the "just saves without asking" behavior
  // Download is meant not to have.
  const finalizeDownload = async (anchor) => {
    if (!window.__docuflexNative) {
      originalAnchorClick.call(anchor);
      return;
    }
    try {
      const retainedBlob = desktopBlobUrls.get(anchor.href);
      const blob = retainedBlob ?? await (await fetch(anchor.href)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await window.__docuflexNative.promptAndSave(anchor.download || 'document.pdf', bytes);
    } catch (error) {
      if (error !== 'cancelled') {
        const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not save this file.';
        window.dispatchEvent(new CustomEvent('docuflex:error', { detail: { title: 'Could not download this PDF', message } }));
      }
    }
  };

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function desktopExportClick() {
    if (this.dataset.docuflexFinalExport === 'true') {
      void finalizeDownload(this);
      return;
    }
    if (pendingExportFormat && this.download?.toLowerCase().endsWith('.pdf') && this.href.startsWith('blob:')) {
      const format = pendingExportFormat;
      pendingExportFormat = null;
      if (format === 'pdf') {
        void finalizeDownload(this);
        return;
      }
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
