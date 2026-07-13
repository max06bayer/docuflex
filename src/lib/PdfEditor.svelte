<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import EditorToolbar from '$lib/EditorToolbar.svelte';

  /** @typedef {{ x: number; y: number; pressure: number }} StrokePoint */
  /** @typedef {{ id: number; type: 'marker' | 'pen'; points: StrokePoint[] }} AnnotationStroke */

  /** @type {File} */
  export let file;

  /** @type {HTMLDivElement | undefined} */
  let viewer;
  /** @type {HTMLElement | undefined} */
  let workspace;
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
  /** @type {Record<number, AnnotationStroke[]>} */
  let annotations = {};
  /** @type {Record<number, { width: number; height: number }>} */
  let pageSizes = {};
  /** @type {{ pointerId: number; pageIndex: number; stroke: AnnotationStroke } | null} */
  let drawingStroke = null;
  /** @type {number | null} */
  let erasingPointerId = null;
  /** @type {{ pageIndex: number; point: StrokePoint } | null} */
  let lastEraserPoint = null;
  let nextAnnotationId = 1;
  let eraserCursorVisible = false;
  let eraserCursorX = 0;
  let eraserCursorY = 0;
  let eraserCursorSize = 34;

  const BASE_PAGE_SCALE = 1.35;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const CLICK_ZOOM_FACTOR = 1.25;
  const MAX_CANVAS_PIXELS = 24_000_000;
  const ERASER_RADIUS = 17;

  $: if (activeTool !== 'eraser') eraserCursorVisible = false;

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

  /** @param {StrokePoint[]} points */
  function strokePath(points) {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y} l 0.01 0.01`;
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index];
      const next = points[index + 1];
      path += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`;
    }
    const last = points[points.length - 1];
    return `${path} L ${last.x} ${last.y}`;
  }

  /** @param {number} clientX @param {number} clientY */
  function pageAtPoint(clientX, clientY) {
    const hit = document.elementFromPoint(clientX, clientY);
    const shell = hit instanceof Element ? hit.closest('.pdf-page') : null;
    if (!(shell instanceof HTMLElement) || !viewer) return null;
    const pages = [...viewer.querySelectorAll('.pdf-page')];
    const pageIndex = pages.indexOf(shell);
    return pageIndex < 0 ? null : { shell, pageIndex };
  }

  /** @param {PointerEvent} event @param {HTMLElement} shell */
  function pointOnPage(event, shell) {
    const rect = shell.getBoundingClientRect();
    const width = Number.parseFloat(shell.style.width) || shell.offsetWidth;
    const height = Number.parseFloat(shell.style.height) || shell.offsetHeight;
    return {
      x: Math.max(0, Math.min(width, ((event.clientX - rect.left) / rect.width) * width)),
      y: Math.max(0, Math.min(height, ((event.clientY - rect.top) / rect.height) * height)),
      pressure: event.pressure > 0 ? event.pressure : 0.5
    };
  }

  /** @param {StrokePoint[]} points @param {StrokePoint} point @param {number} [spacing] */
  function appendInterpolatedPoint(points, point, spacing = 2) {
    const last = points[points.length - 1];
    if (!last) return [point];
    const distance = Math.hypot(point.x - last.x, point.y - last.y);
    if (distance < 0.35) return points;
    const steps = Math.max(1, Math.ceil(distance / spacing));
    const next = [...points];
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      next.push({
        x: last.x + (point.x - last.x) * amount,
        y: last.y + (point.y - last.y) * amount,
        pressure: last.pressure + (point.pressure - last.pressure) * amount
      });
    }
    return next;
  }

  /** @param {StrokePoint[]} points */
  function straightenMarker(points) {
    if (points.length < 2) return points;
    const center = points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 }
    );
    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (const point of points) {
      const x = point.x - center.x;
      const y = point.y - center.y;
      xx += x * x;
      xy += x * y;
      yy += y * y;
    }
    let angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    let direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const lastPoint = points[points.length - 1];
    const gesture = { x: lastPoint.x - points[0].x, y: lastPoint.y - points[0].y };
    if (gesture.x * direction.x + gesture.y * direction.y < 0) {
      angle += Math.PI;
      direction = { x: Math.cos(angle), y: Math.sin(angle) };
    }
    const projections = points.map(
      (point) => (point.x - center.x) * direction.x + (point.y - center.y) * direction.y
    );
    const startProjection = Math.min(...projections);
    const endProjection = Math.max(...projections);
    const start = {
      x: center.x + direction.x * startProjection,
      y: center.y + direction.y * startProjection,
      pressure: 0.5
    };
    const end = {
      x: center.x + direction.x * endProjection,
      y: center.y + direction.y * endProjection,
      pressure: 0.5
    };
    return appendInterpolatedPoint([start], end, 2);
  }

  /** @param {number} pageIndex @param {AnnotationStroke} stroke */
  function replaceStroke(pageIndex, stroke) {
    annotations = {
      ...annotations,
      [pageIndex]: (annotations[pageIndex] ?? []).map((candidate) =>
        candidate.id === stroke.id ? stroke : candidate
      )
    };
  }

  /** @param {number} pageIndex @param {StrokePoint} point */
  function eraseAt(pageIndex, point) {
    const strokes = annotations[pageIndex] ?? [];
    /** @type {AnnotationStroke[]} */
    const fragments = [];
    for (const stroke of strokes) {
      /** @type {StrokePoint[]} */
      let run = [];
      for (const strokePoint of stroke.points) {
        if (Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= ERASER_RADIUS) {
          if (run.length) fragments.push({ ...stroke, id: nextAnnotationId++, points: run });
          run = [];
        } else {
          run.push(strokePoint);
        }
      }
      if (run.length) fragments.push({ ...stroke, id: nextAnnotationId++, points: run });
    }
    annotations = { ...annotations, [pageIndex]: fragments };
  }

  /** @param {PointerEvent} event */
  function updateEraserCursor(event) {
    if (activeTool !== 'eraser') {
      eraserCursorVisible = false;
      return;
    }
    const pageHit = pageAtPoint(event.clientX, event.clientY);
    if (!pageHit || !workspace) {
      eraserCursorVisible = false;
      return;
    }
    const workspaceRect = workspace.getBoundingClientRect();
    const workspaceScaleX = workspaceRect.width / workspace.offsetWidth;
    const workspaceScaleY = workspaceRect.height / workspace.offsetHeight;
    const pageRect = pageHit.shell.getBoundingClientRect();
    const pageWidth = Number.parseFloat(pageHit.shell.style.width) || pageHit.shell.offsetWidth;
    const pageScale = pageRect.width / pageWidth;
    eraserCursorX = (event.clientX - workspaceRect.left) / workspaceScaleX;
    eraserCursorY = (event.clientY - workspaceRect.top) / workspaceScaleY;
    eraserCursorSize = (ERASER_RADIUS * 2 * pageScale) / workspaceScaleX;
    eraserCursorVisible = true;
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

    const pageHit = pageAtPoint(event.clientX, event.clientY);
    if (event.button === 0 && pageHit && (activeTool === 'marker' || activeTool === 'pen')) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      const stroke = {
        id: nextAnnotationId++,
        type: /** @type {'marker' | 'pen'} */ (activeTool),
        points: [pointOnPage(event, pageHit.shell)]
      };
      annotations = {
        ...annotations,
        [pageHit.pageIndex]: [...(annotations[pageHit.pageIndex] ?? []), stroke]
      };
      drawingStroke = { pointerId: event.pointerId, pageIndex: pageHit.pageIndex, stroke };
      viewer.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button === 0 && pageHit && activeTool === 'eraser') {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      erasingPointerId = event.pointerId;
      const point = pointOnPage(event, pageHit.shell);
      lastEraserPoint = { pageIndex: pageHit.pageIndex, point };
      eraseAt(pageHit.pageIndex, point);
      viewer.setPointerCapture(event.pointerId);
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
    updateEraserCursor(event);
    handleAnnotationPointerMove(event);
    if (!viewer || !panStart || event.pointerId !== panStart.pointerId) return;
    viewer.scrollLeft = panStart.scrollLeft - (event.clientX - panStart.x);
    viewer.scrollTop = panStart.scrollTop - (event.clientY - panStart.y);
  }

  /** @param {PointerEvent} event */
  function handleAnnotationPointerMove(event) {
    if (!viewer) return;
    if (drawingStroke && event.pointerId === drawingStroke.pointerId) {
      const pages = [...viewer.querySelectorAll('.pdf-page')];
      const shell = pages[drawingStroke.pageIndex];
      if (!(shell instanceof HTMLElement)) return;
      let points = drawingStroke.stroke.points;
      const events = event.getCoalescedEvents?.() ?? [event];
      for (const coalescedEvent of events) {
        points = appendInterpolatedPoint(points, pointOnPage(coalescedEvent, shell));
      }
      drawingStroke.stroke = { ...drawingStroke.stroke, points };
      replaceStroke(drawingStroke.pageIndex, drawingStroke.stroke);
      return;
    }

    if (erasingPointerId === event.pointerId) {
      const pageHit = pageAtPoint(event.clientX, event.clientY);
      if (pageHit) {
        const point = pointOnPage(event, pageHit.shell);
        if (lastEraserPoint?.pageIndex === pageHit.pageIndex) {
          const samples = appendInterpolatedPoint(
            [lastEraserPoint.point],
            point,
            ERASER_RADIUS / 2
          );
          for (const sample of samples.slice(1)) eraseAt(pageHit.pageIndex, sample);
        } else {
          eraseAt(pageHit.pageIndex, point);
        }
        lastEraserPoint = { pageIndex: pageHit.pageIndex, point };
      }
    }
  }

  /** @param {PointerEvent} event */
  function endPan(event) {
    if (!viewer) return;
    if (drawingStroke && event.pointerId === drawingStroke.pointerId) {
      if (drawingStroke.stroke.type === 'marker') {
        drawingStroke.stroke = {
          ...drawingStroke.stroke,
          points: straightenMarker(drawingStroke.stroke.points)
        };
        replaceStroke(drawingStroke.pageIndex, drawingStroke.stroke);
      }
      drawingStroke = null;
    }
    if (erasingPointerId === event.pointerId) {
      erasingPointerId = null;
      lastEraserPoint = null;
      eraserCursorVisible = false;
    }
    if (panStart && event.pointerId === panStart.pointerId) {
      panStart = null;
      isPanning = false;
    }
    if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId);
  }

  function hideEraserCursor() {
    if (erasingPointerId === null) eraserCursorVisible = false;
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
    annotations = {};
    pageSizes = {};
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
      pageSizes = { ...pageSizes, [index]: { width: viewport.width, height: viewport.height } };
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

  function exportableAnnotations() {
    return Object.entries(annotations).flatMap(([page, strokes]) => {
      const pageSize = pageSizes[Number(page)];
      if (!pageSize?.width || !pageSize.height) return [];
      return strokes
        .filter((stroke) => stroke.points.length > 0)
        .map((stroke) => ({
          page: Number(page),
          type: stroke.type,
          points: stroke.points.map((point) => ({
            x: point.x / pageSize.width,
            y: point.y / pageSize.height
          }))
        }));
    });
  }

  export async function downloadPdf() {
    const response = await fetch('/api/pdf/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfBase64: arrayBufferToBase64(await file.arrayBuffer()),
        annotations: exportableAnnotations()
      })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? `PDF export failed (${response.status}).`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const baseName = file.name.replace(/\.pdf$/i, '') || 'document';
    anchor.href = url;
    anchor.download = `${baseName}-edited.pdf`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

<section class="pdf-workspace" aria-label={`PDF editor for ${file.name}`} bind:this={workspace}>
  <div
    class:pan-mode={activeTool === 'pan'}
    class:panning={isPanning}
    class:zoom-mode={activeTool === 'zoom'}
    class:zoom-out={zoomingOut}
    class:drawing-mode={activeTool === 'marker' || activeTool === 'pen'}
    class:eraser-mode={activeTool === 'eraser'}
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
    onpointerleave={hideEraserCursor}
  >
    <div class="pdf-document" style:--zoom-level={zoomLevel}>
      {#each Array(pageCount) as _, index}
        <div class="pdf-page" aria-label={`Page ${index + 1}`}>
          <canvas></canvas>
          <svg
            class="annotation-layer marker-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#each (annotations[index] ?? []).filter((stroke) => stroke.type === 'marker') as stroke (stroke.id)}
              <path class="marker-edge" d={strokePath(stroke.points)} />
              <path class="marker-ink" d={strokePath(stroke.points)} />
            {/each}
          </svg>
          <svg
            class="annotation-layer pen-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#each (annotations[index] ?? []).filter((stroke) => stroke.type === 'pen') as stroke (stroke.id)}
              <path class="pen-soft-edge" d={strokePath(stroke.points)} />
              <path class="pen-ink" d={strokePath(stroke.points)} />
            {/each}
          </svg>
        </div>
      {/each}
    </div>
  </div>
  {#if eraserCursorVisible}
    <div
      class="eraser-cursor"
      style:left={`${eraserCursorX}px`}
      style:top={`${eraserCursorY}px`}
      style:width={`${eraserCursorSize}px`}
      style:height={`${eraserCursorSize}px`}
      aria-hidden="true"
    ></div>
  {/if}
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

  .pdf-viewer.drawing-mode {
    cursor: crosshair;
    touch-action: none;
    user-select: none;
  }

  .pdf-viewer.eraser-mode {
    cursor: none;
    touch-action: none;
    user-select: none;
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

  .annotation-layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .annotation-layer path {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .marker-layer {
    z-index: 1;
    mix-blend-mode: multiply;
  }

  .marker-edge {
    stroke: #f4cd19;
    stroke-width: 20px;
    opacity: 0.13;
  }

  .marker-ink {
    stroke: #ffe43b;
    stroke-width: 16px;
    opacity: 0.34;
  }

  .pen-layer {
    z-index: 3;
  }

  .pen-soft-edge {
    stroke: #8d0613;
    stroke-width: 3.4px;
    opacity: 0.15;
  }

  .pen-ink {
    stroke: #e21d32;
    stroke-width: 2.05px;
    opacity: 0.94;
  }

  .eraser-cursor {
    position: absolute;
    z-index: 9;
    box-sizing: border-box;
    border: 1.5px solid rgba(25, 25, 25, 0.72);
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.16);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.72), inset 0 0 0 1px rgba(0, 0, 0, 0.08);
    pointer-events: none;
    transform: translate(-50%, -50%);
  }

  .pdf-viewer.pan-mode :global(.textLayer span),
  .pdf-viewer.zoom-mode :global(.textLayer span),
  .pdf-viewer.panning :global(.textLayer span),
  .pdf-viewer.drawing-mode :global(.textLayer span),
  .pdf-viewer.eraser-mode :global(.textLayer span) {
    cursor: inherit;
    pointer-events: none;
    user-select: none;
  }

  canvas {
    position: relative;
    z-index: 0;
    display: block;
  }

  :global(.textLayer) {
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
    position: absolute;
    inset: 0;
    z-index: 2;
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
