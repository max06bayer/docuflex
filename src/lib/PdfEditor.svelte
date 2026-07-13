<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import EditorToolbar from '$lib/EditorToolbar.svelte';

  /** @type {File} */
  export let file;

  /** @type {HTMLDivElement | undefined} */
  let viewer;
  /** @type {import('pdfjs-dist').PDFDocumentProxy | null} */
  let pdfDocument = null;
  let pageCount = 0;
  /** @type {Set<number>} */
  let selectedPages = new Set();
  /** @type {number | null} */
  let selectionAnchor = null;
  let status = 'Rendering PDF…';
  let loadGeneration = 0;
  /** @type {import('pdfjs-dist/web/pdf_viewer.mjs').TextLayerBuilder[]} */
  let textLayerBuilders = [];
  /** @type {AbortController | null} */
  let textLayerAbortController = null;
  let activeTool = 'select';
  let zoomLevel = 1;
  let zoomingOut = false;
  let isPanning = false;
  /** @type {{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null} */
  let panStart = null;
  let pdfReady = false;
  let sharpRenderGeneration = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let sharpRenderTimer;
  /** @type {Set<import('pdfjs-dist').RenderTask>} */
  let sharpRenderTasks = new Set();

  const BASE_PAGE_SCALE = 1.35;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const CLICK_ZOOM_FACTOR = 1.25;
  const MAX_CANVAS_PIXELS = 24_000_000;

  onMount(() => {
    loadPdf();
    /** @type {{ x: number; y: number } | null} */
    let pointerStart = null;
    /** @type {{ node: Text; start: number; end: number } | null} */
    let wordDrag = null;
    /** @type {-1 | 0 | 1} */
    let wordDragDirection = 0;
    /** @type {ReturnType<typeof lineBoundsForCaret>} */
    let wordDragLineBounds = null;
    /** @type {{ node: Text; offset: number } | null} */
    let productionCharacterDrag = null;
    /** @type {-1 | 0 | 1} */
    let productionDragDirection = 0;
    /** @type {ReturnType<typeof lineBoundsForCaret>} */
    let productionLineBounds = null;

    /** @param {MouseEvent} event */
    function beginProductionCharacterDrag(event) {
      if (!import.meta.env.PROD || activeTool !== 'select' || event.button !== 0 || event.detail !== 1) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.textLayer span')) {
        // A drag beginning on the canvas has no legitimate text anchor.
        // Prevent browsers from anchoring it at the start of the PDF.
        if (target instanceof Element && target.closest('.pdf-page')) event.preventDefault();
        productionCharacterDrag = null;
        productionDragDirection = 0;
        productionLineBounds = null;
        return;
      }

      const caret = caretFromPoint(event.clientX, event.clientY);
      if (!caret) return;
      event.preventDefault();
      productionCharacterDrag = caret;
      productionDragDirection = 0;
      productionLineBounds = lineBoundsForCaret(caret.node, target);
      const selection = window.getSelection();
      selection?.setBaseAndExtent(caret.node, caret.offset, caret.node, caret.offset);
    }

    /** @param {Element} element @param {boolean} fromEnd */
    function edgeTextNode(element, fromEnd) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      if (!(node instanceof Text)) return null;
      if (!fromEnd) return node;
      let last = node;
      while ((node = walker.nextNode())) {
        if (node instanceof Text) last = node;
      }
      return last;
    }

    /** @param {Text} caretNode @param {Element} hit */
    function lineBoundsForCaret(caretNode, hit) {
      const textLayer = hit.closest('.textLayer') ?? caretNode.parentElement?.closest('.textLayer');
      if (!textLayer) return null;
      const visibleSpans = [...textLayer.querySelectorAll('span:not(.markedContent)')].filter((span) => {
        const rect = span.getBoundingClientRect();
        return Boolean(span.textContent) && rect.width > 0 && rect.height > 0;
      });
      const hitSpan = hit.closest('span:not(.markedContent)');
      const caretSpan =
        (hitSpan && visibleSpans.includes(hitSpan) ? hitSpan : null) ??
        visibleSpans.find((span) => span.contains(caretNode));
      if (!caretSpan) return null;
      const caretRect = caretSpan.getBoundingClientRect();
      const centerY = caretRect.top + caretRect.height / 2;
      const tolerance = Math.max(2, caretRect.height * 0.55);
      const lineSpans = visibleSpans
        .filter((span) => {
          const rect = span.getBoundingClientRect();
          return Math.abs(rect.top + rect.height / 2 - centerY) <= tolerance;
        })
        .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
      const firstSpan = lineSpans[0] ?? caretSpan;
      const lastSpan = lineSpans.at(-1) ?? caretSpan;
      const startNode = edgeTextNode(firstSpan, false) ?? caretNode;
      const endNode = edgeTextNode(lastSpan, true) ?? caretNode;
      const lineTop = Math.min(...lineSpans.map((span) => span.getBoundingClientRect().top));
      const lineBottom = Math.max(...lineSpans.map((span) => span.getBoundingClientRect().bottom));
      return {
        startNode,
        startOffset: 0,
        endNode,
        endOffset: endNode.data.length,
        centerY,
        snapTop: Math.max(lineTop, centerY - caretRect.height * 0.35),
        snapBottom: Math.min(lineBottom, centerY + caretRect.height * 0.35),
        tolerance
      };
    }

    /** @param {{ node: Text; offset: number }} anchor @param {{ node: Text; offset: number }} caret */
    function caretDirection(anchor, caret) {
      if (caret.node === anchor.node) {
        return /** @type {-1 | 0 | 1} */ (Math.sign(caret.offset - anchor.offset));
      }
      return caret.node.compareDocumentPosition(anchor.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    }

    /**
     * @param {NonNullable<typeof wordDrag>} anchor
     * @param {{ node: Text; offset: number }} caret
     */
    function wordCaretDirection(anchor, caret) {
      if (caret.node !== anchor.node) {
        return caret.node.compareDocumentPosition(anchor.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      }
      if (caret.offset < anchor.start) return -1;
      if (caret.offset > anchor.end) return 1;
      return 0;
    }

    /**
     * @param {NonNullable<ReturnType<typeof lineBoundsForCaret>>} bounds
     * @param {number} pointerY
     * @param {-1 | 0 | 1} direction
     */
    function verticalLineBoundary(bounds, pointerY, direction) {
      if (pointerY >= bounds.snapTop && pointerY <= bounds.snapBottom) return null;
      const towardStart = direction < 0 || (direction === 0 && pointerY < bounds.centerY);
      if (towardStart) return { node: bounds.startNode, offset: bounds.startOffset };
      if (pointerY > bounds.snapBottom || direction > 0) {
        return { node: bounds.endNode, offset: bounds.endOffset };
      }
      return null;
    }

    /** @param {MouseEvent} event */
    function extendProductionCharacterDrag(event) {
      if (!import.meta.env.PROD || !productionCharacterDrag || wordDrag || (event.buttons & 1) === 0) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const hitSpan = hit instanceof Element ? hit.closest('.textLayer span:not(.markedContent)') : null;
      const hitRect = hitSpan?.getBoundingClientRect();
      const hitCenterY = hitRect ? hitRect.top + hitRect.height / 2 : null;
      const hitIsDifferentLine =
        hitCenterY !== null &&
        productionLineBounds !== null &&
        Math.abs(hitCenterY - productionLineBounds.centerY) > productionLineBounds.tolerance;
      const verticalBoundary = productionLineBounds
        ? verticalLineBoundary(productionLineBounds, event.clientY, productionDragDirection)
        : null;

      let caret = null;
      if (hitSpan && (!verticalBoundary || hitIsDifferentLine)) {
        caret = caretFromPoint(event.clientX, event.clientY);
        if (caret) {
          productionLineBounds = lineBoundsForCaret(caret.node, hitSpan);
          const direction = caretDirection(productionCharacterDrag, caret);
          if (direction) productionDragDirection = direction;
        }
      } else if (verticalBoundary) {
        caret = verticalBoundary;
      }
      if (!caret) return;

      const selection = window.getSelection();
      const anchor = productionCharacterDrag;
      if (anchor.node.isConnected && caret.node.isConnected) {
        selection?.setBaseAndExtent(anchor.node, anchor.offset, caret.node, caret.offset);
      }
    }

    function finishProductionCharacterDrag() {
      if (import.meta.env.PROD) {
        productionCharacterDrag = null;
        productionDragDirection = 0;
        productionLineBounds = null;
      }
    }

    /** @param {MouseEvent} event */
    function suppressProductionBlankDrag(event) {
      if (!import.meta.env.PROD || activeTool !== 'select' || event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.pdf-page') && !target.closest('.textLayer span')) {
        event.preventDefault();
      }
    }

    /** @param {MouseEvent} event */
    function rememberPointerStart(event) {
      if (activeTool !== 'select') return;
      pointerStart = { x: event.clientX, y: event.clientY };
    }

    /** @param {MouseEvent} event */
    function beginWordDrag(event) {
      if (activeTool !== 'select') return;
      const target = event.target;
      if (event.detail !== 2 || !(target instanceof Element) || !target.closest('.textLayer span')) return;

      const caret = caretFromPoint(event.clientX, event.clientY);
      const node = caret?.node;
      const offset = caret?.offset;
      if (!(node instanceof Text) || offset === undefined) return;
      const word = wordBounds(node, offset, 0);
      if (!word) return;

      event.preventDefault();
      wordDrag = { node, start: word.start, end: word.end };
      wordDragDirection = 0;
      wordDragLineBounds = lineBoundsForCaret(node, target);
      setSelection(node, word.start, node, word.end);
    }

    /**
     * @param {Text} node
     * @param {number} offset
     * @param {-1 | 0 | 1} direction
     */
    function wordBounds(node, offset, direction) {
      const words = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(node.data)]
        .filter((segment) => segment.isWordLike)
        .map((segment) => ({ start: segment.index, end: segment.index + segment.segment.length }));
      const containing = words.find((word) => offset >= word.start && offset < word.end);
      if (containing) return containing;
      if (direction > 0) return words.filter((word) => word.start <= offset).at(-1) ?? words[0] ?? null;
      if (direction < 0) return words.find((word) => word.end >= offset) ?? words.at(-1) ?? null;
      return null;
    }

    /** @param {number} x @param {number} y */
    function caretFromPoint(x, y) {
      const caretPosition = document.caretPositionFromPoint?.(x, y);
      const caretRange = document.caretRangeFromPoint?.(x, y);
      const node = caretPosition?.offsetNode ?? caretRange?.startContainer;
      const offset = caretPosition?.offset ?? caretRange?.startOffset;
      return node instanceof Text && offset !== undefined ? { node, offset } : null;
    }

    /** @param {Text} startNode @param {number} start @param {Text} endNode @param {number} end */
    function setSelection(startNode, start, endNode, end) {
      const range = document.createRange();
      range.setStart(startNode, start);
      range.setEnd(endNode, end);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    /** @param {MouseEvent} event */
    function extendWordDrag(event) {
      if (activeTool !== 'select' || !wordDrag || (event.buttons & 1) === 0) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const hitSpan = hit instanceof Element ? hit.closest('.textLayer span:not(.markedContent)') : null;
      const hitRect = hitSpan?.getBoundingClientRect();
      const hitCenterY = hitRect ? hitRect.top + hitRect.height / 2 : null;
      const hitIsDifferentLine =
        hitCenterY !== null &&
        wordDragLineBounds !== null &&
        Math.abs(hitCenterY - wordDragLineBounds.centerY) > wordDragLineBounds.tolerance;
      const verticalBoundary = wordDragLineBounds
        ? verticalLineBoundary(wordDragLineBounds, event.clientY, wordDragDirection)
        : null;

      let caret = null;
      if (hitSpan && (!verticalBoundary || hitIsDifferentLine)) {
        caret = caretFromPoint(event.clientX, event.clientY);
        if (caret) {
          wordDragLineBounds = lineBoundsForCaret(caret.node, hitSpan);
          const direction = wordCaretDirection(wordDrag, caret);
          if (direction) wordDragDirection = direction;
        }
      } else if (verticalBoundary) {
        caret = verticalBoundary;
      }
      if (!caret) return;

      const { node: anchorNode, start, end } = wordDrag;
      if (caret.node === anchorNode && caret.offset >= start && caret.offset <= end) {
        setSelection(anchorNode, start, anchorNode, end);
        return;
      }

      const caretIsBeforeAnchor =
        caret.node === anchorNode
          ? caret.offset < start
          : Boolean(caret.node.compareDocumentPosition(anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING);
      const movingWord = wordBounds(caret.node, caret.offset, caretIsBeforeAnchor ? -1 : 1);
      if (!movingWord) return;
      if (caretIsBeforeAnchor) setSelection(caret.node, movingWord.start, anchorNode, end);
      else setSelection(anchorNode, start, caret.node, movingWord.end);
    }

    function endWordDrag() {
      wordDrag = null;
      wordDragDirection = 0;
      wordDragLineBounds = null;
    }

    /** @param {MouseEvent} event */
    function beginTextSelectionCursor(event) {
      const target = event.target;
      if (
        activeTool === 'select' &&
        event.button === 0 &&
        target instanceof Element &&
        target.closest('.textLayer span')
      ) {
        viewer?.classList.add('text-selecting');
      }
    }

    function endTextSelectionCursor() {
      viewer?.classList.remove('text-selecting');
    }

    /** @param {MouseEvent} event */
    function clearPageSelection(event) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.thumbnail-page')) {
        selectedPages = new Set();
        selectionAnchor = null;
      }
      const wasStationaryClick =
        pointerStart !== null &&
        Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 4;
      pointerStart = null;
      if (
        activeTool === 'select' &&
        wasStationaryClick &&
        target instanceof Element &&
        target.closest('.pdf-page') &&
        !target.closest('.textLayer span')
      ) {
        window.getSelection()?.removeAllRanges();
      }
    }

    /** @param {KeyboardEvent} event */
    function updateZoomCursor(event) {
      if (event.key === 'Shift') zoomingOut = event.type === 'keydown';
    }

    function resetZoomCursor() {
      zoomingOut = false;
    }

    document.addEventListener('mousedown', beginTextSelectionCursor, true);
    document.addEventListener('mousedown', beginProductionCharacterDrag, true);
    document.addEventListener('mousedown', beginWordDrag, true);
    document.addEventListener('mousedown', rememberPointerStart);
    document.addEventListener('mousemove', extendProductionCharacterDrag);
    document.addEventListener('mousemove', extendWordDrag);
    document.addEventListener('mouseup', endTextSelectionCursor, true);
    document.addEventListener('mouseup', finishProductionCharacterDrag, true);
    document.addEventListener('mouseup', endWordDrag);
    document.addEventListener('dragstart', suppressProductionBlankDrag);
    document.addEventListener('click', clearPageSelection);
    window.addEventListener('keydown', updateZoomCursor);
    window.addEventListener('keyup', updateZoomCursor);
    window.addEventListener('blur', resetZoomCursor);
    window.addEventListener('blur', endTextSelectionCursor);
    return () => {
      document.removeEventListener('mousedown', beginTextSelectionCursor, true);
      document.removeEventListener('mousedown', beginProductionCharacterDrag, true);
      document.removeEventListener('mousedown', beginWordDrag, true);
      document.removeEventListener('mousedown', rememberPointerStart);
      document.removeEventListener('mousemove', extendProductionCharacterDrag);
      document.removeEventListener('mousemove', extendWordDrag);
      document.removeEventListener('mouseup', endTextSelectionCursor, true);
      document.removeEventListener('mouseup', finishProductionCharacterDrag, true);
      document.removeEventListener('mouseup', endWordDrag);
      document.removeEventListener('dragstart', suppressProductionBlankDrag);
      document.removeEventListener('click', clearPageSelection);
      window.removeEventListener('keydown', updateZoomCursor);
      window.removeEventListener('keyup', updateZoomCursor);
      window.removeEventListener('blur', resetZoomCursor);
      window.removeEventListener('blur', endTextSelectionCursor);
      endTextSelectionCursor();
    };
  });

  /** @param {number} value */
  function clampZoom(value) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }

  /**
   * Changes the document scale while keeping the document point beneath the
   * pointer in the same place in the scroll viewport.
   * @param {number} requestedZoom
   * @param {number} clientX
   * @param {number} clientY
   */
  async function zoomAt(requestedZoom, clientX, clientY) {
    if (!viewer) return;
    const nextZoom = clampZoom(requestedZoom);
    if (Math.abs(nextZoom - zoomLevel) < 0.001) return;

    const documentElement = viewer.querySelector('.pdf-document');
    if (!(documentElement instanceof HTMLElement)) return;
    const before = documentElement.getBoundingClientRect();
    const documentX = (clientX - before.left) / zoomLevel;
    const documentY = (clientY - before.top) / zoomLevel;

    zoomLevel = nextZoom;
    await tick();

    const after = documentElement.getBoundingClientRect();
    viewer.scrollLeft += after.left + documentX * zoomLevel - clientX;
    viewer.scrollTop += after.top + documentY * zoomLevel - clientY;
    scheduleSharpRender();
  }

  /** @param {WheelEvent} event */
  function handleWheel(event) {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    const deltaScale =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? 100
          : 1;
    const factor = Math.exp(-event.deltaY * deltaScale * 0.002);
    zoomAt(zoomLevel * factor, event.clientX, event.clientY);
  }

  /** @param {PointerEvent} event */
  function handleViewerPointerDown(event) {
    if (!viewer) return;

    if (event.button === 0 && activeTool === 'zoom') {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      zoomAt(zoomLevel * (event.shiftKey ? 1 / CLICK_ZOOM_FACTOR : CLICK_ZOOM_FACTOR), event.clientX, event.clientY);
      return;
    }

    const shouldPan = event.button === 1 || (event.button === 0 && activeTool === 'pan');
    if (!shouldPan) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    isPanning = true;
    panStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewer.scrollLeft,
      scrollTop: viewer.scrollTop
    };
    viewer.setPointerCapture(event.pointerId);
  }

  /** @param {MouseEvent} event */
  function preventMiddleClick(event) {
    if (event.button === 1) event.preventDefault();
  }

  /** @param {PointerEvent} event */
  function handleViewerPointerMove(event) {
    if (!viewer || !panStart || event.pointerId !== panStart.pointerId) return;
    viewer.scrollLeft = panStart.scrollLeft - (event.clientX - panStart.x);
    viewer.scrollTop = panStart.scrollTop - (event.clientY - panStart.y);
  }

  /** @param {PointerEvent} event */
  function endPan(event) {
    if (!viewer || !panStart || event.pointerId !== panStart.pointerId) return;
    if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId);
    panStart = null;
    isPanning = false;
  }

  function handleViewerScroll() {
    if (zoomLevel > 1) scheduleSharpRender(100);
  }

  /** @param {number} [delay] */
  function scheduleSharpRender(delay = 160) {
    if (!pdfReady || !pdfDocument || !viewer) return;
    if (sharpRenderTimer) clearTimeout(sharpRenderTimer);
    sharpRenderTimer = setTimeout(() => {
      sharpRenderTimer = undefined;
      rerenderVisiblePages();
    }, delay);
  }

  function cancelSharpRenders() {
    sharpRenderGeneration += 1;
    sharpRenderTasks.forEach((task) => task.cancel());
    sharpRenderTasks.clear();
    if (sharpRenderTimer) clearTimeout(sharpRenderTimer);
    sharpRenderTimer = undefined;
  }

  async function rerenderVisiblePages() {
    if (!pdfDocument || !viewer) return;
    const generation = ++sharpRenderGeneration;
    sharpRenderTasks.forEach((task) => task.cancel());
    sharpRenderTasks.clear();

    const targetQuality = Math.max(1, zoomLevel);
    const viewerRect = viewer.getBoundingClientRect();
    const shells = [...viewer.querySelectorAll('.pdf-page')].filter((shell) => {
      if (!(shell instanceof HTMLElement)) return false;
      if (targetQuality === 1) return true;
      const rect = shell.getBoundingClientRect();
      return rect.bottom >= viewerRect.top - viewerRect.height && rect.top <= viewerRect.bottom + viewerRect.height;
    });

    for (const shell of shells) {
      if (generation !== sharpRenderGeneration || !pdfDocument) return;
      const canvas = shell.querySelector('canvas');
      if (!(shell instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) continue;
      if (Math.abs(Number(canvas.dataset.renderZoom ?? 0) - targetQuality) < 0.01) continue;

      const pageIndex = [...viewer.querySelectorAll('.pdf-page')].indexOf(shell);
      if (pageIndex < 0) continue;
      const page = await pdfDocument.getPage(pageIndex + 1);
      const baseViewport = page.getViewport({ scale: BASE_PAGE_SCALE });
      const renderViewport = page.getViewport({ scale: BASE_PAGE_SCALE * targetQuality });
      const devicePixelRatio = window.devicePixelRatio || 1;
      const pixelLimitScale = Math.sqrt(MAX_CANVAS_PIXELS / (renderViewport.width * renderViewport.height));
      const outputScale = Math.min(devicePixelRatio, pixelLimitScale);
      const nextCanvas = document.createElement('canvas');
      nextCanvas.width = Math.max(1, Math.floor(renderViewport.width * outputScale));
      nextCanvas.height = Math.max(1, Math.floor(renderViewport.height * outputScale));
      const context = nextCanvas.getContext('2d');
      if (!context) continue;

      const task = page.render({
        canvas: nextCanvas,
        canvasContext: context,
        viewport: renderViewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
      });
      sharpRenderTasks.add(task);

      try {
        await task.promise;
      } catch (error) {
        if (error instanceof Error && error.name === 'RenderingCancelledException') return;
        throw error;
      } finally {
        sharpRenderTasks.delete(task);
      }

      if (generation !== sharpRenderGeneration) return;
      canvas.width = nextCanvas.width;
      canvas.height = nextCanvas.height;
      canvas.style.width = `${baseViewport.width}px`;
      canvas.style.height = `${baseViewport.height}px`;
      canvas.getContext('2d')?.drawImage(nextCanvas, 0, 0);
      canvas.dataset.renderZoom = `${targetQuality}`;
    }
  }

  async function loadPdf() {
    const generation = ++loadGeneration;
    status = 'Rendering PDF…';
    pdfReady = false;
    cancelSharpRenders();
    pageCount = 0;
    selectedPages = new Set();
    selectionAnchor = null;
    textLayerBuilders.forEach((builder) => builder.cancel());
    textLayerBuilders = [];
    textLayerAbortController?.abort();
    textLayerAbortController = new AbortController();
    pdfDocument?.destroy?.();
    pdfDocument = null;

    try {
      // pdf_viewer.mjs reads globalThis.pdfjsLib during module evaluation, so
      // the core module must finish first in optimized production chunks.
      const pdfjs = await import('pdfjs-dist');
      const [pdfViewer, worker] = await Promise.all([
        import('pdfjs-dist/web/pdf_viewer.mjs'),
        import('pdfjs-dist/build/pdf.worker.mjs?url')
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const bytes = await file.arrayBuffer();
      const document = await pdfjs.getDocument({ data: bytes }).promise;
      if (generation !== loadGeneration) {
        document.destroy();
        return;
      }
      pdfDocument = document;
      pageCount = document.numPages;
      await tick();
      await Promise.all([
        renderPages(pdfViewer, document, generation),
        renderThumbnails(document, generation)
      ]);
      status = '';
      pdfReady = true;
      if (zoomLevel !== 1) scheduleSharpRender(0);
    } catch (error) {
      console.error(error);
      status = 'Could not render this PDF.';
    }
  }

  /**
   * @param {typeof import('pdfjs-dist/web/pdf_viewer.mjs')} pdfViewer
   * @param {import('pdfjs-dist').PDFDocumentProxy} document
   * @param {number} generation
   */
  async function renderPages(pdfViewer, document, generation) {
    const shells = viewer?.querySelectorAll('.pdf-page') ?? [];
    for (let index = 0; index < shells.length; index += 1) {
      if (generation !== loadGeneration) return;
      const shell = shells[index];
      const canvas = shell.querySelector('canvas');
      if (!(shell instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) continue;
      const page = await document.getPage(index + 1);
      const viewport = page.getViewport({ scale: BASE_PAGE_SCALE });
      const outputScale = window.devicePixelRatio || 1;
      const context = canvas.getContext('2d');
      if (!context) continue;

      shell.style.width = `${viewport.width}px`;
      shell.style.height = `${viewport.height}px`;
      shell.style.setProperty('--total-scale-factor', `${viewport.scale}`);
      shell.style.setProperty('--scale-round-x', '1px');
      shell.style.setProperty('--scale-round-y', '1px');
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.dataset.renderZoom = '1';
      const textLayerBuilder = new pdfViewer.TextLayerBuilder({
        pdfPage: page,
        abortSignal: textLayerAbortController?.signal,
        onAppend: (/** @type {HTMLDivElement} */ textLayerElement) => shell.append(textLayerElement)
      });
      textLayerBuilders.push(textLayerBuilder);

      await Promise.all([
        page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
        }).promise,
        textLayerBuilder.render({ viewport, images: /** @type {any} */ (null) })
      ]);
      mergeAdjacentTextSpans(textLayerBuilder.div);
    }
  }

  /**
   * Skia-generated PDFs can split a visual word into several marked-content
   * spans. PDF.js scales each span independently, which exposes those internal
   * boundaries in the browser selection highlight. Join only spans that touch
   * on the same baseline and share the same font metrics.
   * @param {HTMLDivElement} textLayer
   */
  function mergeAdjacentTextSpans(textLayer) {
    const spans = /** @type {HTMLSpanElement[]} */ (
      [...textLayer.querySelectorAll('span:not(.markedContent)')].filter(
        (span) => span instanceof HTMLSpanElement && span.textContent
      )
    );
    /** @type {HTMLSpanElement[]} */
    let run = [];

    function mergeRun() {
      if (run.length < 2) {
        run = [];
        return;
      }

      const first = run[0];
      const firstRect = first.getBoundingClientRect();
      const lastRect = run[run.length - 1].getBoundingClientRect();
      const targetWidth = lastRect.right - firstRect.left;
      first.textContent = run.map((span) => span.textContent).join('');
      first.style.setProperty('--scale-x', '1');
      run.slice(1).forEach((span) => span.remove());

      const naturalWidth = first.getBoundingClientRect().width;
      if (naturalWidth > 0) {
        first.style.setProperty('--scale-x', `${targetWidth / naturalWidth}`);
      }
      run = [];
    }

    for (const span of spans) {
      if (run.length === 0) {
        run = [span];
        continue;
      }

      const previous = run[run.length - 1];
      const previousRect = previous.getBoundingClientRect();
      const rect = span.getBoundingClientRect();
      const previousStyle = getComputedStyle(previous);
      const style = getComputedStyle(span);
      const textHeight = Math.min(previousRect.height, rect.height);
      const lineTolerance = Math.max(1, textHeight * 0.06);
      const gapTolerance = Math.max(2, textHeight * 0.1);
      const sameLine = Math.abs(rect.top - previousRect.top) < lineTolerance;
      const touching = Math.abs(rect.left - previousRect.right) < gapTolerance;
      const sameFont =
        style.fontFamily === previousStyle.fontFamily &&
        style.getPropertyValue('--font-height') === previousStyle.getPropertyValue('--font-height');

      if (sameLine && touching && sameFont) run.push(span);
      else {
        mergeRun();
        run = [span];
      }
    }
    mergeRun();
  }

  /** @param {import('pdfjs-dist').PDFDocumentProxy} document @param {number} generation */
  async function renderThumbnails(document, generation) {
    const shells = globalThis.document?.querySelectorAll('.thumbnail-page') ?? [];
    for (let index = 0; index < shells.length; index += 1) {
      if (generation !== loadGeneration) return;
      const shell = shells[index];
      const canvas = shell.querySelector('canvas');
      if (!(shell instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) continue;
      const page = await document.getPage(index + 1);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 244 / baseViewport.width });
      const outputScale = window.devicePixelRatio || 1;
      const context = canvas.getContext('2d');
      if (!context) continue;

      shell.style.height = `${viewport.height}px`;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
      }).promise;
    }
  }

  /** @param {number} pageIndex @param {MouseEvent} event */
  function selectPage(pageIndex, event) {
    if (event.shiftKey && selectionAnchor !== null) {
      const start = Math.min(selectionAnchor, pageIndex);
      const end = Math.max(selectionAnchor, pageIndex);
      selectedPages = new Set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
    } else if (event.metaKey || event.ctrlKey) {
      const nextSelection = new Set(selectedPages);
      if (nextSelection.has(pageIndex)) nextSelection.delete(pageIndex);
      else nextSelection.add(pageIndex);
      selectedPages = nextSelection;
      selectionAnchor = pageIndex;
    } else {
      selectedPages = new Set([pageIndex]);
      selectionAnchor = pageIndex;
    }

    viewer?.querySelectorAll('.pdf-page')[pageIndex]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  onDestroy(() => {
    loadGeneration += 1;
    cancelSharpRenders();
    textLayerBuilders.forEach((builder) => builder.cancel());
    textLayerAbortController?.abort();
    pdfDocument?.destroy?.();
  });
</script>

<aside class="editor-sidebar" aria-label="PDF pages">
  <div class="thumbnail-list">
    {#each Array(pageCount) as _, index}
      <div class="thumbnail-entry">
        <button
          class:page-selected={selectedPages.has(index)}
          class="thumbnail-page"
          aria-label={`Go to page ${index + 1}`}
          aria-pressed={selectedPages.has(index)}
          onclick={(event) => selectPage(index, event)}
        >
          <span class="page-pill">{index + 1}/{pageCount}</span>
          <canvas></canvas>
        </button>
        {#if index < pageCount - 1}<div class="page-separator"></div>{/if}
      </div>
    {/each}
  </div>
</aside>

<section class="pdf-workspace" aria-label={`PDF editor for ${file.name}`}>
  <div
    class:pan-mode={activeTool === 'pan'}
    class:panning={isPanning}
    class:zoom-mode={activeTool === 'zoom'}
    class:zoom-out={zoomingOut}
    class="pdf-viewer"
    role="region"
    aria-label="Document pages"
    bind:this={viewer}
    onwheel={handleWheel}
    onscroll={handleViewerScroll}
    onauxclick={preventMiddleClick}
    onpointerdown={handleViewerPointerDown}
    onpointermove={handleViewerPointerMove}
    onpointerup={endPan}
    onpointercancel={endPan}
  >
    <div class="pdf-document" style:--zoom-level={zoomLevel}>
      {#each Array(pageCount) as _, index}
        <div class="pdf-page" aria-label={`Page ${index + 1}`}>
          <canvas></canvas>
        </div>
      {/each}
    </div>
  </div>
  <EditorToolbar bind:activeTool />
</section>

<style>
  .editor-sidebar {
    grid-column: 1;
    grid-row: 2;
    min-height: 0;
    overflow-y: auto;
    background: #f1f1f1;
    border-right: 1px solid #cfcfcf;
    box-shadow: inset -11px 0 25px rgba(0, 0, 0, 0.03);
    scrollbar-width: none;
  }

  .editor-sidebar::-webkit-scrollbar {
    display: none;
  }

  .thumbnail-list {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 30px 32px 70px;
  }

  .thumbnail-entry {
    width: 244px;
  }

  .thumbnail-page {
    position: relative;
    display: block;
    box-sizing: content-box;
    width: 244px;
    min-height: 120px;
    padding: 0;
    overflow: visible;
    border: 1px solid #dadada;
    border-radius: 10px;
    background: #fff;
    box-shadow: 3px 8px 16px rgba(0, 0, 0, 0.05);
    cursor: pointer;
    transition: border-color 170ms ease, box-shadow 170ms ease;
  }

  .thumbnail-page:hover {
    border-color: #c8c8c8;
    box-shadow: 3px 9px 19px rgba(0, 0, 0, 0.075);
  }

  .thumbnail-page:active {
    border-color: #bfbfbf;
  }

  .thumbnail-page.page-selected,
  .thumbnail-page.page-selected:hover,
  .thumbnail-page.page-selected:active {
    border: 2px solid #529dff;
    box-shadow: 2px 6px 15px rgba(82, 157, 255, 0.16);
  }

  .thumbnail-page canvas {
    display: block;
    width: 244px;
    border-radius: 9px;
  }

  .page-pill {
    position: absolute;
    z-index: 2;
    top: -17px;
    left: 50%;
    display: grid;
    place-items: center;
    min-width: 54px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid #d5d5d5;
    border-radius: 999px;
    background: #e8e8e8;
    color: #747474;
    font-family: Geist, Inter, sans-serif;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    transform: translateX(-50%);
    -webkit-font-smoothing: antialiased;
  }

  .page-separator {
    width: 100%;
    height: 1.2px;
    margin: 20px 0 25px;
    background: #d5d5d5;
  }

  .pdf-workspace {
    position: relative;
    grid-column: 2;
    grid-row: 2;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #e9e9e9;
  }

  .pdf-viewer {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 36px 48px 80px;
    overflow: auto;
    scrollbar-width: none;
  }

  .pdf-document {
    width: max-content;
    min-width: 100%;
    zoom: var(--zoom-level);
  }

  .pdf-viewer.pan-mode {
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .pdf-viewer.panning {
    cursor: grabbing;
    user-select: none;
  }

  .pdf-viewer.zoom-mode {
    cursor: zoom-in;
    touch-action: none;
    user-select: none;
  }

  .pdf-viewer.zoom-mode.zoom-out {
    cursor: zoom-out;
  }

  :global(.pdf-viewer.text-selecting),
  :global(.pdf-viewer.text-selecting .pdf-page),
  :global(.pdf-viewer.text-selecting canvas),
  :global(.pdf-viewer.text-selecting .textLayer),
  :global(.pdf-viewer.text-selecting .textLayer *) {
    cursor: text !important;
  }

  .pdf-viewer::-webkit-scrollbar {
    display: none;
  }

  .pdf-page {
    position: relative;
    margin: 0 auto 30px;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 5px 22px rgba(0, 0, 0, 0.13);
  }

  .pdf-viewer.pan-mode :global(.textLayer span),
  .pdf-viewer.zoom-mode :global(.textLayer span),
  .pdf-viewer.panning :global(.textLayer span) {
    cursor: inherit;
    pointer-events: none;
    user-select: none;
  }

  canvas {
    display: block;
  }

  :global(.textLayer) {
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
    position: absolute;
    inset: 0;
    z-index: 1;
    overflow: clip;
    line-height: 1;
    text-align: initial;
    text-size-adjust: none;
    transform-origin: 0 0;
    forced-color-adjust: none;
    caret-color: CanvasText;
    pointer-events: none;
  }

  :global(.textLayer span),
  :global(.textLayer br) {
    position: absolute;
    color: transparent;
    white-space: pre;
    cursor: text;
    pointer-events: auto;
    transform-origin: 0 0;
  }

  :global(.textLayer > :not(.markedContent)),
  :global(.textLayer .markedContent span:not(.markedContent)) {
    z-index: 1;
    --font-height: 0;
    --scale-x: 1;
    --rotate: 0deg;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }

  :global(.textLayer .markedContent) {
    display: contents;
  }

  :global(.textLayer span[role='img']) {
    cursor: default;
    user-select: none;
  }

  :global(.textLayer ::selection) {
    background: color-mix(in srgb, AccentColor, transparent 75%);
  }

  :global(.textLayer br::selection) {
    background: transparent;
  }

  :global(.textLayer .endOfContent) {
    position: absolute;
    z-index: 0;
    display: block;
    inset: 100% 0 0;
    cursor: default;
    user-select: none;
  }

  :global(.textLayer.selecting .endOfContent) {
    top: 0;
  }
</style>
