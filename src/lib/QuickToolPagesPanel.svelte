<script>
  import { onDestroy, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { fly, scale } from 'svelte/transition';

  /** @typedef {{ pageIndex: number; x: number; y: number } | null} PageMenu */

  /** @type {'merge' | 'split'} */
  export let tool = 'merge';
  /** @type {() => void} */
  export let onClose = () => {};

  /** @type {HTMLInputElement | undefined} */
  let uploadInput;
  /** @type {HTMLDivElement | undefined} */
  let pageList;
  /** @type {File | null} */
  let workingFile = null;
  let pageCount = 0;
  let selectedPages = new Set();
  /** @type {number | null} */
  let selectionAnchor = null;
  /** @type {PageMenu} */
  let pageContextMenu = null;
  /** @type {{ pdfBase64: string; count: number } | null} */
  let pageClipboard = null;
  let busy = false;
  let status = '';
  let error = '';
  let fileCount = 0;
  let splitRanges = '';
  /** @type {number | null} */
  let externalPdfDropIndex = null;
  /** @type {number[]} */
  let draggedPages = [];
  /** @type {number[]} */
  let pageDragPreviewOrder = [];
  let pageDragInsertionIndex = 0;
  let ignoreNextPageClick = false;
  /** @type {{ pointerId: number; pageIndex: number; startX: number; startY: number; clientX: number; clientY: number; offsetX: number; offsetY: number; width: number; height: number; uiScale: number; imageUrl: string; active: boolean } | null} */
  let pagePointerDrag = null;
  /** @type {(() => void) | null} */
  let pageDragCleanup = null;
  let renderGeneration = 0;
  /** @type {import('pdfjs-dist').PDFDocumentProxy | null} */
  let renderedDocument = null;
  /** @type {import('pdfjs-dist').PDFDocumentLoadingTask | null} */
  let loadingTask = null;

  $: title = tool === 'split' ? 'Split' : 'Merge';
  $: splitGroups = tool === 'split' ? parseRanges(splitRanges, pageCount) : null;
  $: actionLabel = status || (tool === 'split'
    ? (splitGroups && splitGroups.length > 1 ? `Split into ${splitGroups.length} Files` : 'Split PDF')
    : (fileCount > 1 ? `Merge ${fileCount} Files` : 'Merge PDFs'));
  $: actionDisabled = busy || !workingFile || (tool === 'split' ? !splitGroups : fileCount < 2);

  /** Turns "1-3, 5" into [[0,1,2],[4]]; an empty field means one file per page. */
  /** @param {string} text @param {number} count @returns {number[][] | null} */
  function parseRanges(text, count) {
    if (!count) return null;
    const trimmed = text.trim();
    if (!trimmed) return Array.from({ length: count }, (_, index) => [index]);
    /** @type {number[][]} */
    const groups = [];
    for (const part of trimmed.split(/[,;]+/).map((entry) => entry.trim()).filter(Boolean)) {
      const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) return null;
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : start;
      if (start < 1 || end < start || end > count) return null;
      groups.push(Array.from({ length: end - start + 1 }, (_, offset) => start - 1 + offset));
    }
    return groups.length ? groups : null;
  }

  function chooseFiles() {
    uploadInput?.click();
  }

  /** @param {Event} event */
  async function handleFiles(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const files = [...(input.files ?? [])].filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    input.value = '';
    if (files.length) await appendFiles(files);
  }

  /** @param {File[]} files @param {number} [requestedInsertAt] */
  async function appendFiles(files, requestedInsertAt = pageCount) {
    if (busy) return;
    if (tool === 'split') {
      // Split works on one document: a new upload replaces the current one.
      workingFile = null;
      pageCount = 0;
      fileCount = 0;
      selectedPages = new Set();
      splitRanges = '';
      files = files.slice(0, 1);
    }
    busy = true;
    error = '';
    status = 'Adding…';
    try {
      let insertAt = Math.max(0, Math.min(requestedInsertAt, pageCount));
      for (const file of files) {
        if (!workingFile) {
          workingFile = file;
        } else {
          const previousCount = pageCount;
          const result = await requestPageOperation('insert', {
            insertAt,
            insertPdfBase64: arrayBufferToBase64(await file.arrayBuffer())
          });
          workingFile = new File([result], workingFile.name, { type: 'application/pdf', lastModified: Date.now() });
          fileCount += 1;
          await renderPages();
          insertAt += pageCount - previousCount;
          continue;
        }
        fileCount = 1;
        await renderPages();
        insertAt = pageCount;
      }
      if (!selectedPages.size && pageCount) {
        selectedPages = new Set([0]);
        selectionAnchor = 0;
      }
      status = '';
    } catch (failure) {
      console.error(failure);
      status = '';
      error = failure instanceof Error ? failure.message : 'Could not add the PDF.';
    } finally {
      busy = false;
    }
  }

  async function renderPages() {
    if (!workingFile) return;
    const generation = ++renderGeneration;
    // pdfjs-dist dropped PDFDocumentProxy.destroy(); only the loading task that
    // produced it still has one, so destroy that instead of renderedDocument.
    await loadingTask?.destroy?.()?.catch(() => {});
    renderedDocument = null;
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.mjs?url')
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    loadingTask = pdfjs.getDocument({ data: await workingFile.arrayBuffer() });
    const document = await loadingTask.promise;
    if (generation !== renderGeneration) {
      await loadingTask.destroy();
      return;
    }
    renderedDocument = document;
    pageCount = document.numPages;
    selectedPages = new Set([...selectedPages].filter((page) => page < pageCount));
    await tick();
    for (let index = 0; index < pageCount; index += 1) {
      if (generation !== renderGeneration) return;
      const canvas = pageList?.querySelector(`canvas[data-page="${index}"]`);
      if (!(canvas instanceof HTMLCanvasElement)) continue;
      const page = await document.getPage(index + 1);
      const baseViewport = page.getViewport({ scale: 1 });
      const renderScale = 380 / Math.max(1, baseViewport.width);
      const viewport = page.getViewport({ scale: renderScale });
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const shell = canvas.closest('.quick-thumbnail-page');
      if (shell instanceof HTMLElement) shell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) continue;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
    }
  }

  /** @param {number} pageIndex @param {MouseEvent} event */
  function selectPage(pageIndex, event) {
    if (ignoreNextPageClick) {
      ignoreNextPageClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    pageContextMenu = null;
    if (event.shiftKey && selectionAnchor !== null) {
      const start = Math.min(selectionAnchor, pageIndex);
      const end = Math.max(selectionAnchor, pageIndex);
      selectedPages = new Set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selectedPages);
      if (next.has(pageIndex)) next.delete(pageIndex);
      else next.add(pageIndex);
      selectedPages = next;
      selectionAnchor = pageIndex;
      return;
    }
    selectedPages = new Set([pageIndex]);
    selectionAnchor = pageIndex;
  }

  /** @param {DataTransfer | null} transfer */
  function transferMayContainPdf(transfer) {
    if (!transfer) return false;
    return [...transfer.items].some((item) => item.kind === 'file' && (item.type === 'application/pdf' || !item.type));
  }

  /** @param {DragEvent} event @param {number} insertAt */
  function showExternalPdfDropTarget(event, insertAt) {
    if (busy || !transferMayContainPdf(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    externalPdfDropIndex = insertAt;
  }

  /** @param {DragEvent} event @param {number} insertAt */
  function hideExternalPdfDropTarget(event, insertAt) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    if (externalPdfDropIndex === insertAt) externalPdfDropIndex = null;
  }

  /** @param {DragEvent} event @param {number} insertAt */
  function dropExternalPdf(event, insertAt) {
    event.preventDefault();
    event.stopPropagation();
    externalPdfDropIndex = null;
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    if (files.length) void appendFiles(files, insertAt);
  }

  /** @param {DragEvent} event */
  function autoScrollExternalDrag(event) {
    if (!transferMayContainPdf(event.dataTransfer)) return;
    event.preventDefault();
    if (!pageList) return;
    const rect = pageList.getBoundingClientRect();
    const zone = Math.min(110, rect.height * 0.2);
    if (event.clientY - rect.top < zone) pageList.scrollTop -= 18;
    else if (rect.bottom - event.clientY < zone) pageList.scrollTop += 18;
  }

  /** @param {number} insertionIndex */
  function updatePageDragPreview(insertionIndex) {
    const remaining = Array.from({ length: pageCount }, (_, index) => index).filter((index) => !draggedPages.includes(index));
    const boundedIndex = Math.max(0, Math.min(insertionIndex, remaining.length));
    pageDragInsertionIndex = boundedIndex;
    const nextOrder = [...remaining.slice(0, boundedIndex), ...draggedPages, ...remaining.slice(boundedIndex)];
    if (!nextOrder.every((page, index) => pageDragPreviewOrder[index] === page)) pageDragPreviewOrder = nextOrder;
  }

  /** @param {PointerEvent} event @param {number} pageIndex */
  function beginPagePointerDrag(event, pageIndex) {
    if (event.button !== 0 || busy) return;
    pageDragCleanup?.();
    draggedPages = selectedPages.has(pageIndex) ? selectedPageIndexes() : [pageIndex];
    pageContextMenu = null;
    const button = event.currentTarget;
    if (!(button instanceof HTMLElement)) return;
    const rect = button.getBoundingClientRect();
    const uiScale = rect.width / Math.max(1, button.offsetWidth);
    const canvas = button.querySelector('canvas');
    let imageUrl = '';
    try { if (canvas instanceof HTMLCanvasElement) imageUrl = canvas.toDataURL('image/png'); } catch {}
    pagePointerDrag = {
      pointerId: event.pointerId, pageIndex, startX: event.clientX, startY: event.clientY,
      clientX: event.clientX, clientY: event.clientY, offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top, width: button.offsetWidth, height: button.offsetHeight,
      uiScale: Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1, imageUrl, active: false
    };
    /** @type {number | undefined} */
    let autoScrollFrame;
    let autoScrollSpeed = 0;

    /** @param {number} clientY */
    function updateInsertion(clientY) {
      if (!pagePointerDrag?.active) return;
      const remaining = Array.from({ length: pageCount }, (_, index) => index).filter((index) => !draggedPages.includes(index));

      /** @param {number} page */
      function stablePageCenter(page) {
        const entry = pageList?.querySelector(`.thumbnail-entry[data-page-index="${page}"]`);
        if (!(entry instanceof HTMLElement)) return null;
        const rect = entry.getBoundingClientRect();
        const transform = getComputedStyle(entry).transform;
        let translateY = 0;
        try {
          if (transform && transform !== 'none') translateY = new DOMMatrixReadOnly(transform).m42;
        } catch {
          translateY = 0;
        }
        return rect.top - translateY + rect.height / 2;
      }

      let insertion = pageDragInsertionIndex;
      const hysteresis = 18;
      while (insertion < remaining.length) {
        const nextCenter = stablePageCenter(remaining[insertion]);
        if (nextCenter === null || clientY <= nextCenter + hysteresis) break;
        insertion += 1;
      }
      while (insertion > 0) {
        const previousCenter = stablePageCenter(remaining[insertion - 1]);
        if (previousCenter === null || clientY >= previousCenter - hysteresis) break;
        insertion -= 1;
      }
      if (insertion !== pageDragInsertionIndex) updatePageDragPreview(insertion);
    }

    function runAutoScroll() {
      if (!pagePointerDrag?.active) return;
      if (pageList && autoScrollSpeed) {
        pageList.scrollTop += autoScrollSpeed;
        updateInsertion(pagePointerDrag.clientY);
      }
      autoScrollFrame = requestAnimationFrame(runAutoScroll);
    }

    /** @param {PointerEvent} moveEvent */
    function movePage(moveEvent) {
      if (!pagePointerDrag || moveEvent.pointerId !== pagePointerDrag.pointerId) return;
      if (!pagePointerDrag.active && Math.hypot(moveEvent.clientX - pagePointerDrag.startX, moveEvent.clientY - pagePointerDrag.startY) < 6) return;
      if (!pagePointerDrag.active) {
        if (!selectedPages.has(pageIndex)) {
          selectedPages = new Set([pageIndex]);
          selectionAnchor = pageIndex;
        }
        const insertion = Array.from({ length: pageCount }, (_, index) => index).filter((index) => !draggedPages.includes(index) && index < draggedPages[0]).length;
        pageDragInsertionIndex = insertion;
        updatePageDragPreview(insertion);
        document.documentElement.classList.add('page-dragging');
        autoScrollFrame = requestAnimationFrame(runAutoScroll);
      }
      moveEvent.preventDefault();
      pagePointerDrag = { ...pagePointerDrag, clientX: moveEvent.clientX, clientY: moveEvent.clientY, active: true };
      if (pageList) {
        const listRect = pageList.getBoundingClientRect();
        const zone = Math.min(130, listRect.height * 0.24);
        const topDistance = moveEvent.clientY - listRect.top;
        const bottomDistance = listRect.bottom - moveEvent.clientY;
        autoScrollSpeed = topDistance < zone ? -Math.max(2, 28 * (1 - Math.max(0, topDistance) / zone))
          : bottomDistance < zone ? Math.max(2, 28 * (1 - Math.max(0, bottomDistance) / zone)) : 0;
      }
      updateInsertion(moveEvent.clientY);
    }

    /** @param {PointerEvent} endEvent */
    function finishPage(endEvent) {
      if (!pagePointerDrag || endEvent.pointerId !== pagePointerDrag.pointerId) return;
      const wasActive = pagePointerDrag.active;
      const order = [...pageDragPreviewOrder];
      const dragged = [...draggedPages];
      pageDragCleanup?.();
      if (!wasActive || !order.length || order.every((page, index) => page === index)) return;
      ignoreNextPageClick = true;
      const nextSelection = new Set(dragged.map((page) => order.indexOf(page)));
      void replaceWorkingFile('Reordering pages…', requestPageOperation('reorder', { order }), nextSelection);
    }

    pageDragCleanup = () => {
      window.removeEventListener('pointermove', movePage);
      window.removeEventListener('pointerup', finishPage);
      window.removeEventListener('pointercancel', finishPage);
      if (autoScrollFrame !== undefined) cancelAnimationFrame(autoScrollFrame);
      document.documentElement.classList.remove('page-dragging');
      pagePointerDrag = null;
      draggedPages = [];
      pageDragPreviewOrder = [];
      pageDragInsertionIndex = 0;
      pageDragCleanup = null;
    };
    window.addEventListener('pointermove', movePage, { passive: false });
    window.addEventListener('pointerup', finishPage);
    window.addEventListener('pointercancel', finishPage);
  }

  /** @param {MouseEvent} event @param {number} pageIndex */
  function openPageContextMenu(event, pageIndex) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedPages.has(pageIndex)) {
      selectedPages = new Set([pageIndex]);
      selectionAnchor = pageIndex;
    }
    const menuWidth = 204;
    const menuHeight = 252;
    pageContextMenu = {
      pageIndex,
      x: Math.max(10, Math.min(event.clientX, window.innerWidth - menuWidth - 10)),
      y: Math.max(10, Math.min(event.clientY, window.innerHeight - menuHeight - 10))
    };
  }

  function selectedPageIndexes() {
    return [...selectedPages].sort((left, right) => left - right);
  }

  /** @param {string} operation @param {Record<string, unknown>} details @param {ArrayBuffer | null} [source] */
  async function requestPageOperation(operation, details, source = null) {
    if (!workingFile && !source) throw new Error('Upload a PDF first.');
    const bytes = source ?? await /** @type {File} */ (workingFile).arrayBuffer();
    const response = await fetch('/api/pdf/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64: arrayBufferToBase64(bytes), operation, ...details })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? `Page operation failed (${response.status}).`);
    }
    return response.arrayBuffer();
  }

  /** @param {number} degrees */
  async function rotateSelectedPages(degrees) {
    const pages = selectedPageIndexes();
    if (!pages.length || busy) return;
    pageContextMenu = null;
    await replaceWorkingFile('Rotating pages…', requestPageOperation('rotate', { pages, rotation: degrees }));
  }

  async function copySelectedPages() {
    const pages = selectedPageIndexes();
    if (!pages.length || busy) return;
    busy = true;
    try {
      const bytes = await requestPageOperation('extract', { pages });
      pageClipboard = { pdfBase64: arrayBufferToBase64(bytes), count: pages.length };
      pageContextMenu = null;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not copy the pages.';
    } finally {
      busy = false;
    }
  }

  async function pastePages() {
    if (!pageClipboard || busy) return;
    const selected = selectedPageIndexes();
    const insertAt = selected.length ? selected.at(-1) + 1 : pageCount;
    pageContextMenu = null;
    await replaceWorkingFile('Pasting pages…', requestPageOperation('insert', {
      insertAt,
      insertPdfBase64: pageClipboard.pdfBase64
    }), new Set(Array.from({ length: pageClipboard.count }, (_, offset) => insertAt + offset)));
  }

  async function deleteSelectedPages() {
    const removed = new Set(selectedPageIndexes());
    if (!removed.size || removed.size >= pageCount || busy) return;
    const order = Array.from({ length: pageCount }, (_, index) => index).filter((index) => !removed.has(index));
    const nextPage = Math.min(order.length - 1, Math.min(...removed));
    pageContextMenu = null;
    await replaceWorkingFile('Deleting pages…', requestPageOperation('reorder', { order }), new Set([nextPage]));
  }

  /** @param {string} nextStatus @param {Promise<ArrayBuffer>} operation @param {Set<number> | null} [nextSelection] */
  async function replaceWorkingFile(nextStatus, operation, nextSelection = null) {
    if (!workingFile) return;
    busy = true;
    status = nextStatus;
    try {
      const result = await operation;
      workingFile = new File([result], workingFile.name, { type: 'application/pdf', lastModified: Date.now() });
      if (nextSelection) selectedPages = nextSelection;
      await renderPages();
      status = '';
    } catch (failure) {
      console.error(failure);
      status = '';
      error = failure instanceof Error ? failure.message : 'Could not update the pages.';
    } finally {
      busy = false;
    }
  }

  async function exportSelectedPages() {
    const pages = selectedPageIndexes();
    if (!workingFile || !pages.length || busy) return;
    busy = true;
    pageContextMenu = null;
    status = 'Exporting…';
    try {
      const bytes = await requestPageOperation('extract', { pages });
      downloadBytes(bytes, `${baseName()}-pages-${pages.map((page) => page + 1).join('-')}.pdf`);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not export the pages.';
    } finally {
      busy = false;
      status = '';
    }
  }

  async function exportToolResult() {
    if (actionDisabled || !workingFile) return;
    error = '';
    if (tool === 'merge') {
      downloadBytes(await workingFile.arrayBuffer(), `${baseName()}-merged.pdf`);
      return;
    }
    const groups = /** @type {number[][]} */ (splitGroups);
    busy = true;
    status = 'Splitting…';
    try {
      const source = await workingFile.arrayBuffer();
      /** @type {{ name: string; bytes: Uint8Array<ArrayBuffer> }[]} */
      const parts = [];
      for (const pages of groups) {
        const label = pages.length > 1 ? `${pages[0] + 1}-${pages[pages.length - 1] + 1}` : `${pages[0] + 1}`;
        parts.push({ name: `${baseName()}-${label}.pdf`, bytes: new Uint8Array(await requestPageOperation('extract', { pages }, source)) });
      }
      if (parts.length === 1) downloadBytes(parts[0].bytes, parts[0].name);
      else downloadBytes(createZip(parts), `${baseName()}-split.zip`, 'application/zip');
    } catch (failure) {
      console.error(failure);
      error = failure instanceof Error ? failure.message : 'Could not split this PDF.';
    } finally {
      busy = false;
      status = '';
    }
  }

  /** Builds an uncompressed (stored) zip so a split can download as one file. */
  /** @param {{ name: string; bytes: Uint8Array<ArrayBuffer> }[]} entries */
  function createZip(entries) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    /** @param {Uint8Array} bytes */
    const crc32 = (bytes) => {
      let crc = 0xffffffff;
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };
    const encoder = new TextEncoder();
    /** @type {BlobPart[]} */
    const chunks = [];
    /** @type {BlobPart[]} */
    const directory = [];
    let offset = 0;
    let directorySize = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const crc = crc32(entry.bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, entry.bytes.length, true);
      local.setUint32(22, entry.bytes.length, true);
      local.setUint16(26, name.length, true);
      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, entry.bytes.length, true);
      central.setUint32(24, entry.bytes.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      chunks.push(new Uint8Array(local.buffer), name, entry.bytes);
      directory.push(new Uint8Array(central.buffer), name);
      offset += 30 + name.length + entry.bytes.length;
      directorySize += 46 + name.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...directory, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  function baseName() {
    return workingFile?.name.replace(/\.pdf$/i, '') || 'document';
  }

  /** @param {BlobPart} bytes @param {string} name @param {string} [type] */
  function downloadBytes(bytes, name, type = 'application/pdf') {
    const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** @param {ArrayBuffer} buffer */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  /** @param {PointerEvent} event */
  function closeContextMenu(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.page-context-menu')) pageContextMenu = null;
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') {
      if (pageContextMenu) pageContextMenu = null;
      else onClose();
      return;
    }
    if (!pageContextMenu || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = key === 'r' ? () => rotateSelectedPages(90)
      : key === 'l' ? () => rotateSelectedPages(-90)
      : key === 'e' ? exportSelectedPages
      : key === 'c' ? copySelectedPages
      : key === 'v' ? pastePages
      : key === 'd' || event.key === 'Delete' || event.key === 'Backspace' ? deleteSelectedPages
      : null;
    if (!action) return;
    event.preventDefault();
    void action();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', closeContextMenu);
    window.addEventListener('keydown', handleKeydown);
  }

  onDestroy(() => {
    renderGeneration += 1;
    pageDragCleanup?.();
    window.removeEventListener('pointerdown', closeContextMenu);
    window.removeEventListener('keydown', handleKeydown);
    // pdfjs-dist dropped PDFDocumentProxy.destroy(); only the loading task has one.
    void loadingTask?.destroy?.()?.catch(() => {});
  });
</script>

<div class:has-pages={pageCount > 0} class:has-error={Boolean(error)} class="quick-pages-panel" role="dialog" aria-label={title} transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src={`/quicktools/${tool}.svg`} alt="" />
    <h2>{title}</h2>
    <button class="panel-close" type="button" aria-label={`Close ${title}`} onclick={onClose}>
      <span></span><span></span>
    </button>
  </header>

  <div class="upload-section">
    <button
      class:drop-target={externalPdfDropIndex === -1}
      class="upload-file"
      type="button"
      disabled={busy}
      onclick={chooseFiles}
      ondragenter={(event) => showExternalPdfDropTarget(event, -1)}
      ondragover={(event) => showExternalPdfDropTarget(event, -1)}
      ondragleave={(event) => hideExternalPdfDropTarget(event, -1)}
      ondrop={(event) => dropExternalPdf(event, pageCount)}
    >
      {#if tool === 'split' && workingFile}
        <span>{workingFile.name}</span>
      {:else}
        <span class="action-plus" aria-hidden="true"></span><span>{workingFile ? 'Add Files' : tool === 'split' ? 'Upload File' : 'Upload Files'}</span>
      {/if}
    </button>
  </div>

  {#if pageCount > 0}
  <div
    class="panel-pages"
    role="region"
    aria-label={`${title} pages`}
    bind:this={pageList}
    ondragover={autoScrollExternalDrag}
    ondragleave={(event) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) externalPdfDropIndex = null;
    }}
  >
      <div class="thumbnail-list" role="list">
        {#each (pageDragPreviewOrder.length ? pageDragPreviewOrder : Array.from({ length: pageCount }, (_, index) => index)) as index, orderIndex (index)}
          <div
            class:dragging={Boolean(pagePointerDrag?.active && draggedPages.includes(index))}
            class="thumbnail-entry"
            data-page-index={index}
            role="listitem"
            animate:flip={{ duration: busy ? 0 : 220, easing: cubicOut }}
          >
            {#if pagePointerDrag?.active && draggedPages.includes(index)}
              <div
                class="page-drag-placeholder"
                aria-hidden="true"
                style:height={`${pagePointerDrag.height}px`}
              ></div>
            {:else}
              <button
                class:page-selected={selectedPages.has(index)}
                class="quick-thumbnail-page"
                aria-label={`Select page ${index + 1}`}
                aria-pressed={selectedPages.has(index)}
                onclick={(event) => selectPage(index, event)}
                oncontextmenu={(event) => openPageContextMenu(event, index)}
                onpointerdown={(event) => beginPagePointerDrag(event, index)}
              >
                <span class="page-pill">{index + 1}/{pageCount}</span>
                <canvas data-page={index}></canvas>
              </button>
            {/if}
            {#if orderIndex < pageCount - 1 && tool === 'merge'}
              <div
                class:pdf-drop-target={externalPdfDropIndex === orderIndex + 1}
                class="page-separator"
                role="presentation"
                ondragenter={(event) => showExternalPdfDropTarget(event, orderIndex + 1)}
                ondragover={(event) => showExternalPdfDropTarget(event, orderIndex + 1)}
                ondragleave={(event) => hideExternalPdfDropTarget(event, orderIndex + 1)}
                ondrop={(event) => dropExternalPdf(event, orderIndex + 1)}
              ></div>
            {:else if orderIndex < pageCount - 1}
              <div class="page-separator" role="presentation"></div>
            {/if}
          </div>
        {/each}
      </div>
  </div>
  {/if}

  {#if tool === 'split' && pageCount > 0}
    <div class="split-fields">
      <div class:error={!splitGroups} class="text-field">
        <input type="text" placeholder="Ranges, e.g. 1-3, 5" aria-label="Page ranges" bind:value={splitRanges} oninput={() => error = ''} />
      </div>
    </div>
  {/if}

  <footer class="panel-actions">
    <p class:visible={Boolean(error)} class="panel-error" aria-live="polite">{error}</p>
    <button class="panel-action" type="button" disabled={actionDisabled} onclick={exportToolResult}>
      <span>{actionLabel}</span>
    </button>
  </footer>
  <input bind:this={uploadInput} class="file-input" type="file" accept="application/pdf,.pdf" multiple={tool === 'merge'} onchange={handleFiles} />
</div>

{#if pagePointerDrag?.active}
  <div
    class="page-drag-ghost"
    aria-hidden="true"
    style:left="0px"
    style:top="0px"
    style:width={`${pagePointerDrag.width}px`}
    style:height={`${pagePointerDrag.height}px`}
    style:transform-origin={`${pagePointerDrag.offsetX / pagePointerDrag.uiScale}px ${pagePointerDrag.offsetY / pagePointerDrag.uiScale}px`}
    style:transform={`translate3d(${(pagePointerDrag.clientX - pagePointerDrag.offsetX) / pagePointerDrag.uiScale}px, ${(pagePointerDrag.clientY - pagePointerDrag.offsetY) / pagePointerDrag.uiScale}px, 0) scale(1.035)`}
  >
    {#if pagePointerDrag.imageUrl}<img src={pagePointerDrag.imageUrl} alt="" />{/if}
    <span class="page-pill">{pagePointerDrag.pageIndex + 1}/{pageCount}</span>
    {#if draggedPages.length > 1}<span class="page-drag-count">{draggedPages.length} pages</span>{/if}
  </div>
{/if}

{#if pageContextMenu}
  <div
    class="page-context-menu"
    role="menu"
    tabindex="-1"
    aria-label="Page actions"
    style:left={`${pageContextMenu.x}px`}
    style:top={`${pageContextMenu.y}px`}
    in:scale={{ duration: 190, easing: cubicOut, start: 0.92, opacity: 0 }}
    out:scale={{ duration: 145, easing: cubicOut, start: 0.96, opacity: 0 }}
  >
    <button class="page-menu-item rotate-right" role="menuitem" disabled={busy} onclick={() => rotateSelectedPages(90)}><img src="/redesign/icon-rotate-ccw1.svg" alt="" /><span>Rotate Right</span><kbd>R</kbd></button>
    <button class="page-menu-item" role="menuitem" disabled={busy} onclick={() => rotateSelectedPages(-90)}><img src="/redesign/icon-rotate-ccw2.svg" alt="" /><span>Rotate Left</span><kbd>L</kbd></button>
    <button class="page-menu-item export-page" role="menuitem" disabled={busy} onclick={exportSelectedPages}><img src="/redesign/icon-reply1.svg" alt="" /><span>Export</span><kbd>E</kbd></button>
    <button class="page-menu-item" role="menuitem" disabled={busy} onclick={copySelectedPages}><img src="/redesign/icon-copy2.svg" alt="" /><span>Copy</span><kbd>C</kbd></button>
    <button class="page-menu-item" role="menuitem" disabled={!pageClipboard || busy} onclick={pastePages}><img src="/redesign/icon-clipboard-plus.svg" alt="" /><span>Paste</span><kbd>V</kbd></button>
    <button class="page-menu-item delete-page" role="menuitem" disabled={selectedPages.size >= pageCount || busy} onclick={deleteSelectedPages}><img src="/redesign/icon-trash1.svg" alt="" /><span>Delete</span><kbd>D</kbd></button>
  </div>
{/if}

<style>
  /* Matches the redesign panels (TranslateFilesPanel, SettingsPanel, PdfEditor .protect-panel). */
  .quick-pages-panel { position: absolute; z-index: 40; top: 12px; left: 13px; display: flex; flex-direction: column; box-sizing: border-box; width: min(320px, calc(100% - 26px)); max-height: calc(100% - 24px); overflow: hidden; border: 1.5px solid #c3c2c2; border-radius: 21px; background: rgba(240, 236, 236, 0.75); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); backdrop-filter: blur(1.3px); -webkit-backdrop-filter: blur(1.3px); color: #000; font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 19px; letter-spacing: -0.19px; -webkit-font-smoothing: antialiased; }
  .quick-pages-panel.has-pages { height: min(720px, calc(100% - 24px)); }
  .panel-header { display: grid; flex: 0 0 auto; grid-template-columns: 24px 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 14px 0 15px; border-bottom: 1.5px solid #c3c2c2; border-radius: 19.5px 19.5px 0 0; background: rgba(214, 214, 214, 0.75); }
  .upload-section, .split-fields { display: grid; flex: 0 0 auto; align-content: center; padding: 15px 11px 15px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .split-fields { border-top: 1px solid rgba(0, 0, 0, 0.1); }
  .upload-file { display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; letter-spacing: inherit; cursor: pointer; transition: border-color 150ms ease, color 150ms ease, transform 160ms ease; }
  .upload-file:hover:not(:disabled), .upload-file.drop-target { border-color: rgba(0, 0, 0, 0.18); color: rgba(0, 0, 0, 0.75); }
  .upload-file.drop-target { border-color: #0073ff; }
  .upload-file:active:not(:disabled) { transform: scale(0.985); }
  .upload-file:disabled { cursor: default; }
  .upload-file span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .text-field { box-sizing: border-box; height: 48px; overflow: hidden; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; transition: border-color 150ms ease; }
  .text-field:focus-within { border-color: rgba(0, 0, 0, 0.18); }
  .text-field.error { border-color: rgba(222, 53, 66, 0.6); }
  .text-field input { box-sizing: border-box; width: 100%; height: 100%; padding: 0 13px; border: 0; outline: 0; background: transparent; color: rgba(0, 0, 0, 0.75); font: inherit; letter-spacing: inherit; }
  .text-field input::placeholder { color: rgba(0, 0, 0, 0.5); opacity: 1; }
  .panel-header > img { width: 24px; height: 24px; object-fit: contain; }
  .panel-header h2 { margin: 0 0 0 8px; overflow: hidden; font-size: 20px; font-weight: 400; line-height: 1.22; letter-spacing: -0.2px; text-overflow: ellipsis; white-space: nowrap; }
  .panel-close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; cursor: pointer; transition: transform 160ms ease, filter 160ms ease; }
  .panel-close:hover { filter: brightness(0); }
  .panel-close:active { transform: scale(0.94); }
  .panel-close span { display: none; }
  .panel-pages { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; background: #efefef; scrollbar-width: none; }
  .panel-pages::-webkit-scrollbar { display: none; }
  .thumbnail-list { display: flex; flex-direction: column; align-items: center; padding: 34px 32px 70px; }
  .thumbnail-entry { position: relative; width: 244px; transition: opacity 120ms ease, visibility 120ms ease; }
  .thumbnail-entry.dragging { pointer-events: none; }
  .page-drag-placeholder { display: block; width: 244px; min-height: 120px; border-radius: 10px; background: transparent; }
  :global(html.page-dragging), :global(html.page-dragging *) { cursor: grabbing !important; user-select: none !important; }
  .quick-thumbnail-page { position: relative; display: block; box-sizing: content-box; width: 244px; min-height: 120px; padding: 0; overflow: visible; border: 1px solid #dadada; border-radius: 8px; background: #fff; box-shadow: 3px 8px 16px rgba(0, 0, 0, 0.05); cursor: grab; transition: border-color 170ms ease, box-shadow 170ms ease; }
  .quick-thumbnail-page:hover { border-color: #c8c8c8; box-shadow: 3px 9px 19px rgba(0, 0, 0, 0.075); }
  .quick-thumbnail-page.page-selected, .quick-thumbnail-page.page-selected:hover { border-color: #bbb; box-shadow: 4px 4px 3px rgba(43, 43, 43, 0.1); }
  .quick-thumbnail-page.page-selected .page-pill { border-color: rgba(0, 0, 0, 0.17); }
  .quick-thumbnail-page:active { cursor: grabbing; }
  .quick-thumbnail-page canvas { display: block; width: 244px; height: auto; border-radius: 7px; }
  .page-pill { position: absolute; z-index: 4; top: -16px; left: 50%; display: grid; place-items: center; box-sizing: border-box; min-width: 51px; height: 29px; padding: 0 8px; border: 1px solid rgba(0, 0, 0, 0.07); border-radius: 41px; background: rgba(255, 255, 255, 0.5); box-shadow: 0 0 40.5px rgba(255, 255, 255, 0.59); color: rgba(0, 0, 0, 0.5); font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 20px; line-height: 1; letter-spacing: -0.2px; white-space: nowrap; transform: translateX(-50%); backdrop-filter: blur(1.8px); -webkit-backdrop-filter: blur(1.8px); }
  .page-separator { position: relative; width: 100%; height: 48px; margin: 0; }
  .page-separator::before { position: absolute; top: 21px; right: 7px; left: 6px; height: 1px; border-radius: 1px; background: rgba(129, 129, 129, 0.26); content: ''; transition: height 140ms ease, background 140ms ease; }
  .page-separator::after { position: absolute; top: 21.5px; left: 50%; box-sizing: border-box; width: 26px; height: 26px; border: 1px solid #0073ff; border-radius: 30px; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12h14M12 5v14' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") center / 24px 24px no-repeat, radial-gradient(circle 13px at center, #0053b9 0%, #0976fa 100%); content: ''; opacity: 0; pointer-events: none; transform: translate(-50%, -50%) scale(0.72); transition: opacity 140ms ease, transform 170ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .page-separator.pdf-drop-target::before { top: 20.5px; height: 2px; background: linear-gradient(90deg, #0073ff 0, #0073ff calc(50% - 13px), transparent calc(50% - 13px), transparent calc(50% + 12px), #0073ff calc(50% + 12px)); }
  .page-separator.pdf-drop-target::after { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  .page-drag-ghost { position: fixed; z-index: 80; box-sizing: border-box; overflow: visible; border-radius: 8px; background: #fff; box-shadow: 0 0 0 1px #bbb, 0 24px 48px rgba(0, 0, 0, 0.25), 0 7px 16px rgba(0, 0, 0, 0.14); pointer-events: none; will-change: transform; }
  .page-drag-ghost > img { display: block; width: 100%; height: 100%; border-radius: 7px; }
  .page-drag-count { position: absolute; right: 9px; bottom: 9px; padding: 5px 8px; border-radius: 999px; background: rgba(23,23,23,.86); color: #fff; font-family: Geist, Inter, sans-serif; font-size: 12px; line-height: 1; }
  .action-plus { position: relative; flex: 0 0 auto; display: block; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%, -50%); }
  .action-plus::after { transform: translate(-50%, -50%) rotate(90deg); }
  .panel-actions { display: grid; flex: 0 0 auto; padding: 15px 11px 15px 12px; }
  .has-pages .panel-actions { border-top: 1px solid rgba(0, 0, 0, 0.1); }
  .split-fields + .panel-actions { border-top: 0; }
  .panel-error { max-height: 0; margin: 0; overflow: hidden; color: #de3542; font-size: 17px; line-height: 1.1; opacity: 0; transition: max-height 240ms ease, margin-bottom 240ms ease, opacity 170ms ease; }
  .panel-error.visible { max-height: 40px; margin-bottom: 10px; opacity: 1; }
  .panel-action { display: flex; align-items: center; justify-content: center; gap: 10px; box-sizing: border-box; width: 100%; height: 48px; padding: 0 17px; border: 1px solid #111; border-radius: 15px; background: #111; color: #fff; font: inherit; letter-spacing: inherit; cursor: pointer; transition: opacity 150ms ease, background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 160ms ease; }
  .panel-action:active:not(:disabled) { transform: scale(0.97); }
  .panel-action:disabled { border-color: #b4b4b4; background: #b4b4b4; cursor: default; }
  .file-input { display: none; }
  .page-context-menu { position: fixed; z-index: 70; box-sizing: border-box; width: 206px; padding: 4px 5px; border: 1px solid rgba(0, 0, 0, 0.15); border-radius: 15px; background: rgba(255, 255, 255, 0.75); box-shadow: 0 0 100px rgba(0, 0, 0, 0.08); backdrop-filter: blur(4.05px); -webkit-backdrop-filter: blur(4.05px); transform-origin: top left; }
  .page-menu-item { display: grid; grid-template-columns: 28px 1fr 26px; align-items: center; box-sizing: border-box; width: 100%; height: 39px; padding: 0 5px 0 6px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: rgba(0, 0, 0, 0.75); font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 20px; letter-spacing: -0.2px; text-align: left; cursor: pointer; transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease; }
  .page-menu-item:hover:not(:disabled), .page-menu-item:focus-visible { border-color: rgba(0, 0, 0, 0.08); background: rgba(107, 107, 107, 0.05); color: #000; outline: none; }
  .page-menu-item:hover:not(:disabled):not(.delete-page) img, .page-menu-item:focus-visible:not(:disabled):not(.delete-page) img { filter: brightness(0); }
  .page-menu-item img { display: block; width: 20px; height: 20px; object-fit: contain; transition: filter 180ms ease, opacity 180ms ease; }
  .page-menu-item.rotate-right img { transform: scaleX(-1); }
  .page-menu-item.export-page img { width: 24px; height: 24px; margin-left: -2px; transform: scaleX(-1); }
  .page-menu-item:nth-child(4) img { width: 19px; }
  .page-menu-item:nth-child(5) img { width: 22px; height: 22px; margin-left: -1px; }
  .page-menu-item kbd { display: grid; place-items: center; box-sizing: border-box; width: 26px; height: 27px; border: 1px solid rgba(0, 0, 0, 0.015); border-radius: 6px; background: rgba(0, 0, 0, 0.025); color: rgba(0, 0, 0, 0.165); font: inherit; font-size: 20px; letter-spacing: 0; transition: background-color 180ms ease, border-color 180ms ease; }
  .page-menu-item:hover:not(:disabled) kbd, .page-menu-item:focus-visible:not(:disabled) kbd { border-color: rgba(0, 0, 0, 0.02); background: rgba(0, 0, 0, 0.055); }
  .page-menu-item:disabled { color: rgba(0, 0, 0, 0.3); cursor: default; }
  .page-menu-item:disabled img { opacity: 0.55; }
  .page-menu-item.delete-page:not(:disabled) { color: rgba(255, 0, 0, 0.85); }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .quick-pages-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .upload-section,
  :global(:root[data-theme="dark"]) .split-fields { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .split-fields { border-top: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .upload-file { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .upload-file:hover:not(:disabled),
  :global(:root[data-theme="dark"]) .upload-file.drop-target { border-color: rgba(255, 255, 255, 0.144); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .text-field { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .text-field:focus-within { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .text-field input { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .text-field input::placeholder { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-close { filter: brightness(0) invert(1) opacity(0.78); }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .panel-pages { background: #111111; }
  :global(:root[data-theme="dark"]) .quick-thumbnail-page { border: 1px solid #212121; background: rgba(22, 22, 22, 0.96); box-shadow: 3px 8px 16px rgba(0, 0, 0, 0.15); }
  :global(:root[data-theme="dark"]) .quick-thumbnail-page:hover { border-color: #2a2a2a; box-shadow: 3px 9px 19px rgba(0, 0, 0, 0.225); }
  :global(:root[data-theme="dark"]) .quick-thumbnail-page.page-selected,
  :global(:root[data-theme="dark"]) .quick-thumbnail-page.page-selected:hover { border-color: #2f2f2f; box-shadow: 4px 4px 3px rgba(43, 43, 43, 0.3); }
  :global(:root[data-theme="dark"]) .quick-thumbnail-page.page-selected .page-pill { border-color: rgba(255, 255, 255, 0.136); }
  :global(:root[data-theme="dark"]) .page-pill { border: 1px solid rgba(255, 255, 255, 0.056); background: rgba(24, 24, 24, 0.95); box-shadow: 0 0 40.5px rgba(0, 0, 0, 0.354); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .page-separator::before { background: rgba(255, 255, 255, 0.12); }
  :global(:root[data-theme="dark"]) .page-drag-ghost { background: rgba(22, 22, 22, 0.96); box-shadow: 0 0 0 1px rgba(187, 187, 187, 0.6), 0 24px 48px rgba(0, 0, 0, 0.6), 0 7px 16px rgba(0, 0, 0, 0.42); }
  :global(:root[data-theme="dark"]) .page-drag-count { background: rgba(255, 255, 255, 0.2); color: #111111; }
  :global(:root[data-theme="dark"]) .has-pages .panel-actions { border-top: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-action { border: 1px solid #ececec; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .panel-action:disabled { border-color: #333333; color: rgba(255, 255, 255, 0.5); background: rgba(255, 255, 255, 0.105); }
  :global(:root[data-theme="dark"]) .page-context-menu { border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(24, 24, 24, 0.95); box-shadow: 0 0 100px rgba(0, 0, 0, 0.24); }
  :global(:root[data-theme="dark"]) .page-menu-item { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .page-menu-item:hover:not(:disabled),
  :global(:root[data-theme="dark"]) .page-menu-item:focus-visible { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .page-menu-item:hover:not(:disabled):not(.delete-page) img,
  :global(:root[data-theme="dark"]) .page-menu-item:focus-visible:not(:disabled):not(.delete-page) img { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .page-menu-item kbd { border: 1px solid rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.033); color: rgba(255, 255, 255, 0.165); }
  :global(:root[data-theme="dark"]) .page-menu-item:hover:not(:disabled) kbd,
  :global(:root[data-theme="dark"]) .page-menu-item:focus-visible:not(:disabled) kbd { border-color: rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.072); }
  :global(:root[data-theme="dark"]) .page-menu-item:disabled { color: rgba(255, 255, 255, 0.3); }
  /* dark theme: end generated */

  /* dark theme: manual */
  /* Page pills: black glass with a light edge, as in the Figma dark frame. */
  :global(:root[data-theme="dark"]) .page-pill { border-color: rgba(255, 255, 255, 0.17); background: rgba(0, 0, 0, 0.7); box-shadow: 0 0 40.5px rgba(0, 0, 0, 0.59); color: rgba(255, 255, 255, 0.5); backdrop-filter: blur(6.25px); -webkit-backdrop-filter: blur(6.25px); }
  :global(:root[data-theme="dark"]) .quick-thumbnail-page.page-selected .page-pill { border-color: rgba(255, 255, 255, 0.3); color: rgba(255, 255, 255, 0.75); }

</style>
