<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import EditorToolbar from '$lib/EditorToolbar.svelte';

  /** @typedef {{ x: number; y: number; pressure: number }} StrokePoint */
  /** @typedef {{ id: number; type: 'marker' | 'pen'; points: StrokePoint[] }} AnnotationStroke */
  /** @typedef {{ id: number; type: 'triangle' | 'rectangle' | 'circle' | 'check' | 'cross' | 'arrow' | 'line'; x: number; y: number; width: number; height: number; rotation: number }} AnnotationShape */

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
  /** @type {Record<number, AnnotationShape[]>} */
  let shapes = {};
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
  /** @type {{ pageIndex: number; id: number } | null} */
  let selectedShape = null;
  /** @type {{ pointerId: number; pageIndex: number; id: number; start: StrokePoint } | null} */
  let drawingShape = null;
  /** @type {null | { pointerId: number; kind: 'move'; pageIndex: number; id: number; start: StrokePoint; initial: AnnotationShape } | { pointerId: number; kind: 'resize'; pageIndex: number; id: number; handleX: -1 | 0 | 1; handleY: -1 | 0 | 1; initial: AnnotationShape } | { pointerId: number; kind: 'rotate'; pageIndex: number; id: number; initial: AnnotationShape; startAngle: number } | { pointerId: number; kind: 'line-endpoint'; pageIndex: number; id: number; endpoint: 'start' | 'end'; initial: AnnotationShape }} */
  let shapeInteraction = null;
  /** @type {{ pageIndex: number; x: number | null; y: number | null; shape: AnnotationShape } | null} */
  let shapeGuides = null;

  const BASE_PAGE_SCALE = 1.35;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const CLICK_ZOOM_FACTOR = 1.25;
  const MAX_CANVAS_PIXELS = 24_000_000;
  const ERASER_RADIUS = 17;
  const SHAPE_TOOLS = new Set(['triangle', 'rectangle', 'circle', 'check', 'cross', 'arrow', 'line']);
  const LINE_SHAPE_TOOLS = new Set(['arrow', 'line']);
  const MIN_SHAPE_SIZE = 8;

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
    window.addEventListener('keydown', handleShapeKeyboard);
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
      window.removeEventListener('keydown', handleShapeKeyboard);
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

  /** @param {number} pageIndex @param {number} id */
  function findShape(pageIndex, id) {
    return (shapes[pageIndex] ?? []).find((shape) => shape.id === id) ?? null;
  }

  /** @param {number} pageIndex @param {AnnotationShape} shape */
  function replaceShape(pageIndex, shape) {
    shapes = {
      ...shapes,
      [pageIndex]: (shapes[pageIndex] ?? []).map((candidate) =>
        candidate.id === shape.id ? shape : candidate
      )
    };
  }

  /** @param {number} value @param {number} minimum @param {number} maximum */
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  /** @param {number} x @param {number} y @param {number} angle */
  function rotateVector(x, y, angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return { x: x * cosine - y * sine, y: x * sine + y * cosine };
  }

  /** @param {AnnotationShape} shape */
  function shapeCenter(shape) {
    return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  }

  /** @param {AnnotationShape} shape */
  function isLinearShape(shape) {
    return LINE_SHAPE_TOOLS.has(shape.type);
  }

  /** @param {AnnotationShape} shape */
  function linearEndpoints(shape) {
    const center = shapeCenter(shape);
    const angle = (shape.rotation * Math.PI) / 180;
    const half = rotateVector(shape.width / 2, 0, angle);
    return {
      start: { x: center.x - half.x, y: center.y - half.y },
      end: { x: center.x + half.x, y: center.y + half.y }
    };
  }

  /** @param {AnnotationShape} shape @param {{ width: number; height: number }} pageSize */
  function shapeGuideSegments(shape, pageSize) {
    if (isLinearShape(shape)) {
      const endpoints = Object.values(linearEndpoints(shape));
      const horizontalCandidates = endpoints.flatMap((point) => [
        { distance: point.x, edge: 0, point },
        { distance: pageSize.width - point.x, edge: pageSize.width, point }
      ]);
      const verticalCandidates = endpoints.flatMap((point) => [
        { distance: point.y, edge: 0, point },
        { distance: pageSize.height - point.y, edge: pageSize.height, point }
      ]);
      const horizontal = horizontalCandidates.sort((left, right) => left.distance - right.distance)[0];
      const vertical = verticalCandidates.sort((left, right) => left.distance - right.distance)[0];
      return {
        horizontal: { y: horizontal.point.y, edge: horizontal.edge, shape: horizontal.point.x },
        vertical: { x: vertical.point.x, edge: vertical.edge, shape: vertical.point.y }
      };
    }
    const center = shapeCenter(shape);
    return {
      horizontal: {
        y: center.y,
        edge: center.x < pageSize.width / 2 ? 0 : pageSize.width,
        shape: center.x < pageSize.width / 2 ? shape.x : shape.x + shape.width
      },
      vertical: {
        x: center.x,
        edge: center.y < pageSize.height / 2 ? 0 : pageSize.height,
        shape: center.y < pageSize.height / 2 ? shape.y : shape.y + shape.height
      }
    };
  }

  /** @param {AnnotationShape} shape @param {{ x: number; y: number }} start @param {{ x: number; y: number }} end */
  function shapeFromEndpoints(shape, start, end) {
    const width = Math.max(0.01, Math.hypot(end.x - start.x, end.y - start.y));
    const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    return {
      ...shape,
      x: center.x - width / 2,
      y: center.y - 0.005,
      width,
      height: 0.01,
      rotation: (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI
    };
  }

  /** @param {{ x: number; y: number }} fixed @param {{ x: number; y: number }} moving */
  function constrainLineAngle(fixed, moving) {
    const distance = Math.hypot(moving.x - fixed.x, moving.y - fixed.y);
    const angle = Math.atan2(moving.y - fixed.y, moving.x - fixed.x);
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    return { x: fixed.x + Math.cos(snapped) * distance, y: fixed.y + Math.sin(snapped) * distance };
  }

  /** @param {PointerEvent} event */
  function shapeTarget(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const element = target.closest('[data-shape-id]');
    if (!(element instanceof SVGElement)) return null;
    const id = Number(element.dataset.shapeId);
    const pageIndex = Number(element.dataset.shapePage);
    return Number.isInteger(id) && Number.isInteger(pageIndex) ? { id, pageIndex, element } : null;
  }

  /** @param {AnnotationShape} shape @param {{ width: number; height: number }} pageSize */
  function snapMovedShape(shape, pageSize) {
    const tolerance = 6 / zoomLevel;
    const xCandidates = [
      { value: shape.x, target: 0 },
      { value: shape.x + shape.width / 2, target: pageSize.width / 2 },
      { value: shape.x + shape.width, target: pageSize.width }
    ];
    const yCandidates = [
      { value: shape.y, target: 0 },
      { value: shape.y + shape.height / 2, target: pageSize.height / 2 },
      { value: shape.y + shape.height, target: pageSize.height }
    ];
    const xSnap = xCandidates
      .map((candidate) => ({ ...candidate, distance: Math.abs(candidate.value - candidate.target) }))
      .sort((left, right) => left.distance - right.distance)[0];
    const ySnap = yCandidates
      .map((candidate) => ({ ...candidate, distance: Math.abs(candidate.value - candidate.target) }))
      .sort((left, right) => left.distance - right.distance)[0];
    const next = { ...shape };
    let guideX = null;
    let guideY = null;
    if (xSnap.distance <= tolerance) {
      next.x += xSnap.target - xSnap.value;
      guideX = xSnap.target;
    }
    if (ySnap.distance <= tolerance) {
      next.y += ySnap.target - ySnap.value;
      guideY = ySnap.target;
    }
    next.x = clamp(next.x, 0, Math.max(0, pageSize.width - next.width));
    next.y = clamp(next.y, 0, Math.max(0, pageSize.height - next.height));
    return { shape: next, x: guideX, y: guideY };
  }

  /** @param {KeyboardEvent} event */
  function handleShapeKeyboard(event) {
    if (!selectedShape) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
    const shape = findShape(selectedShape.pageIndex, selectedShape.id);
    if (!shape) return;
    if (event.key === 'Escape') {
      selectedShape = null;
      shapeGuides = null;
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      shapes = {
        ...shapes,
        [selectedShape.pageIndex]: (shapes[selectedShape.pageIndex] ?? []).filter(
          (candidate) => candidate.id !== selectedShape?.id
        )
      };
      selectedShape = null;
      shapeGuides = null;
      return;
    }
    const direction = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 }
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    const pageSize = pageSizes[selectedShape.pageIndex];
    const amount = event.shiftKey ? 10 : 1;
    replaceShape(selectedShape.pageIndex, {
      ...shape,
      x: clamp(shape.x + direction.x * amount, 0, Math.max(0, pageSize.width - shape.width)),
      y: clamp(shape.y + direction.y * amount, 0, Math.max(0, pageSize.height - shape.height))
    });
  }

  /** @param {PointerEvent} event @param {HTMLElement} shell @param {number} pageIndex */
  function beginShapeCreation(event, shell, pageIndex) {
    const start = pointOnPage(event, shell);
    const shape = {
      id: nextAnnotationId++,
      type: /** @type {'triangle' | 'rectangle' | 'circle' | 'check' | 'cross' | 'arrow' | 'line'} */ (activeTool),
      x: start.x,
      y: start.y,
      width: 0.01,
      height: 0.01,
      rotation: 0
    };
    shapes = { ...shapes, [pageIndex]: [...(shapes[pageIndex] ?? []), shape] };
    selectedShape = { pageIndex, id: shape.id };
    drawingShape = { pointerId: event.pointerId, pageIndex, id: shape.id, start };
    shapeGuides = { pageIndex, x: null, y: null, shape };
  }

  /** @param {PointerEvent} event @param {HTMLElement} shell */
  function updateShapeCreation(event, shell) {
    if (!drawingShape) return;
    const current = pointOnPage(event, shell);
    const start = drawingShape.start;
    const existingShape = findShape(drawingShape.pageIndex, drawingShape.id);
    if (!existingShape) return;
    if (isLinearShape(existingShape)) {
      const end = event.shiftKey ? constrainLineAngle(start, current) : current;
      const next = shapeFromEndpoints(existingShape, start, end);
      replaceShape(drawingShape.pageIndex, next);
      shapeGuides = { pageIndex: drawingShape.pageIndex, x: null, y: null, shape: next };
      return;
    }
    let deltaX = current.x - start.x;
    let deltaY = current.y - start.y;
    if (event.shiftKey) {
      const size = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      deltaX = Math.sign(deltaX || 1) * size;
      deltaY = Math.sign(deltaY || 1) * size;
    }
    const x1 = event.altKey ? start.x - deltaX : start.x;
    const y1 = event.altKey ? start.y - deltaY : start.y;
    const x2 = event.altKey ? start.x + deltaX : start.x + deltaX;
    const y2 = event.altKey ? start.y + deltaY : start.y + deltaY;
    const pageSize = pageSizes[drawingShape.pageIndex];
    const shape = existingShape;
    if (!shape || !pageSize) return;
    const next = {
      ...shape,
      x: clamp(Math.min(x1, x2), 0, pageSize.width),
      y: clamp(Math.min(y1, y2), 0, pageSize.height),
      width: Math.max(0.01, Math.min(pageSize.width, Math.max(x1, x2)) - clamp(Math.min(x1, x2), 0, pageSize.width)),
      height: Math.max(0.01, Math.min(pageSize.height, Math.max(y1, y2)) - clamp(Math.min(y1, y2), 0, pageSize.height))
    };
    replaceShape(drawingShape.pageIndex, next);
    shapeGuides = {
      pageIndex: drawingShape.pageIndex,
      x: Math.abs(next.x + next.width / 2 - pageSize.width / 2) <= 6 / zoomLevel ? pageSize.width / 2 : null,
      y: Math.abs(next.y + next.height / 2 - pageSize.height / 2) <= 6 / zoomLevel ? pageSize.height / 2 : null,
      shape: next
    };
  }

  /** @param {PointerEvent} event @param {HTMLElement} shell */
  function updateShapeTransform(event, shell) {
    if (!shapeInteraction) return;
    const point = pointOnPage(event, shell);
    const interaction = shapeInteraction;
    const pageSize = pageSizes[interaction.pageIndex];
    if (!pageSize) return;

    if (interaction.kind === 'move') {
      const proposed = {
        ...interaction.initial,
        x: interaction.initial.x + point.x - interaction.start.x,
        y: interaction.initial.y + point.y - interaction.start.y
      };
      const snapped = event.metaKey || event.ctrlKey
        ? { shape: proposed, x: null, y: null }
        : snapMovedShape(proposed, pageSize);
      replaceShape(interaction.pageIndex, snapped.shape);
      shapeGuides = { pageIndex: interaction.pageIndex, x: snapped.x, y: snapped.y, shape: snapped.shape };
      return;
    }

    if (interaction.kind === 'line-endpoint') {
      const endpoints = linearEndpoints(interaction.initial);
      if (interaction.endpoint === 'start') {
        const start = event.shiftKey ? constrainLineAngle(endpoints.end, point) : point;
        const next = shapeFromEndpoints(interaction.initial, start, endpoints.end);
        replaceShape(interaction.pageIndex, next);
        shapeGuides = { pageIndex: interaction.pageIndex, x: null, y: null, shape: next };
      } else {
        const end = event.shiftKey ? constrainLineAngle(endpoints.start, point) : point;
        const next = shapeFromEndpoints(interaction.initial, endpoints.start, end);
        replaceShape(interaction.pageIndex, next);
        shapeGuides = { pageIndex: interaction.pageIndex, x: null, y: null, shape: next };
      }
      return;
    }

    if (interaction.kind === 'rotate') {
      const center = shapeCenter(interaction.initial);
      const pointerAngle = Math.atan2(point.y - center.y, point.x - center.x);
      let rotation = interaction.initial.rotation + ((pointerAngle - interaction.startAngle) * 180) / Math.PI;
      if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
      const next = { ...interaction.initial, rotation: ((rotation % 360) + 360) % 360 };
      replaceShape(interaction.pageIndex, next);
      shapeGuides = { pageIndex: interaction.pageIndex, x: null, y: null, shape: next };
      return;
    }

    const initial = interaction.initial;
    const center = shapeCenter(initial);
    const angle = (initial.rotation * Math.PI) / 180;
    const localPointer = rotateVector(point.x - center.x, point.y - center.y, -angle);
    let width = interaction.handleX === 0 ? initial.width : Math.max(MIN_SHAPE_SIZE, Math.abs(localPointer.x) * (event.altKey ? 2 : 1) + (event.altKey ? 0 : initial.width / 2));
    let height = interaction.handleY === 0 ? initial.height : Math.max(MIN_SHAPE_SIZE, Math.abs(localPointer.y) * (event.altKey ? 2 : 1) + (event.altKey ? 0 : initial.height / 2));

    if (!event.altKey) {
      if (interaction.handleX !== 0) width = Math.max(MIN_SHAPE_SIZE, interaction.handleX * localPointer.x + initial.width / 2);
      if (interaction.handleY !== 0) height = Math.max(MIN_SHAPE_SIZE, interaction.handleY * localPointer.y + initial.height / 2);
    }
    if (event.shiftKey && interaction.handleX !== 0 && interaction.handleY !== 0) {
      const ratio = initial.width / initial.height;
      if (width / height > ratio) height = width / ratio;
      else width = height * ratio;
    }

    let nextCenter = center;
    if (!event.altKey) {
      const localCenterShift = {
        x: interaction.handleX === 0 ? 0 : interaction.handleX * (width - initial.width) / 2,
        y: interaction.handleY === 0 ? 0 : interaction.handleY * (height - initial.height) / 2
      };
      const worldShift = rotateVector(localCenterShift.x, localCenterShift.y, angle);
      nextCenter = { x: center.x + worldShift.x, y: center.y + worldShift.y };
    }
    const next = {
      ...initial,
      x: nextCenter.x - width / 2,
      y: nextCenter.y - height / 2,
      width,
      height
    };
    replaceShape(interaction.pageIndex, next);
    shapeGuides = { pageIndex: interaction.pageIndex, x: null, y: null, shape: next };
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

    const shapeHit = shapeTarget(event);
    if (event.button === 0 && shapeHit && activeTool === 'select') {
      const shape = findShape(shapeHit.pageIndex, shapeHit.id);
      const pages = [...viewer.querySelectorAll('.pdf-page')];
      const shell = pages[shapeHit.pageIndex];
      if (!shape || !(shell instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      selectedShape = { pageIndex: shapeHit.pageIndex, id: shapeHit.id };
      const point = pointOnPage(event, shell);
      const handle = shapeHit.element.dataset.shapeHandle;
      const endpoint = shapeHit.element.dataset.shapeEndpoint;
      if (endpoint === 'start' || endpoint === 'end') {
        shapeInteraction = {
          pointerId: event.pointerId,
          kind: 'line-endpoint',
          pageIndex: shapeHit.pageIndex,
          id: shape.id,
          endpoint,
          initial: { ...shape }
        };
      } else if (shapeHit.element.dataset.shapeRotate !== undefined) {
        const center = shapeCenter(shape);
        shapeInteraction = {
          pointerId: event.pointerId,
          kind: 'rotate',
          pageIndex: shapeHit.pageIndex,
          id: shape.id,
          initial: { ...shape },
          startAngle: Math.atan2(point.y - center.y, point.x - center.x)
        };
      } else if (handle) {
        const [handleX, handleY] = handle.split(',').map(Number);
        shapeInteraction = {
          pointerId: event.pointerId,
          kind: 'resize',
          pageIndex: shapeHit.pageIndex,
          id: shape.id,
          handleX: /** @type {-1 | 0 | 1} */ (handleX),
          handleY: /** @type {-1 | 0 | 1} */ (handleY),
          initial: { ...shape }
        };
      } else {
        shapeInteraction = {
          pointerId: event.pointerId,
          kind: 'move',
          pageIndex: shapeHit.pageIndex,
          id: shape.id,
          start: point,
          initial: { ...shape }
        };
      }
      viewer.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button === 0 && activeTool === 'zoom') {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      zoomAt(zoomLevel * (event.shiftKey ? 1 / CLICK_ZOOM_FACTOR : CLICK_ZOOM_FACTOR), event.clientX, event.clientY);
      return;
    }

    const pageHit = pageAtPoint(event.clientX, event.clientY);
    if (event.button === 0 && activeTool === 'select' && !pageHit) {
      selectedShape = null;
      shapeGuides = null;
    }
    if (event.button === 0 && pageHit && SHAPE_TOOLS.has(activeTool)) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      beginShapeCreation(event, pageHit.shell, pageHit.pageIndex);
      viewer.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button === 0 && activeTool === 'select' && pageHit && !shapeHit) {
      selectedShape = null;
      shapeGuides = null;
    }

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
    if (viewer && drawingShape && event.pointerId === drawingShape.pointerId) {
      const shell = viewer.querySelectorAll('.pdf-page')[drawingShape.pageIndex];
      if (shell instanceof HTMLElement) updateShapeCreation(event, shell);
    } else if (viewer && shapeInteraction && event.pointerId === shapeInteraction.pointerId) {
      const shell = viewer.querySelectorAll('.pdf-page')[shapeInteraction.pageIndex];
      if (shell instanceof HTMLElement) updateShapeTransform(event, shell);
    }
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
    if (drawingShape && event.pointerId === drawingShape.pointerId) {
      const shell = viewer.querySelectorAll('.pdf-page')[drawingShape.pageIndex];
      if (shell instanceof HTMLElement) updateShapeCreation(event, shell);
      const shape = findShape(drawingShape.pageIndex, drawingShape.id);
      const pageSize = pageSizes[drawingShape.pageIndex];
      if (shape && pageSize && isLinearShape(shape) && shape.width < 3) {
        const end = {
          x: Math.min(pageSize.width, drawingShape.start.x + Math.min(120, pageSize.width / 4)),
          y: drawingShape.start.y
        };
        replaceShape(drawingShape.pageIndex, shapeFromEndpoints(shape, drawingShape.start, end));
      } else if (shape && pageSize && !isLinearShape(shape) && (shape.width < 3 || shape.height < 3)) {
        const preferredSize = shape.type === 'check' || shape.type === 'cross' ? 48 : 120;
        const defaultSize = Math.min(preferredSize, pageSize.width / 4, pageSize.height / 4);
        replaceShape(drawingShape.pageIndex, {
          ...shape,
          x: clamp(drawingShape.start.x, 0, pageSize.width - defaultSize),
          y: clamp(drawingShape.start.y, 0, pageSize.height - defaultSize),
          width: defaultSize,
          height: defaultSize
        });
      }
      drawingShape = null;
      shapeGuides = null;
      activeTool = 'select';
    }
    if (shapeInteraction && event.pointerId === shapeInteraction.pointerId) {
      shapeInteraction = null;
      shapeGuides = null;
    }
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
    shapes = {};
    selectedShape = null;
    drawingShape = null;
    shapeInteraction = null;
    shapeGuides = null;
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
    const strokes = Object.entries(annotations).flatMap(([page, pageStrokes]) => {
      const pageSize = pageSizes[Number(page)];
      if (!pageSize?.width || !pageSize.height) return [];
      return pageStrokes
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
    const exportedShapes = Object.entries(shapes).flatMap(([page, pageShapes]) => {
      const pageSize = pageSizes[Number(page)];
      if (!pageSize?.width || !pageSize.height) return [];
      return pageShapes.map((shape) => {
        return {
          page: Number(page),
          type: shape.type,
          x: shape.x / pageSize.width,
          y: shape.y / pageSize.height,
          width: shape.width / pageSize.width,
          height: shape.height / pageSize.height,
          rotation: shape.rotation,
          radiusX: 0,
          radiusY: 0
        };
      });
    });
    return [...strokes, ...exportedShapes];
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
    class:shape-mode={SHAPE_TOOLS.has(activeTool)}
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
        {@const currentSelection = selectedShape?.pageIndex === index ? (shapes[index] ?? []).find((shape) => shape.id === selectedShape?.id) ?? null : null}
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
            class="annotation-layer shape-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-label={`Shapes on page ${index + 1}`}
          >
            {#each (shapes[index] ?? []) as shape (shape.id)}
              <g transform={`rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`}>
                {#if shape.type === 'rectangle'}
                  <rect
                    class="pdf-shape"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                    rx="0"
                  />
                {:else if shape.type === 'circle'}
                  <ellipse
                    class="pdf-shape"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    cx={shape.x + shape.width / 2}
                    cy={shape.y + shape.height / 2}
                    rx={shape.width / 2}
                    ry={shape.height / 2}
                  />
                {:else if shape.type === 'check'}
                  <polyline
                    class="pdf-shape shape-symbol"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    points={`${shape.x + shape.width * 0.08},${shape.y + shape.height * 0.54} ${shape.x + shape.width * 0.38},${shape.y + shape.height * 0.82} ${shape.x + shape.width * 0.92},${shape.y + shape.height * 0.16}`}
                  />
                {:else if shape.type === 'cross'}
                  <g data-shape-id={shape.id} data-shape-page={index}>
                    <line class="pdf-shape shape-symbol" x1={shape.x + shape.width * 0.14} y1={shape.y + shape.height * 0.14} x2={shape.x + shape.width * 0.86} y2={shape.y + shape.height * 0.86} />
                    <line class="pdf-shape shape-symbol" x1={shape.x + shape.width * 0.86} y1={shape.y + shape.height * 0.14} x2={shape.x + shape.width * 0.14} y2={shape.y + shape.height * 0.86} />
                  </g>
                {:else if shape.type === 'line'}
                  <line
                    class="shape-linear-hit"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    x1={shape.x}
                    y1={shape.y + shape.height / 2}
                    x2={shape.x + shape.width}
                    y2={shape.y + shape.height / 2}
                  />
                  <line
                    class="pdf-shape shape-linear"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    x1={shape.x}
                    y1={shape.y + shape.height / 2}
                    x2={shape.x + shape.width}
                    y2={shape.y + shape.height / 2}
                  />
                {:else if shape.type === 'arrow'}
                  <line
                    class="shape-linear-hit"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    x1={shape.x}
                    y1={shape.y + shape.height / 2}
                    x2={shape.x + shape.width}
                    y2={shape.y + shape.height / 2}
                  />
                  <line
                    class="pdf-shape shape-linear"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    x1={shape.x}
                    y1={shape.y + shape.height / 2}
                    x2={shape.x + shape.width}
                    y2={shape.y + shape.height / 2}
                  />
                  <polyline
                    class="pdf-shape shape-arrowhead"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    points={`${shape.x + shape.width - Math.min(16, Math.max(8, shape.width * 0.16))},${shape.y + shape.height / 2 - Math.min(7, Math.max(4, shape.width * 0.07))} ${shape.x + shape.width},${shape.y + shape.height / 2} ${shape.x + shape.width - Math.min(16, Math.max(8, shape.width * 0.16))},${shape.y + shape.height / 2 + Math.min(7, Math.max(4, shape.width * 0.07))}`}
                  />
                {:else}
                  <polygon
                    class="pdf-shape"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    points={`${shape.x + shape.width / 2},${shape.y} ${shape.x + shape.width},${shape.y + shape.height} ${shape.x},${shape.y + shape.height}`}
                  />
                {/if}
              </g>
            {/each}
          </svg>
          {#if currentSelection}
            <svg
              class="annotation-layer shape-selection-layer"
              viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
              preserveAspectRatio="none"
              style:--shape-ui-scale={1 / zoomLevel}
              aria-label={`Selected ${currentSelection.type}`}
            >
              {#if shapeGuides?.pageIndex === index}
                {@const guideSegments = shapeGuideSegments(shapeGuides.shape, pageSizes[index] ?? { width: 1, height: 1 })}
                <line
                  class="shape-guide"
                  x1={guideSegments.vertical.x}
                  x2={guideSegments.vertical.x}
                  y1={guideSegments.vertical.edge}
                  y2={guideSegments.vertical.shape}
                />
                <line
                  class="shape-guide"
                  x1={guideSegments.horizontal.edge}
                  x2={guideSegments.horizontal.shape}
                  y1={guideSegments.horizontal.y}
                  y2={guideSegments.horizontal.y}
                />
              {/if}
              <g transform={`rotate(${currentSelection.rotation} ${currentSelection.x + currentSelection.width / 2} ${currentSelection.y + currentSelection.height / 2})`}>
                {#if isLinearShape(currentSelection)}
                  <line
                    class="linear-selection-line"
                    x1={currentSelection.x}
                    y1={currentSelection.y + currentSelection.height / 2}
                    x2={currentSelection.x + currentSelection.width}
                    y2={currentSelection.y + currentSelection.height / 2}
                  />
                  <line
                    class="linear-selection-hit"
                    data-shape-id={currentSelection.id}
                    data-shape-page={index}
                    x1={currentSelection.x}
                    y1={currentSelection.y + currentSelection.height / 2}
                    x2={currentSelection.x + currentSelection.width}
                    y2={currentSelection.y + currentSelection.height / 2}
                  />
                  {#each [
                    ['start', currentSelection.x],
                    ['end', currentSelection.x + currentSelection.width]
                  ] as endpoint}
                    {@const endpointSize = 8 / zoomLevel}
                    <rect
                      class="linear-endpoint-handle"
                      data-shape-id={currentSelection.id}
                      data-shape-page={index}
                      data-shape-endpoint={endpoint[0]}
                      x={Number(endpoint[1]) - endpointSize / 2}
                      y={currentSelection.y + currentSelection.height / 2 - endpointSize / 2}
                      width={endpointSize}
                      height={endpointSize}
                    />
                  {/each}
                {:else}
                <rect
                  class="shape-selection-box"
                  x={currentSelection.x}
                  y={currentSelection.y}
                  width={currentSelection.width}
                  height={currentSelection.height}
                />
                <line
                  class="shape-edge-handle"
                  data-shape-id={currentSelection.id}
                  data-shape-page={index}
                  data-shape-handle="0,-1"
                  x1={currentSelection.x}
                  x2={currentSelection.x + currentSelection.width}
                  y1={currentSelection.y}
                  y2={currentSelection.y}
                  stroke-width={14 / zoomLevel}
                />
                <line
                  class="shape-edge-handle"
                  data-shape-id={currentSelection.id}
                  data-shape-page={index}
                  data-shape-handle="0,1"
                  x1={currentSelection.x}
                  x2={currentSelection.x + currentSelection.width}
                  y1={currentSelection.y + currentSelection.height}
                  y2={currentSelection.y + currentSelection.height}
                  stroke-width={14 / zoomLevel}
                />
                <line
                  class="shape-edge-handle"
                  data-shape-id={currentSelection.id}
                  data-shape-page={index}
                  data-shape-handle="-1,0"
                  x1={currentSelection.x}
                  x2={currentSelection.x}
                  y1={currentSelection.y}
                  y2={currentSelection.y + currentSelection.height}
                  stroke-width={14 / zoomLevel}
                />
                <line
                  class="shape-edge-handle"
                  data-shape-id={currentSelection.id}
                  data-shape-page={index}
                  data-shape-handle="1,0"
                  x1={currentSelection.x + currentSelection.width}
                  x2={currentSelection.x + currentSelection.width}
                  y1={currentSelection.y}
                  y2={currentSelection.y + currentSelection.height}
                  stroke-width={14 / zoomLevel}
                />
                {#each [
                  [-1, -1], [1, -1], [-1, 1], [1, 1]
                ] as handle}
                  {@const handleSize = 8 / zoomLevel}
                  {@const handleX = currentSelection.x + ((handle[0] + 1) * currentSelection.width) / 2}
                  {@const handleY = currentSelection.y + ((handle[1] + 1) * currentSelection.height) / 2}
                  <rect
                    class="shape-resize-handle handle-{handle[0]}-{handle[1]}"
                    data-shape-id={currentSelection.id}
                    data-shape-page={index}
                    data-shape-handle={`${handle[0]},${handle[1]}`}
                    x={handleX - handleSize / 2}
                    y={handleY - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    stroke-width={2 / zoomLevel}
                  />
                {/each}
                {#each [[-1, -1], [1, -1], [-1, 1], [1, 1]] as corner}
                  <circle
                    class="shape-rotate-zone"
                    data-shape-id={currentSelection.id}
                    data-shape-page={index}
                    data-shape-rotate
                    cx={currentSelection.x + (corner[0] < 0 ? -15 / zoomLevel : currentSelection.width + 15 / zoomLevel)}
                    cy={currentSelection.y + (corner[1] < 0 ? -15 / zoomLevel : currentSelection.height + 15 / zoomLevel)}
                    r={10 / zoomLevel}
                  />
                {/each}
                {#if currentSelection}
                  {@const badgeLabel = `${Math.round(currentSelection.width)} × ${Math.round(currentSelection.height)}`}
                  {@const badgeWidth = Math.max(54, badgeLabel.length * 7 + 8) / zoomLevel}
                  {@const badgeHeight = 20 / zoomLevel}
                  {@const badgeX = currentSelection.x + currentSelection.width / 2 - badgeWidth / 2}
                  {@const badgeY = currentSelection.y + currentSelection.height + 10 / zoomLevel}
                  <g class="shape-size-badge">
                    <rect x={badgeX} y={badgeY} width={badgeWidth} height={badgeHeight} rx={3 / zoomLevel} />
                    <text
                      x={badgeX + badgeWidth / 2}
                      y={badgeY + badgeHeight / 2}
                      font-size={14 / zoomLevel}
                    >{badgeLabel}</text>
                  </g>
                {/if}
                {/if}
              </g>
            </svg>
          {/if}
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

  .pdf-viewer.shape-mode {
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
    z-index: 4;
  }

  .shape-layer {
    z-index: 3;
  }

  .pdf-shape {
    fill: #ff4d55;
    stroke: #de3542;
    stroke-width: 1.35px;
    stroke-linejoin: round;
    pointer-events: visiblePainted;
  }

  .shape-symbol {
    fill: none;
    stroke: #ff4d55;
    stroke-width: 1.7px;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: visibleStroke;
  }

  .shape-linear {
    fill: none;
    stroke: #ff4d55;
    stroke-width: 1.4px;
    stroke-linecap: round;
    pointer-events: none;
  }

  .shape-arrowhead {
    fill: none;
    stroke: #ff4d55;
    stroke-width: 1.4px;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: visibleStroke;
  }

  .shape-linear-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 16px;
    pointer-events: stroke;
    cursor: move;
  }

  .pdf-viewer:not(.shape-mode):not(.drawing-mode):not(.eraser-mode) .pdf-shape {
    cursor: move;
  }

  .shape-selection-layer {
    z-index: 5;
    overflow: visible;
  }

  .shape-selection-box,
  .shape-guide {
    fill: none;
    stroke: #0d99ff;
    stroke-width: calc(2px * var(--shape-ui-scale));
  }

  .linear-selection-line {
    fill: none;
    stroke: #0d99ff;
    stroke-width: calc(2px * var(--shape-ui-scale));
    pointer-events: none;
  }

  .linear-selection-hit {
    fill: none;
    stroke: transparent;
    stroke-width: calc(14px * var(--shape-ui-scale));
    pointer-events: stroke;
    cursor: move;
  }

  .linear-endpoint-handle {
    fill: #fff;
    stroke: #0d99ff;
    stroke-width: calc(2px * var(--shape-ui-scale));
    pointer-events: all;
    cursor: crosshair;
  }

  .shape-selection-box {
    pointer-events: none;
  }

  .shape-edge-handle {
    fill: none;
    stroke: transparent;
    stroke-width: calc(14px * var(--shape-ui-scale));
    pointer-events: stroke;
  }

  .shape-edge-handle[data-shape-handle='0,-1'],
  .shape-edge-handle[data-shape-handle='0,1'] {
    cursor: ns-resize;
  }

  .shape-edge-handle[data-shape-handle='-1,0'],
  .shape-edge-handle[data-shape-handle='1,0'] {
    cursor: ew-resize;
  }

  .shape-guide {
    stroke-width: calc(1.15px * var(--shape-ui-scale));
    stroke-dasharray: calc(3px * var(--shape-ui-scale)) calc(4px * var(--shape-ui-scale));
    opacity: 0.68;
  }

  .shape-resize-handle {
    fill: #fff;
    stroke: #0d99ff;
    stroke-width: calc(2px * var(--shape-ui-scale));
    pointer-events: all;
  }

  .shape-resize-handle[data-shape-handle='-1,-1'],
  .shape-resize-handle[data-shape-handle='1,1'] {
    cursor: nwse-resize;
  }

  .shape-resize-handle[data-shape-handle='1,-1'],
  .shape-resize-handle[data-shape-handle='-1,1'] {
    cursor: nesw-resize;
  }

  .shape-rotate-zone {
    fill: transparent;
    stroke: none;
    cursor: url('/rotate-cursor.svg') 16 16, crosshair;
    pointer-events: all;
  }

  .shape-size-badge {
    pointer-events: none;
  }

  .shape-size-badge rect {
    fill: #0d99ff;
  }

  .shape-size-badge text {
    fill: #fff;
    font-family: Inter, sans-serif;
    font-weight: 500;
    dominant-baseline: central;
    text-anchor: middle;
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
  .pdf-viewer.shape-mode :global(.textLayer span),
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
