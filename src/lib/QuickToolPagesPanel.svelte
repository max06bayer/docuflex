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

  /** @param {File[]} files */
  /** @param {File[]} files @param {number} [requestedInsertAt] */
  async function appendFiles(files, requestedInsertAt = pageCount) {
    if (busy) return;
    busy = true;
    status = files.length > 1 ? 'Adding PDFs…' : 'Adding PDF…';
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
          await renderPages();
          insertAt += pageCount - previousCount;
          continue;
        }
        await renderPages();
        insertAt = pageCount;
      }
      if (!selectedPages.size && pageCount) {
        selectedPages = new Set([0]);
        selectionAnchor = 0;
      }
      status = '';
    } catch (error) {
      console.error(error);
      status = '';
      window.alert(error instanceof Error ? error.message : 'Could not add the PDF.');
    } finally {
      busy = false;
    }
  }

  async function renderPages() {
    if (!workingFile) return;
    const generation = ++renderGeneration;
    await renderedDocument?.destroy().catch(() => {});
    renderedDocument = null;
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.mjs?url')
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    loadingTask = pdfjs.getDocument({ data: await workingFile.arrayBuffer() });
    const document = await loadingTask.promise;
    if (generation !== renderGeneration) {
      await document.destroy();
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
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not copy the pages.');
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
    } catch (error) {
      console.error(error);
      status = '';
      window.alert(error instanceof Error ? error.message : 'Could not update the pages.');
    } finally {
      busy = false;
    }
  }

  async function exportSelectedPages() {
    const pages = selectedPageIndexes();
    if (!workingFile || !pages.length || busy) return;
    busy = true;
    pageContextMenu = null;
    status = 'Exporting pages…';
    try {
      const bytes = await requestPageOperation('extract', { pages });
      downloadBytes(bytes, `${baseName()}-pages-${pages.map((page) => page + 1).join('-')}.pdf`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not export the pages.');
    } finally {
      busy = false;
      status = '';
    }
  }

  async function exportToolResult() {
    if (!workingFile || busy) return;
    if (tool === 'split' && selectedPages.size > 0 && selectedPages.size < pageCount) {
      await exportSelectedPages();
      return;
    }
    downloadBytes(await workingFile.arrayBuffer(), `${baseName()}-${tool === 'split' ? 'split' : 'merged'}.pdf`);
  }

  function baseName() {
    return workingFile?.name.replace(/\.pdf$/i, '') || 'document';
  }

  /** @param {ArrayBuffer} bytes @param {string} name */
  function downloadBytes(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
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
    void renderedDocument?.destroy().catch(() => {});
    if (!renderedDocument) void loadingTask?.destroy().catch(() => {});
  });
</script>

<div class="quick-pages-panel" role="dialog" aria-label={title} transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src={`/quicktools/${tool}.svg`} alt="" />
    <h2>{title}</h2>
    <button class="panel-close" type="button" aria-label={`Close ${title}`} onclick={onClose}>
      <span></span><span></span>
    </button>
  </header>

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
    {#if pageCount > 0}
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
            {#if orderIndex < pageCount - 1}
              <div
                class:pdf-drop-target={externalPdfDropIndex === orderIndex + 1}
                class="page-separator"
                role="presentation"
                ondragenter={(event) => showExternalPdfDropTarget(event, orderIndex + 1)}
                ondragover={(event) => showExternalPdfDropTarget(event, orderIndex + 1)}
                ondragleave={(event) => hideExternalPdfDropTarget(event, orderIndex + 1)}
                ondrop={(event) => dropExternalPdf(event, orderIndex + 1)}
              ></div>
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <button class="empty-pages" type="button" aria-label="Upload PDFs to add pages" onclick={chooseFiles}>
        <img src="/bigplus.svg" alt="" />
      </button>
    {/if}
    {#if status}<div class="panel-status" aria-live="polite">{status}</div>{/if}
  </div>

  <footer class="panel-actions">
    <button class="panel-action upload" type="button" disabled={busy} onclick={chooseFiles}>
      <span class="action-plus"></span><span>Upload</span>
    </button>
    <button class="panel-action export" type="button" disabled={!workingFile || busy} onclick={exportToolResult}>
      <img src="/pages/reply.svg" alt="" /><span>Export</span>
    </button>
  </footer>
  <input bind:this={uploadInput} class="file-input" type="file" accept="application/pdf,.pdf" multiple onchange={handleFiles} />
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
    <button class="page-menu-item rotate-right" role="menuitem" disabled={busy} onclick={() => rotateSelectedPages(90)}><img src="/pages/rotate-ccw.svg" alt="" /><span>Rotate Right</span><kbd>R</kbd></button>
    <button class="page-menu-item" role="menuitem" disabled={busy} onclick={() => rotateSelectedPages(-90)}><img src="/pages/rotate-ccw.svg" alt="" /><span>Rotate Left</span><kbd>L</kbd></button>
    <button class="page-menu-item export-page" role="menuitem" disabled={busy} onclick={exportSelectedPages}><img src="/pages/reply.svg" alt="" /><span>Export</span><kbd>E</kbd></button>
    <button class="page-menu-item" role="menuitem" disabled={busy} onclick={copySelectedPages}><img src="/pages/copy.svg" alt="" /><span>Copy</span><kbd>C</kbd></button>
    <button class="page-menu-item" role="menuitem" disabled={!pageClipboard || busy} onclick={pastePages}><img src="/pages/clipboard-plus.svg" alt="" /><span>Paste</span><kbd>V</kbd></button>
    <button class="page-menu-item delete-page" role="menuitem" disabled={selectedPages.size >= pageCount || busy} onclick={deleteSelectedPages}><img src="/pages/trash.svg" alt="" /><span>Delete</span><kbd>D</kbd></button>
  </div>
{/if}

<style>
  .quick-pages-panel { position: absolute; z-index: 40; top: 20px; left: 14px; display: grid; grid-template-rows: 50px minmax(0, 1fr) 132px; width: min(320px, calc(100% - 28px)); height: min(720px, calc(100% - 40px)); overflow: hidden; border: 1.5px solid #c5c5c5; border-radius: 13px; background: #fafafa; box-shadow: 0 9px 24px rgba(0,0,0,.07); color: #000; font-family: "Inter Variable", Inter, sans-serif; font-size: 16px; }
  .panel-header { display: grid; grid-template-columns: 26px 1fr 28px; align-items: center; height: 50px; padding: 0 12px; border-bottom: 1px solid #cacaca; background: #eee; }
  .panel-header > img { width: 24px; height: 24px; object-fit: contain; }
  .panel-header h2 { margin: 0 0 1px 7px; overflow: hidden; font-size: 18px; font-weight: 400; line-height: 1; letter-spacing: -.25px; text-overflow: ellipsis; white-space: nowrap; }
  .panel-close { position: relative; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: transform 160ms ease; }
  .panel-close:active { transform: scale(.94); }
  .panel-close span { position: absolute; top: 13px; left: 6px; width: 16px; height: 1.5px; border-radius: 99px; background: #929292; transform: rotate(45deg); transition: background-color 160ms ease; }
  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }
  .panel-pages { position: relative; min-height: 0; overflow-y: auto; background: #f1f1f1; box-shadow: inset -11px 0 25px rgba(0,0,0,.03); scrollbar-width: none; }
  .panel-pages::-webkit-scrollbar { display: none; }
  .thumbnail-list { display: flex; flex-direction: column; align-items: center; padding: 30px 32px 70px; }
  .thumbnail-entry { position: relative; width: 244px; transition: opacity 120ms ease, visibility 120ms ease; }
  .thumbnail-entry.dragging { pointer-events: none; }
  .page-drag-placeholder { display: block; width: 244px; min-height: 120px; border-radius: 10px; background: transparent; }
  :global(html.page-dragging), :global(html.page-dragging *) { cursor: grabbing !important; user-select: none !important; }
  .quick-thumbnail-page { position: relative; display: block; box-sizing: content-box; width: 244px; min-height: 120px; padding: 0; overflow: visible; border: 1px solid #dadada; border-radius: 10px; background: #fff; box-shadow: 3px 8px 16px rgba(0,0,0,.05); cursor: grab; transition: border-color 170ms ease, box-shadow 170ms ease; }
  .quick-thumbnail-page:hover { border-color: #c8c8c8; box-shadow: 3px 9px 19px rgba(0,0,0,.075); }
  .quick-thumbnail-page.page-selected { border: 2px solid transparent; box-shadow: 2px 6px 15px rgba(82,157,255,.16); }
  .quick-thumbnail-page.page-selected::after { position: absolute; z-index: 3; inset: -2px; box-sizing: border-box; border: 2px solid #529dff; border-radius: 10px; content: ''; pointer-events: none; }
  .quick-thumbnail-page:active { cursor: grabbing; }
  .quick-thumbnail-page canvas { display: block; width: 244px; height: auto; border-radius: 9px; }
  .page-pill { position: absolute; z-index: 4; top: -17px; left: 50%; display: grid; place-items: center; min-width: 54px; height: 32px; padding: 0 10px; border: 1px solid #d5d5d5; border-radius: 999px; background: #e8e8e8; color: #747474; font-family: Geist, Inter, sans-serif; font-size: 18px; line-height: 1; transform: translateX(-50%); }
  .page-separator { position: relative; width: 100%; height: 46.2px; margin: 0; }
  .page-separator::before { position: absolute; top: 20px; right: 0; left: 0; height: 1.2px; background: #d5d5d5; content: ''; transition: height 140ms ease, background-color 140ms ease, box-shadow 140ms ease; }
  .page-separator::after { position: absolute; top: 20.6px; left: 50%; box-sizing: border-box; width: 24px; height: 24px; border-radius: 999px; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 11h14M12 4v14' fill='none' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / 24px 24px no-repeat, #1684f8; box-shadow: 0 2px 7px rgba(22,132,248,.28); content: ''; opacity: 0; pointer-events: none; transform: translate(-50%,-50%) scale(.72); transition: opacity 140ms ease, transform 170ms cubic-bezier(.2,.8,.2,1); }
  .page-separator.pdf-drop-target::before { height: 2px; background: #1684f8; box-shadow: 0 0 0 .5px rgba(22,132,248,.12); }
  .page-separator.pdf-drop-target::after { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  .page-drag-ghost { position: fixed; z-index: 80; box-sizing: border-box; overflow: visible; border-radius: 10px; background: #fff; box-shadow: 0 0 0 2px #529dff, 0 24px 48px rgba(0,0,0,.25), 0 7px 16px rgba(0,0,0,.14); pointer-events: none; will-change: transform; }
  .page-drag-ghost > img { display: block; width: 100%; height: 100%; border-radius: 8px; }
  .page-drag-count { position: absolute; right: 9px; bottom: 9px; padding: 5px 8px; border-radius: 999px; background: rgba(23,23,23,.86); color: #fff; font-family: Geist, Inter, sans-serif; font-size: 12px; line-height: 1; }
  .empty-pages { display: grid; place-items: center; width: 100%; height: 100%; min-height: 220px; padding: 20px; border: 0; background: transparent; cursor: pointer; }
  .empty-pages img { display: block; width: 40px; height: 40px; opacity: .5; transition: filter 160ms ease, opacity 160ms ease, transform 180ms ease; }
  .empty-pages:hover img { filter: brightness(.78); opacity: .72; transform: scale(1.04); }
  .empty-pages:active img { transform: scale(.96); }
  .action-plus { position: relative; display: block; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%, -50%); }
  .action-plus::after { transform: translate(-50%, -50%) rotate(90deg); }
  .panel-status { position: sticky; right: 12px; bottom: 10px; left: 12px; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,.9); color: #666; font-size: 14px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .panel-actions { display: grid; grid-template-rows: repeat(2, 44px); align-content: center; gap: 10px; padding: 17px 18px; border-top: 1px solid #cacaca; background: #fafafa; }
  .panel-action { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; height: 44px; padding: 0 12px; border: 0; border-radius: 8px; color: #fff; font: inherit; font-size: 18px; font-weight: 400; line-height: 1; letter-spacing: -.3px; cursor: pointer; transition: background-color 220ms ease, box-shadow 220ms ease, transform 160ms ease; }
  .panel-action:active { transform: scale(.985); }
  .panel-action.upload { background: #111; box-shadow: 0 5px 16px rgba(0,0,0,.13); }
  .panel-action.upload:hover { background: #000; box-shadow: 0 6px 18px rgba(0,0,0,.2); }
  .panel-action.export { background: #0878f9; box-shadow: 0 5px 16px rgba(8,120,249,.18); }
  .panel-action.export:hover { background: #006ff0; box-shadow: 0 6px 18px rgba(8,120,249,.27); }
  .panel-action img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .panel-action:disabled { cursor: default; opacity: .5; }
  .file-input { display: none; }
  .page-context-menu { position: fixed; z-index: 70; box-sizing: border-box; width: 204px; padding: 5px; border: 1px solid rgba(0,0,0,.18); border-radius: 15px; background: rgba(255,255,255,.78); box-shadow: 0 7px 18px rgba(0,0,0,.11), 0 2px 5px rgba(0,0,0,.05); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); transform-origin: top left; }
  .page-menu-item { display: grid; grid-template-columns: 28px 1fr 28px; align-items: center; width: 100%; height: 40px; padding: 0 7px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: #3f3f3f; font-family: Geist, Inter, sans-serif; font-size: 18px; text-align: left; cursor: pointer; transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease, transform 180ms ease; }
  .page-menu-item:hover:not(:disabled), .page-menu-item:focus-visible { border-color: rgba(0,0,0,.07); background: rgba(234,234,234,.62); color: #111; outline: none; transform: translateX(1px); }
  .page-menu-item img { display: block; width: 20px; height: 20px; object-fit: contain; transform: translateX(-2px); }
  .page-menu-item.rotate-right img { transform: translateX(-2px) scaleX(-1); }
  .page-menu-item.export-page img { width: 24px; height: 24px; }
  .page-menu-item kbd { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid rgba(0,0,0,.04); border-radius: 7px; background: rgba(0,0,0,.045); color: rgba(0,0,0,.22); font: inherit; font-size: 17px; }
  .page-menu-item:disabled { color: rgba(63,63,63,.34); cursor: default; }
  .page-menu-item:disabled img { opacity: .32; }
  .page-menu-item.delete-page:not(:disabled) { color: #ff2f38; }
</style>
