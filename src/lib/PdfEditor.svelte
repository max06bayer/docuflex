<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { flip } from 'svelte/animate';
  import { fade, fly, scale } from 'svelte/transition';
  import EditorToolbar from '$lib/EditorToolbar.svelte';
  import HtmlPdfEditor from '$lib/HtmlPdfEditor.svelte';

  /** @typedef {{ x: number; y: number; pressure: number }} StrokePoint */
  /** @typedef {{ id: number; type: 'marker' | 'pen'; points: StrokePoint[]; rawPoints?: StrokePoint[]; color?: string; thickness?: number; opacity?: number; falloff?: number; smoothing?: number }} AnnotationStroke */
  /** @typedef {{ start: number; end: number; color?: string; fontFamily?: string; fontSize?: number; fontWeight?: number; letterSpacing?: number; textAlign?: 'left' | 'center' | 'right'; italic?: boolean; underline?: boolean; strikethrough?: boolean }} TextStyleRange */
  /** @typedef {{ id: number; type: 'triangle' | 'rectangle' | 'circle' | 'check' | 'cross' | 'arrow' | 'line' | 'measure' | 'crop' | 'textfield' | 'signature' | 'image' | 'checkbox' | 'input'; x: number; y: number; width: number; height: number; rotation: number; text?: string; textColor?: string; fontFamily?: string; fontSize?: number; fontWeight?: number; letterSpacing?: number; lineHeight?: number; textAlign?: 'left' | 'center' | 'right'; verticalAlign?: 'top' | 'middle' | 'bottom'; italic?: boolean; underline?: boolean; strikethrough?: boolean; textStyleRanges?: TextStyleRange[]; imageData?: string; fieldName?: string; fieldValue?: string | boolean; existingField?: boolean; readOnly?: boolean; opacity?: number; cornerRadius?: number; fillPresent?: boolean; fillEnabled?: boolean; fillColor?: string; fillAlpha?: number; strokePresent?: boolean; strokeEnabled?: boolean; strokeColor?: string; strokeAlpha?: number; strokeWidth?: number; shadowPresent?: boolean; shadowEnabled?: boolean; shadowOpacity?: number; shadowBlur?: number; shadowX?: number; shadowY?: number; backgroundBlurPresent?: boolean; backgroundBlurEnabled?: boolean; backgroundBlur?: number }} AnnotationShape */
  /** @typedef {{ id: number; type: 'highlight' | 'underline' | 'crossout' | 'blackout' | 'whiteout'; rects: { x: number; y: number; width: number; height: number; color?: [number, number, number]; thickness?: number }[] }} TextHighlight */

  /** @type {File} */
  export let file;
  /** @type {{ enabled: boolean; password: string }} */
  export let protection = { enabled: false, password: '' };
  /** @type {(protection: { enabled: boolean; password: string }) => void} */
  export let onProtectionChange = () => {};
  /** @type {() => void} */
  export let onRequestClose = () => {};
  /** @type {string} */
  export let initialTool = 'select';
  let workingFile = file;

  /** @type {HTMLDivElement | undefined} */
  let viewer;
  /** @type {HTMLElement | undefined} */
  let workspace;
  /** @type {import('pdfjs-dist').PDFDocumentProxy | null} */
  let pdfDocument = null;
  /** @type {import('pdfjs-dist').PDFDocumentLoadingTask | null} */
  let pdfLoadingTask = null;
  let pageCount = 0;
  /** @type {Set<number>} */
  let selectedPages = new Set();
  /** @type {number | null} */
  let selectionAnchor = null;
  /** @type {{ x: number; y: number; pageIndex: number } | null} */
  let pageContextMenu = null;
  /** @type {{ pdfBase64: string; annotations: AnnotationStroke[][]; shapes: AnnotationShape[][]; textHighlights: TextHighlight[][] } | null} */
  let pageClipboard = null;
  /** @type {number[]} */
  let draggedPages = [];
  /** @type {number[]} */
  let pageDragPreviewOrder = [];
  let pageDragInsertionIndex = 0;
  /** @type {number | null} */
  let externalPdfDropIndex = null;
  /** @type {{ pointerId: number; pageIndex: number; startX: number; startY: number; clientX: number; clientY: number; offsetX: number; offsetY: number; width: number; height: number; uiScale: number; imageUrl: string; active: boolean } | null} */
  let pagePointerDrag = null;
  /** @type {(() => void) | null} */
  let pageDragCleanup = null;
  let ignoreNextPageClick = false;
  let pageOperationBusy = false;
  let status = 'Rendering PDF…';
  let loadGeneration = 0;
  /** @type {import('pdfjs-dist/web/pdf_viewer.mjs').TextLayerBuilder[]} */
  let textLayerBuilders = [];
  /** @type {AbortController | null} */
  let textLayerAbortController = null;
  let activeTool = initialTool;
  let markerColor = '#FFE43B';
  let markerThickness = 16;
  let markerOpacity = 0.34;
  let markerFalloff = 35;
  let markerStraighten = true;
  let penColor = '#E21D32';
  let penThickness = 2.05;
  let penOpacity = 0.94;
  let penSmoothing = 55;
  /** @type {any} */
  let htmlEditor;
  let htmlEditorStarted = false;
  /** @type {File | null} */
  let htmlTextEditBaseFile = null;
  /** @type {ArrayBuffer | null} */
  let workingPdfBytes = null;
  let htmlEditorReady = false;
  let htmlViewportMode = false;
  let htmlViewportVisible = false;
  let observedTool = 'select';
  let editorTransition = '';
  let editorTransitionGeneration = 0;
  let ocrTextLayerActive = false;
  let cropPagesPrepared = false;
  let searchPanelOpen = false;
  let searchQuery = '';
  /** @type {HTMLInputElement | undefined} */
  let searchInput;
  /** @type {Record<number, { x: number; y: number; width: number; height: number }[]>} */
  let searchMatches = {};
  /** @type {{ pageIndex: number; rects: { x: number; y: number; width: number; height: number }[] }[]} */
  let searchOccurrences = [];
  let activeSearchOccurrence = -1;
  /** @type {number | undefined} */
  let searchUpdateFrame;
  let watermarkPanelOpen = false;
  let watermarkText = '';
  let appliedWatermarkText = '';
  /** @type {HTMLInputElement | undefined} */
  let watermarkInput;
  /** @type {any[]} */
  let htmlVisualAnnotations = [];
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
  /** @type {Record<number, TextHighlight[]>} */
  let textHighlights = {};
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
  /** @type {Set<number>} */
  let selectedShapeIds = new Set();
  /** @type {{ pageIndex: number; x: number; y: number; width: number; height: number; rotation: number } | null} */
  let multiSelectionFrame = null;
  /** @type {{ pageIndex: number; id: number } | null} */
  let editingTextShape = null;
  let textEditorPointerActive = false;
  /** @type {{ pointerId: number; pageIndex: number; id: number; start: StrokePoint } | null} */
  let drawingShape = null;
  /** @type {any} */
  let shapeInteraction = null;
  /** @type {{ pointerId: number; pageIndex: number; id: number; clientX: number; clientY: number; start: StrokePoint } | null} */
  let pendingFormDrag = null;
  /** @type {{ pageIndex: number; x: number | null; y: number | null; shape: AnnotationShape } | null} */
  let shapeGuides = null;
  let protectPanelOpen = false;
  let encryptionEnabled = Boolean(protection?.enabled);
  let protectionPassword = protection?.password ?? '';
  let protectionConfirmPassword = '';
  let disableProtectionPassword = '';
  let showProtectionPassword = false;
  let showProtectionConfirmPassword = false;
  let showDisableProtectionPassword = false;
  let protectionError = '';
  let passwordUnlockOpen = false;
  let passwordUnlockValue = '';
  let passwordUnlockError = '';
  let showPasswordUnlockValue = false;
  let unlockingPdf = false;
  let signPanelOpen = false;
  let addSignaturePanelOpen = false;
  /** @type {'draw' | 'image'} */
  let signatureTab = 'image';
  /** @type {{ id: number; imageUrl: string; name: string; aspectRatio: number }[]} */
  let savedSignatures = [];
  let nextSignatureId = 1;
  let cameraCaptureOpen = false;
  let cameraError = '';
  let cameraStarting = false;
  let signatureProcessing = false;
  /** @type {MediaStream | null} */
  let cameraStream = null;
  /** @type {HTMLVideoElement | undefined} */
  let signatureCameraVideo;
  /** @type {HTMLDivElement | undefined} */
  let signatureCameraFrame;
  /** @type {HTMLInputElement | undefined} */
  let signatureUploadInput;
  /** @type {HTMLInputElement | undefined} */
  let imageUploadInput;
  let signatureDrawOpen = false;
  let signatureDrawHasInk = false;
  /** @type {HTMLCanvasElement | undefined} */
  let signatureDrawCanvas;
  /** @type {{ pointerId: number; x: number; y: number } | null} */
  let signatureDrawPointer = null;
  /** @type {ReturnType<typeof captureHistoryState>[]} */
  let undoHistory = [];
  /** @type {ReturnType<typeof captureHistoryState>[]} */
  let redoHistory = [];
  /** @type {ReturnType<typeof captureHistoryState> | null} */
  let currentHistoryState = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let historyCommitTimer;
  let applyingHistoryState = false;
  /** @type {{ pageIndex: number; id: number } | null} */
  let hoveredShape = null;
  /** @type {{ property: 'fillColor' | 'strokeColor' | 'textColor' | 'selectionHighlightColor' | 'selectionUnderlineColor' | 'selectionCrossoutColor' | 'markerColor' | 'penColor'; hue: number; saturation: number; value: number; alpha: number } | null} */
  let colorPicker = null;
  /** @type {{ pageIndex: number; id: number; start: number; end: number } | null} */
  let textFormatSelection = null;
  /** @type {{ pages: Record<number, { x: number; y: number; width: number; height: number }[]>; text: string; active: Record<string, boolean>; markIds: Record<string, { pageIndex: number; id: number }[]> } | null} */
  let pdfTextSelection = null;
  let selectionHighlightColor = '#FFE43B';
  let selectionUnderlineColor = '#171717';
  let selectionCrossoutColor = '#171717';
  let selectionUnderlineThickness = 1.5;
  let selectionCrossoutThickness = 1.5;
  /** @type {HTMLInputElement | null} */
  let inspectorXInput = null;
  /** @type {HTMLInputElement | null} */
  let inspectorYInput = null;
  /** @type {HTMLInputElement | null} */
  let inspectorWidthInput = null;
  /** @type {HTMLInputElement | null} */
  let inspectorHeightInput = null;
  /** @type {HTMLInputElement | null} */
  let inspectorRotationInput = null;

  const BASE_PAGE_SCALE = 1.55;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const CLICK_ZOOM_FACTOR = 1.25;
  const MAX_CANVAS_PIXELS = 24_000_000;
  const ERASER_RADIUS = 17;
  const SHAPE_TOOLS = new Set(['triangle', 'rectangle', 'circle', 'check', 'cross', 'arrow', 'line', 'measure', 'crop', 'textfield', 'checkbox', 'input']);
  const LINE_SHAPE_TOOLS = new Set(['arrow', 'line', 'measure']);
  const HTML_VIEW_TOOLS = new Set(['edit', 'pan', 'zoom']);
  const TEXT_MARK_TOOLS = new Set(['highlight', 'underline', 'crossout', 'blackout', 'whiteout']);
  const MIN_SHAPE_SIZE = 8;

  $: if (activeTool !== 'eraser') eraserCursorVisible = false;
  $: if (activeTool !== observedTool) {
    const previousTool = observedTool;
    observedTool = activeTool;
    void handleToolTransition(previousTool, activeTool);
  }
  $: htmlViewportVisible = htmlEditorStarted
    && htmlEditorReady
    && htmlViewportMode
    && (HTML_VIEW_TOOLS.has(activeTool) || editorTransition === 'Applying Changes to Document');
  $: {
    annotations;
    shapes;
    textHighlights;
    pageSizes;
    appliedWatermarkText;
    htmlVisualAnnotations = exportableAnnotations();
  }
  $: {
    workingFile;
    annotations;
    shapes;
    textHighlights;
    appliedWatermarkText;
    encryptionEnabled;
    protectionPassword;
    ocrTextLayerActive;
    cropPagesPrepared;
    pdfReady;
    editorTransition;
    drawingStroke;
    erasingPointerId;
    drawingShape;
    shapeInteraction;
    editingTextShape;
    scheduleHistoryCommit();
  }
  $: {
    shapes;
    selectedShape;
    multiSelectionFrame;
    const frame = inspectorFrame();
    const selected = inspectorSelection();
    syncInspectorInput(inspectorXInput, frame?.x);
    syncInspectorInput(inspectorYInput, frame?.y);
    syncInspectorInput(inspectorWidthInput, frame?.width);
    syncInspectorInput(inspectorHeightInput, frame?.height);
    syncInspectorInput(inspectorRotationInput, selected.length === 1 ? selected[0].rotation : multiSelectionFrame?.rotation);
  }

  /** @param {HTMLInputElement | null} input @param {number | undefined} value */
  function syncInspectorInput(input, value) {
    if (!input || value === undefined || document.activeElement === input) return;
    const next = String(Math.round(value));
    if (input.value !== next) input.value = next;
  }

  function captureHistoryState() {
    return {
      workingFile,
      annotations,
      shapes,
      textHighlights,
      appliedWatermarkText,
      encryptionEnabled,
      protectionPassword: encryptionEnabled ? protectionPassword : '',
      ocrTextLayerActive,
      cropPagesPrepared,
      nextAnnotationId
    };
  }

  /** @param {ReturnType<typeof captureHistoryState>} left @param {ReturnType<typeof captureHistoryState>} right */
  function sameHistoryState(left, right) {
    return left.workingFile === right.workingFile &&
      left.annotations === right.annotations &&
      left.shapes === right.shapes &&
      left.textHighlights === right.textHighlights &&
      left.appliedWatermarkText === right.appliedWatermarkText &&
      left.encryptionEnabled === right.encryptionEnabled &&
      left.protectionPassword === right.protectionPassword &&
      left.ocrTextLayerActive === right.ocrTextLayerActive &&
      left.cropPagesPrepared === right.cropPagesPrepared;
  }

  function historyInteractionActive() {
    return Boolean(editorTransition || drawingStroke || erasingPointerId !== null || drawingShape || shapeInteraction || editingTextShape);
  }

  function scheduleHistoryCommit() {
    if (typeof window === 'undefined' || applyingHistoryState || !pdfReady) return;
    if (!currentHistoryState) {
      currentHistoryState = captureHistoryState();
      return;
    }
    if (historyCommitTimer) clearTimeout(historyCommitTimer);
    historyCommitTimer = setTimeout(() => {
      historyCommitTimer = undefined;
      if (historyInteractionActive()) {
        scheduleHistoryCommit();
        return;
      }
      commitHistoryState();
    }, 120);
  }

  function commitHistoryState() {
    if (applyingHistoryState || !pdfReady) return;
    const next = captureHistoryState();
    if (!currentHistoryState) {
      currentHistoryState = next;
      return;
    }
    if (sameHistoryState(currentHistoryState, next)) return;
    undoHistory = [...undoHistory.slice(-74), currentHistoryState];
    currentHistoryState = next;
    redoHistory = [];
  }

  /** @param {ReturnType<typeof captureHistoryState>} state */
  async function restoreHistoryState(state) {
    applyingHistoryState = true;
    if (historyCommitTimer) clearTimeout(historyCommitTimer);
    historyCommitTimer = undefined;
    const fileChanged = workingFile !== state.workingFile;
    workingFile = state.workingFile;
    annotations = state.annotations;
    shapes = state.shapes;
    textHighlights = state.textHighlights;
    appliedWatermarkText = state.appliedWatermarkText;
    encryptionEnabled = state.encryptionEnabled;
    protectionPassword = state.protectionPassword;
    ocrTextLayerActive = state.ocrTextLayerActive;
    cropPagesPrepared = state.cropPagesPrepared;
    nextAnnotationId = state.nextAnnotationId;
    editingTextShape = null;
    drawingShape = null;
    drawingStroke = null;
    shapeInteraction = null;
    erasingPointerId = null;
    lastEraserPoint = null;
    selectedShape = null;
    selectedShapeIds = new Set();
    multiSelectionFrame = null;
    shapeGuides = null;
    onProtectionChange({ enabled: encryptionEnabled, password: protectionPassword });
    if (fileChanged) {
      htmlEditorStarted = false;
      htmlTextEditBaseFile = null;
      htmlEditorReady = false;
      htmlViewportMode = false;
      await loadPdf(false);
    }
    currentHistoryState = captureHistoryState();
    applyingHistoryState = false;
  }

  export async function undo() {
    if (applyingHistoryState) return;
    if (htmlViewportVisible && htmlEditor?.undo) {
      htmlEditor.undo();
      return;
    }
    if (historyCommitTimer) clearTimeout(historyCommitTimer);
    historyCommitTimer = undefined;
    commitHistoryState();
    const previous = undoHistory.at(-1);
    if (!previous || !currentHistoryState) return;
    undoHistory = undoHistory.slice(0, -1);
    redoHistory = [...redoHistory.slice(-74), currentHistoryState];
    await restoreHistoryState(previous);
  }

  export async function redo() {
    if (applyingHistoryState) return;
    if (htmlViewportVisible && htmlEditor?.redo) {
      htmlEditor.redo();
      return;
    }
    if (historyCommitTimer) clearTimeout(historyCommitTimer);
    historyCommitTimer = undefined;
    commitHistoryState();
    const next = redoHistory.at(-1);
    if (!next || !currentHistoryState) return;
    redoHistory = redoHistory.slice(0, -1);
    undoHistory = [...undoHistory.slice(-74), currentHistoryState];
    await restoreHistoryState(next);
  }

  /** @param {KeyboardEvent} event */
  function handleHistoryShortcut(event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
    const key = event.key.toLowerCase();
    const wantsUndo = key === 'z' && !event.shiftKey;
    const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
    if (!wantsUndo && !wantsRedo) return;
    event.preventDefault();
    if (wantsUndo) void undo();
    else void redo();
  }

  function isTextSelectionTool() {
    return activeTool === 'select' || TEXT_MARK_TOOLS.has(activeTool);
  }

  function htmlViewportActive() {
    return htmlViewportVisible;
  }

  /** @param {string} previousTool @param {string} nextTool */
  async function handleToolTransition(previousTool, nextTool) {
    const generation = ++editorTransitionGeneration;
    if (nextTool === 'image') {
      if (imageUploadInput) imageUploadInput.value = '';
      imageUploadInput?.click();
      activeTool = 'select';
      return;
    }
    if (nextTool === 'ocr') {
      await recognizeDocumentText();
      return;
    }
    if (nextTool === 'search') showSearchPanel();
    else if (previousTool === 'search') resetSearchPanel();
    if (nextTool === 'watermark') showWatermarkPanel();
    else if (previousTool === 'watermark') watermarkPanelOpen = false;
    if (nextTool === 'protect') protectPanelOpen = true;
    else if (previousTool === 'protect') protectPanelOpen = false;
    if (nextTool === 'sign') {
      signPanelOpen = true;
      addSignaturePanelOpen = false;
    } else if (previousTool === 'sign') {
      signPanelOpen = false;
      addSignaturePanelOpen = false;
    }
    if (nextTool === 'crop') await prepareCropTool(generation);
    else if (previousTool === 'crop') {
      if (selectedShape) setShapeSelection(selectedShape.pageIndex, []);
      shapeGuides = null;
    }
    if (nextTool === 'edit') {
      if (htmlEditorStarted && htmlEditorReady) {
        htmlViewportMode = true;
        return;
      }
      // Files restored from IndexedDB can remain backed by a temporary WebKit
      // blob resource. Safari may render that resource once, then reject a
      // second arrayBuffer() read when the text editor mounts. Build the text
      // editor's file from the durable byte snapshot retained by loadPdf().
      const textEditBytes = workingPdfBytes?.slice(0) ?? await workingFile.arrayBuffer();
      htmlTextEditBaseFile = new File([textEditBytes], workingFile.name, {
        type: workingFile.type || 'application/pdf',
        lastModified: workingFile.lastModified
      });
      editorTransition = 'Preparing Document for Editing';
      htmlEditorReady = false;
      htmlEditorStarted = true;
      htmlViewportMode = true;
      return;
    }
    if (HTML_VIEW_TOOLS.has(nextTool) && htmlEditorStarted && htmlViewportMode) return;
    if (!htmlEditorStarted || !htmlViewportMode || !HTML_VIEW_TOOLS.has(previousTool)) {
      htmlViewportMode = false;
      return;
    }

    editorTransition = 'Applying Changes to Document';
    try {
      if (htmlEditor?.resolvedTextHighlights) {
        applyResolvedTextHighlights(htmlEditor.resolvedTextHighlights());
      }
      const sourceBytes = await (htmlTextEditBaseFile ?? workingFile).arrayBuffer();
      // Capture once while the editable iframe is still visible and laid out.
      // Re-reading after the layer is hidden can lose contenteditable geometry
      // and caused textbox edits to be treated as unchanged.
      const pendingTextEdits = htmlEditor?.capturePendingTextEdits
        ? await htmlEditor.capturePendingTextEdits()
        : null;
      const appliedImageEdits = Array.isArray(pendingTextEdits)
        && pendingTextEdits.some((edit) => edit?.kind === 'image');
      const editedBytes = htmlEditor?.applyTextEdits
        ? await htmlEditor.applyTextEdits(sourceBytes, pendingTextEdits)
        : sourceBytes;
      if (generation !== editorTransitionGeneration) return;
      workingFile = new File([editedBytes], workingFile.name, {
        type: 'application/pdf',
        lastModified: Date.now()
      });
      await htmlEditor?.commitAppliedTextEdits?.(editedBytes);
      htmlViewportMode = false;
      await loadPdf(false);
      if (appliedImageEdits) {
        // The editable HTML page started from the pre-transform PDF. Rebuild it
        // from the newly saved PDF next time instead of reusing stale image
        // geometry and accidentally applying the same transform twice.
        htmlEditorStarted = false;
        htmlTextEditBaseFile = null;
        htmlEditorReady = false;
      }
      // Keep the iframe's changes cumulative against the clean baseline. This
      // avoids stacking old font, size, and decoration overlays on each pass.
    } catch (error) {
      console.error(error);
      status = error instanceof Error ? error.message : 'Could not apply the edited PDF text.';
      htmlViewportMode = false;
      htmlEditorStarted = false;
      htmlTextEditBaseFile = null;
      htmlEditorReady = false;
    } finally {
      if (generation === editorTransitionGeneration) editorTransition = '';
    }
  }

  function showSearchPanel() {
    searchPanelOpen = true;
    void tick().then(() => searchInput?.focus());
    scheduleSearchUpdate();
  }

  function resetSearchPanel() {
    searchPanelOpen = false;
    searchQuery = '';
    searchMatches = {};
    searchOccurrences = [];
    activeSearchOccurrence = -1;
    if (searchUpdateFrame !== undefined) cancelAnimationFrame(searchUpdateFrame);
    searchUpdateFrame = undefined;
  }

  function closeSearchPanel() {
    resetSearchPanel();
    if (activeTool === 'search') activeTool = 'select';
  }

  export function openSearchPanel() {
    activeTool = 'search';
    showSearchPanel();
  }

  function showWatermarkPanel() {
    watermarkPanelOpen = true;
    watermarkText = appliedWatermarkText;
    void tick().then(() => watermarkInput?.focus());
  }

  function closeWatermarkPanel() {
    watermarkPanelOpen = false;
    if (activeTool === 'watermark') activeTool = 'select';
  }

  function applyWatermark() {
    const nextWatermark = watermarkText.trim();
    if (!nextWatermark && !appliedWatermarkText) return;
    appliedWatermarkText = nextWatermark;
  }

  /** @param {string} text @param {{ width: number; height: number }} pageSize */
  function watermarkFontSize(text, pageSize) {
    const heightSize = pageSize.height * 0.135;
    const widthSize = pageSize.width * 0.78 / Math.max(1, text.length * 0.58);
    return Math.max(14, Math.min(heightSize, widthSize));
  }

  /** @param {Event} event */
  function handleSearchInput(event) {
    searchQuery = /** @type {HTMLInputElement} */ (event.currentTarget).value;
    scheduleSearchUpdate();
  }

  /** @param {KeyboardEvent} event */
  function handleSearchKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.shiftKey) previousSearchOccurrence();
    else nextSearchOccurrence();
  }

  /** @param {number} index @param {ScrollBehavior} [behavior] */
  function scrollToSearchOccurrence(index, behavior = 'smooth') {
    const occurrence = searchOccurrences[index];
    const rect = occurrence?.rects[0];
    const pageSize = occurrence ? pageSizes[occurrence.pageIndex] : null;
    const page = occurrence ? viewer?.querySelectorAll('.pdf-page')[occurrence.pageIndex] : null;
    if (!viewer || !(page instanceof HTMLElement) || !pageSize || !rect) return;

    const viewerRect = viewer.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const targetX = pageRect.left + (rect.x + rect.width / 2) * (pageRect.width / pageSize.width);
    const targetY = pageRect.top + (rect.y + rect.height / 2) * (pageRect.height / pageSize.height);
    viewer.scrollTo({
      left: Math.max(0, viewer.scrollLeft + targetX - viewerRect.left - viewer.clientWidth / 2),
      top: Math.max(0, viewer.scrollTop + targetY - viewerRect.top - viewer.clientHeight * 0.36),
      behavior
    });
  }

  function previousSearchOccurrence() {
    if (activeSearchOccurrence <= 0) return;
    activeSearchOccurrence -= 1;
    scrollToSearchOccurrence(activeSearchOccurrence);
  }

  function nextSearchOccurrence() {
    if (activeSearchOccurrence < 0 || activeSearchOccurrence >= searchOccurrences.length - 1) return;
    activeSearchOccurrence += 1;
    scrollToSearchOccurrence(activeSearchOccurrence);
  }

  function scheduleSearchUpdate() {
    if (searchUpdateFrame !== undefined) cancelAnimationFrame(searchUpdateFrame);
    searchUpdateFrame = requestAnimationFrame(() => {
      searchUpdateFrame = undefined;
      updateSearchMatches();
    });
  }

  function updateSearchMatches() {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query || !viewer) {
      searchMatches = {};
      searchOccurrences = [];
      activeSearchOccurrence = -1;
      return;
    }

    /** @type {Record<number, { x: number; y: number; width: number; height: number }[]>} */
    const nextMatches = {};
    /** @type {{ pageIndex: number; rects: { x: number; y: number; width: number; height: number }[] }[]} */
    const nextOccurrences = [];
    const pages = viewer.querySelectorAll('.pdf-page');
    pages.forEach((page, pageIndex) => {
      if (!(page instanceof HTMLElement)) return;
      const textLayer = page.querySelector('.textLayer');
      const pageSize = pageSizes[pageIndex];
      if (!(textLayer instanceof HTMLElement) || !pageSize) return;

      /** @type {{ node: Text; start: number; end: number }[]} */
      const textNodes = [];
      let pageText = '';
      /** @type {DOMRect | null} */
      let previousTextRect = null;
      let previousText = '';
      const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
      let currentNode = walker.nextNode();
      while (currentNode) {
        if (currentNode instanceof Text && currentNode.data) {
          const currentTextRect = currentNode.parentElement?.getBoundingClientRect() ?? null;
          if (previousTextRect && currentTextRect && !/\s$/.test(previousText) && !/^\s/.test(currentNode.data)) {
            const sameLine = Math.abs(
              (previousTextRect.top + previousTextRect.bottom) / 2 -
              (currentTextRect.top + currentTextRect.bottom) / 2
            ) <= Math.min(previousTextRect.height, currentTextRect.height) * 0.45;
            const visualGap = currentTextRect.left - previousTextRect.right;
            if (!sameLine || visualGap > Math.min(previousTextRect.height, currentTextRect.height) * 0.1) {
              pageText += ' ';
            }
          }
          const start = pageText.length;
          pageText += currentNode.data;
          textNodes.push({ node: currentNode, start, end: pageText.length });
          previousTextRect = currentTextRect;
          previousText = currentNode.data;
        }
        currentNode = walker.nextNode();
      }

      const normalizedText = pageText.toLocaleLowerCase();
      const pageRect = page.getBoundingClientRect();
      if (!pageRect.width || !pageRect.height) return;
      const scaleX = pageSize.width / pageRect.width;
      const scaleY = pageSize.height / pageRect.height;
      const rects = [];
      let matchStart = normalizedText.indexOf(query);
      while (matchStart !== -1) {
        const matchEnd = matchStart + query.length;
        const startNode = textNodes.find((entry) => matchStart >= entry.start && matchStart < entry.end);
        const endNode = textNodes.find((entry) => matchEnd > entry.start && matchEnd <= entry.end);
        /** @type {{ x: number; y: number; width: number; height: number }[]} */
        const occurrenceRects = [];
        if (startNode && endNode) {
          const range = document.createRange();
          range.setStart(startNode.node, matchStart - startNode.start);
          range.setEnd(endNode.node, matchEnd - endNode.start);
          for (const rangeRect of range.getClientRects()) {
            const left = Math.max(pageRect.left, rangeRect.left);
            const top = Math.max(pageRect.top, rangeRect.top);
            const right = Math.min(pageRect.right, rangeRect.right);
            const bottom = Math.min(pageRect.bottom, rangeRect.bottom);
            if (right - left < 0.5 || bottom - top < 0.5) continue;
            occurrenceRects.push({
              x: (left - pageRect.left) * scaleX,
              y: (top - pageRect.top) * scaleY,
              width: (right - left) * scaleX,
              height: (bottom - top) * scaleY
            });
          }
        }
        if (occurrenceRects.length) {
          rects.push(...occurrenceRects);
          nextOccurrences.push({ pageIndex, rects: occurrenceRects });
        }
        matchStart = normalizedText.indexOf(query, Math.max(matchStart + query.length, matchStart + 1));
      }
      if (rects.length) nextMatches[pageIndex] = rects;
    });
    searchMatches = nextMatches;
    searchOccurrences = nextOccurrences;
    activeSearchOccurrence = nextOccurrences.length ? 0 : -1;
    if (activeSearchOccurrence === 0) scrollToSearchOccurrence(0, 'auto');
  }

  async function recognizeDocumentText() {
    editorTransition = 'Recognizing Text in Document';
    try {
      const sourceBytes = await workingFile.arrayBuffer();
      const languages = navigator.language.toLowerCase().startsWith('de') ? 'deu+eng' : 'eng';
      const response = await fetch('/api/pdf/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-OCR-Languages': languages
        },
        body: sourceBytes
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `OCR failed (${response.status}).`);
      }

      const searchableBytes = await response.arrayBuffer();
      workingFile = new File([searchableBytes], workingFile.name, {
        type: 'application/pdf',
        lastModified: Date.now()
      });
      ocrTextLayerActive = true;
      htmlEditorStarted = false;
      htmlTextEditBaseFile = null;
      htmlEditorReady = false;
      htmlViewportMode = false;
      await loadPdf(false);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not recognize text in this PDF.');
    } finally {
      editorTransition = '';
      if (activeTool === 'ocr') activeTool = 'select';
    }
  }

  function handleHtmlEditorReady() {
    htmlEditorReady = true;
    if (editorTransition === 'Preparing Document for Editing') editorTransition = '';
  }

  function closeProtectPanel() {
    protectPanelOpen = false;
    protectionError = '';
    if (!encryptionEnabled) protectionPassword = '';
    protectionConfirmPassword = '';
    disableProtectionPassword = '';
    showProtectionPassword = false;
    showProtectionConfirmPassword = false;
    showDisableProtectionPassword = false;
    if (activeTool === 'protect') activeTool = 'select';
  }

  function closeSignPanel() {
    signPanelOpen = false;
    addSignaturePanelOpen = false;
    closeSignatureDrawPad();
    if (activeTool === 'sign') activeTool = 'select';
  }

  function openAddSignaturePanel() {
    signatureTab = 'image';
    cameraError = '';
    addSignaturePanelOpen = true;
  }

  function closeAddSignaturePanel() {
    addSignaturePanelOpen = false;
    closeSignatureDrawPad();
  }

  function stopSignatureCamera() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    if (signatureCameraVideo) signatureCameraVideo.srcObject = null;
  }

  function closeSignatureCamera() {
    stopSignatureCamera();
    cameraCaptureOpen = false;
    cameraStarting = false;
    cameraError = '';
  }

  async function openSignatureCamera() {
    cameraCaptureOpen = true;
    cameraStarting = true;
    cameraError = '';
    stopSignatureCamera();
    await tick();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not supported in this browser.');
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      if (!signatureCameraVideo) throw new Error('Could not initialize the camera preview.');
      signatureCameraVideo.srcObject = cameraStream;
      await signatureCameraVideo.play();
    } catch (error) {
      stopSignatureCamera();
      cameraError = error instanceof Error && error.name === 'NotAllowedError'
        ? 'Camera access was denied. Allow camera access or upload a photo instead.'
        : error instanceof Error ? error.message : 'Could not open the camera.';
    } finally {
      cameraStarting = false;
    }
  }

  async function openSignatureDrawPad() {
    signatureDrawOpen = true;
    signatureDrawHasInk = false;
    signatureDrawPointer = null;
    await tick();
    if (!signatureDrawCanvas) return;
    const rect = signatureDrawCanvas.getBoundingClientRect();
    const pixelRatio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    signatureDrawCanvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
    signatureDrawCanvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
    const context = signatureDrawCanvas.getContext('2d');
    context?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function closeSignatureDrawPad() {
    signatureDrawOpen = false;
    signatureDrawPointer = null;
  }

  function clearSignatureDrawPad() {
    if (!signatureDrawCanvas) return;
    const context = signatureDrawCanvas.getContext('2d');
    context?.clearRect(0, 0, signatureDrawCanvas.width, signatureDrawCanvas.height);
    signatureDrawHasInk = false;
    signatureDrawPointer = null;
  }

  /** @param {PointerEvent} event */
  function startSignatureDrawing(event) {
    if (!signatureDrawCanvas || event.button !== 0) return;
    const rect = signatureDrawCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    signatureDrawCanvas.setPointerCapture(event.pointerId);
    signatureDrawPointer = { pointerId: event.pointerId, x, y };
    const context = signatureDrawCanvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#111111';
    context.beginPath();
    context.arc(x, y, 1.35, 0, Math.PI * 2);
    context.fill();
    signatureDrawHasInk = true;
    event.preventDefault();
  }

  /** @param {PointerEvent} event */
  function continueSignatureDrawing(event) {
    if (!signatureDrawCanvas || !signatureDrawPointer || signatureDrawPointer.pointerId !== event.pointerId) return;
    const rect = signatureDrawCanvas.getBoundingClientRect();
    const context = signatureDrawCanvas.getContext('2d');
    if (!context) return;
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    context.strokeStyle = '#111111';
    context.lineWidth = event.pointerType === 'pen' && event.pressure > 0 ? 1.5 + event.pressure * 1.8 : 2.7;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(signatureDrawPointer.x, signatureDrawPointer.y);
    for (const point of events) {
      const x = point.clientX - rect.left;
      const y = point.clientY - rect.top;
      context.lineTo(x, y);
      signatureDrawPointer.x = x;
      signatureDrawPointer.y = y;
    }
    context.stroke();
    event.preventDefault();
  }

  /** @param {PointerEvent} event */
  function finishSignatureDrawing(event) {
    if (!signatureDrawPointer || signatureDrawPointer.pointerId !== event.pointerId) return;
    signatureDrawPointer = null;
    if (signatureDrawCanvas?.hasPointerCapture(event.pointerId)) signatureDrawCanvas.releasePointerCapture(event.pointerId);
  }

  async function saveDrawnSignature() {
    if (!signatureDrawCanvas || !signatureDrawHasInk || signatureProcessing) return;
    signatureProcessing = true;
    try {
      const extracted = await extractTransparentSignature(
        signatureDrawCanvas,
        signatureDrawCanvas.width,
        signatureDrawCanvas.height
      );
      saveExtractedSignature(extracted);
      closeSignatureDrawPad();
    } catch (error) {
      cameraError = error instanceof Error ? error.message : 'Could not save this signature.';
    } finally {
      signatureProcessing = false;
    }
  }

  /** @param {CanvasImageSource} source @param {number} sourceWidth @param {number} sourceHeight @param {{ x?: number; y?: number; width?: number; height?: number }} [crop] */
  async function extractTransparentSignature(source, sourceWidth, sourceHeight, crop = {}) {
    const cropX = crop.x ?? 0;
    const cropY = crop.y ?? 0;
    const cropWidth = crop.width ?? sourceWidth;
    const cropHeight = crop.height ?? sourceHeight;
    const scale = Math.min(1, 1600 / Math.max(cropWidth, cropHeight));
    const width = Math.max(1, Math.round(cropWidth * scale));
    const height = Math.max(1, Math.round(cropHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not process the signature image.');
    context.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const pixels = image.data;

    /** @type {number[]} */
    const edgeReds = [];
    /** @type {number[]} */
    const edgeGreens = [];
    /** @type {number[]} */
    const edgeBlues = [];
    let transparentSamples = 0;
    const edgeStep = Math.max(1, Math.floor(Math.min(width, height) / 180));
    /** @param {number} x @param {number} y */
    const samplePixel = (x, y) => {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] < 220) {
        transparentSamples += 1;
        return;
      }
      edgeReds.push(pixels[offset]);
      edgeGreens.push(pixels[offset + 1]);
      edgeBlues.push(pixels[offset + 2]);
    };
    for (let x = 0; x < width; x += edgeStep) {
      samplePixel(x, 0);
      samplePixel(x, height - 1);
    }
    for (let y = edgeStep; y < height - edgeStep; y += edgeStep) {
      samplePixel(0, y);
      samplePixel(width - 1, y);
    }
    const hasSourceTransparency = transparentSamples > edgeReds.length * 0.08;
    /** @param {number[]} values */
    const median = (values) => {
      if (!values.length) return 255;
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    const background = {
      red: median(edgeReds),
      green: median(edgeGreens),
      blue: median(edgeBlues)
    };
    const backgroundLuminance = background.red * 0.2126 + background.green * 0.7152 + background.blue * 0.0722;

    const pixelCount = width * height;
    const luminance = new Float32Array(pixelCount);
    const integral = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y += 1) {
      let rowSum = 0;
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        const offset = pixelIndex * 4;
        const value = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
        luminance[pixelIndex] = value;
        rowSum += value;
        integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + rowSum;
      }
    }

    const radius = Math.max(7, Math.min(32, Math.round(Math.min(width, height) / 28)));
    const scores = new Float32Array(pixelCount);
    const inkMask = new Uint8Array(pixelCount);
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        const offset = pixelIndex * 4;
        if (hasSourceTransparency) {
          scores[pixelIndex] = pixels[offset + 3];
          inkMask[pixelIndex] = pixels[offset + 3] > 20 ? 1 : 0;
          continue;
        }
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        const stride = width + 1;
        const localSum = integral[(y1 + 1) * stride + x1 + 1] - integral[y0 * stride + x1 + 1]
          - integral[(y1 + 1) * stride + x0] + integral[y0 * stride + x0];
        const localMean = localSum / ((x1 - x0 + 1) * (y1 - y0 + 1));
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const redDelta = red - background.red;
        const greenDelta = green - background.green;
        const blueDelta = blue - background.blue;
        const colorDistance = Math.sqrt(redDelta * redDelta * 0.3 + greenDelta * greenDelta * 0.59 + blueDelta * blueDelta * 0.11);
        const localDarkness = Math.max(0, localMean - luminance[pixelIndex]);
        const backgroundDarkness = Math.max(0, backgroundLuminance - luminance[pixelIndex]);
        const blueInk = Math.max(0, (red + green) * 0.5 - blue);
        const score = Math.max(
          localDarkness * 1.9,
          backgroundDarkness * 1.05,
          blueInk * 1.55 + localDarkness * 0.45,
          colorDistance - 25
        );
        scores[pixelIndex] = score;
        inkMask[pixelIndex] = score >= 27 ? 1 : 0;
      }
    }

    // Keep handwriting-like connected components only. Large objects entering
    // from the crop edge (hands, table, shadows) are deliberately discarded.
    const visited = new Uint8Array(pixelCount);
    const kept = new Uint8Array(pixelCount);
    const minimumArea = Math.max(3, Math.round(pixelCount * 0.000004));
    const maximumArea = Math.max(80, Math.round(pixelCount * 0.11));
    /** @type {number[]} */
    const queue = [];
    for (let start = 0; start < pixelCount; start += 1) {
      if (!inkMask[start] || visited[start]) continue;
      queue.length = 0;
      queue.push(start);
      visited[start] = 1;
      /** @type {number[]} */
      const component = [];
      let componentLeft = width;
      let componentTop = height;
      let componentRight = 0;
      let componentBottom = 0;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        component.push(index);
        const x = index % width;
        const y = Math.floor(index / width);
        componentLeft = Math.min(componentLeft, x);
        componentTop = Math.min(componentTop, y);
        componentRight = Math.max(componentRight, x);
        componentBottom = Math.max(componentBottom, y);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const neighbor = ny * width + nx;
            if (inkMask[neighbor] && !visited[neighbor]) {
              visited[neighbor] = 1;
              queue.push(neighbor);
            }
          }
        }
      }
      const touchesEdge = componentLeft <= 2 || componentTop <= 2 || componentRight >= width - 3 || componentBottom >= height - 3;
      const boxArea = (componentRight - componentLeft + 1) * (componentBottom - componentTop + 1);
      const density = component.length / Math.max(1, boxArea);
      const looksLikeLargeObject = component.length > maximumArea || (boxArea > pixelCount * 0.18 && density > 0.16);
      if (!touchesEdge && !looksLikeLargeObject && component.length >= minimumArea) {
        component.forEach((index) => { kept[index] = 1; });
      }
    }

    let inkRed = 0;
    let inkGreen = 0;
    let inkBlue = 0;
    let inkSamples = 0;
    for (let index = 0; index < pixelCount; index += 1) {
      if (!kept[index] || scores[index] < (hasSourceTransparency ? 80 : 42)) continue;
      const offset = index * 4;
      inkRed += pixels[offset];
      inkGreen += pixels[offset + 1];
      inkBlue += pixels[offset + 2];
      inkSamples += 1;
    }
    if (!inkSamples) throw new Error('No signature could be detected. Use dark ink on plain white paper and keep it inside the frame.');
    let outputRed = inkRed / inkSamples;
    let outputGreen = inkGreen / inkSamples;
    let outputBlue = inkBlue / inkSamples;
    // Preserve the detected hue, but compensate for the desaturation caused by
    // paper glare and camera exposure. Neutral black ink stays neutral while
    // coloured ink becomes crisp instead of taking on a grey cast.
    let normalizedRed = outputRed / 255;
    let normalizedGreen = outputGreen / 255;
    let normalizedBlue = outputBlue / 255;
    const maximumChannel = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
    const minimumChannel = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
    const channelRange = maximumChannel - minimumChannel;
    const originalSaturation = maximumChannel > 0 ? channelRange / maximumChannel : 0;
    const targetSaturation = originalSaturation > 0.035
      ? Math.min(1, originalSaturation * 2.35 + 0.12)
      : 0;
    const targetValue = Math.max(0.08, Math.min(0.72, maximumChannel * 0.88));
    if (channelRange > 0.0001 && targetSaturation > 0) {
      const scale = targetValue * targetSaturation / channelRange;
      const offset = targetValue - maximumChannel * scale;
      normalizedRed = normalizedRed * scale + offset;
      normalizedGreen = normalizedGreen * scale + offset;
      normalizedBlue = normalizedBlue * scale + offset;
    } else {
      normalizedRed = targetValue;
      normalizedGreen = targetValue;
      normalizedBlue = targetValue;
    }
    outputRed = Math.round(normalizedRed * 255);
    outputGreen = Math.round(normalizedGreen * 255);
    outputBlue = Math.round(normalizedBlue * 255);

    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * 4;
        let alpha = 0;
        if (kept[index]) {
          const low = hasSourceTransparency ? 18 : 23;
          const high = hasSourceTransparency ? 130 : 51;
          alpha = Math.max(0, Math.min(1, (scores[index] - low) / (high - low)));
          alpha = alpha * alpha * (3 - 2 * alpha);
        }
        pixels[offset] = outputRed;
        pixels[offset + 1] = outputGreen;
        pixels[offset + 2] = outputBlue;
        pixels[offset + 3] = Math.round(alpha * 255);
        if (pixels[offset + 3] > 12) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
    if (right < left || bottom < top) throw new Error('No signature could be detected. Use darker ink and a plain, bright background.');
    context.putImageData(image, 0, 0);
    const padding = Math.max(4, Math.round(Math.min(width, height) * 0.025));
    left = Math.max(0, left - padding);
    top = Math.max(0, top - padding);
    right = Math.min(width - 1, right + padding);
    bottom = Math.min(height - 1, bottom + padding);
    const output = document.createElement('canvas');
    output.width = right - left + 1;
    output.height = bottom - top + 1;
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new Error('Could not create the transparent signature.');
    outputContext.drawImage(canvas, left, top, output.width, output.height, 0, 0, output.width, output.height);
    return { imageUrl: output.toDataURL('image/png'), aspectRatio: output.width / output.height };
  }

  /** @param {{ imageUrl: string; aspectRatio: number }} extracted */
  function saveExtractedSignature(extracted) {
    savedSignatures = [
      ...savedSignatures,
      {
        id: nextSignatureId++,
        imageUrl: extracted.imageUrl,
        name: `Signature ${savedSignatures.length + 1}`,
        aspectRatio: extracted.aspectRatio
      }
    ];
    persistSavedSignatures();
    addSignaturePanelOpen = false;
  }

  function persistSavedSignatures() {
    try {
      localStorage.setItem('docuflex.savedSignatures', JSON.stringify(savedSignatures.slice(-6)));
    } catch (error) {
      console.warn('Could not save signatures on this device:', error);
    }
  }

  /** @param {MouseEvent} event @param {number} id */
  function removeSavedSignature(event, id) {
    event.stopPropagation();
    savedSignatures = savedSignatures.filter((signature) => signature.id !== id);
    persistSavedSignatures();
  }

  async function captureSignaturePhoto() {
    if (!signatureCameraVideo || !signatureCameraFrame || !signatureCameraVideo.videoWidth || signatureProcessing) return;
    signatureProcessing = true;
    cameraError = '';
    try {
      const videoRect = signatureCameraVideo.getBoundingClientRect();
      const frameRect = signatureCameraFrame.getBoundingClientRect();
      const videoWidth = signatureCameraVideo.videoWidth;
      const videoHeight = signatureCameraVideo.videoHeight;
      const scale = Math.max(videoRect.width / videoWidth, videoRect.height / videoHeight);
      const visibleSourceWidth = videoRect.width / scale;
      const visibleSourceHeight = videoRect.height / scale;
      const hiddenSourceX = (videoWidth - visibleSourceWidth) / 2;
      const hiddenSourceY = (videoHeight - visibleSourceHeight) / 2;
      const crop = {
        x: hiddenSourceX + (frameRect.left - videoRect.left) / scale,
        y: hiddenSourceY + (frameRect.top - videoRect.top) / scale,
        width: frameRect.width / scale,
        height: frameRect.height / scale
      };
      const extracted = await extractTransparentSignature(signatureCameraVideo, videoWidth, videoHeight, crop);
      saveExtractedSignature(extracted);
      closeSignatureCamera();
    } catch (error) {
      cameraError = error instanceof Error ? error.message : 'Could not extract the signature.';
    } finally {
      signatureProcessing = false;
    }
  }

  function chooseSignaturePhoto() {
    signatureUploadInput?.click();
  }

  /** @param {Event} event */
  async function uploadSignaturePhoto(event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || !input.files?.[0] || signatureProcessing) return;
    const file = input.files[0];
    signatureProcessing = true;
    cameraError = '';
    try {
      const imageUrl = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.decoding = 'async';
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('Could not read this image.'));
          image.src = imageUrl;
        });
        const extracted = await extractTransparentSignature(image, image.naturalWidth, image.naturalHeight);
        saveExtractedSignature(extracted);
      } finally {
        URL.revokeObjectURL(imageUrl);
      }
    } catch (error) {
      cameraError = error instanceof Error ? error.message : 'Could not extract the signature.';
    } finally {
      input.value = '';
      signatureProcessing = false;
    }
  }

  /** @param {Event} event */
  async function importImageFile(event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return;
    const importedFile = input.files[0];
    try {
      if (!importedFile.type.startsWith('image/')) throw new Error('Choose an image file.');
      if (importedFile.size > 24 * 1024 * 1024) throw new Error('The image is too large. Choose an image under 24 MB.');
      const objectUrl = URL.createObjectURL(importedFile);
      try {
        const image = new Image();
        image.decoding = 'async';
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('Could not read this image.'));
          image.src = objectUrl;
        });
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no usable dimensions.');

        let scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
        let imageData = '';
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Could not process this image.');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          imageData = canvas.toDataURL('image/png');
          if (imageData.length <= 15 * 1024 * 1024) break;
          scale *= 0.72;
        }
        if (!imageData || imageData.length > 15 * 1024 * 1024) throw new Error('The processed image is too large.');

        const pageIndex = visibleSignaturePageIndex();
        const pageSize = pageSizes[pageIndex];
        if (!pageSize) throw new Error('No PDF page is ready for the image.');
        const aspectRatio = image.naturalWidth / image.naturalHeight;
        let width = Math.min(260, pageSize.width * 0.45);
        let height = width / aspectRatio;
        const maximumHeight = pageSize.height * 0.35;
        if (height > maximumHeight) {
          height = maximumHeight;
          width = height * aspectRatio;
        }
        const shape = /** @type {AnnotationShape} */ ({
          id: nextAnnotationId++,
          type: 'image',
          x: (pageSize.width - width) / 2,
          y: (pageSize.height - height) / 2,
          width,
          height,
          rotation: 0,
          imageData
        });
        shapes = { ...shapes, [pageIndex]: [...(shapes[pageIndex] ?? []), shape] };
        setShapeSelection(pageIndex, [shape.id]);
        shapeGuides = { pageIndex, x: pageSize.width / 2, y: pageSize.height / 2, shape };
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not import this image.');
    } finally {
      input.value = '';
    }
  }

  function visibleSignaturePageIndex() {
    if (!viewer) return 0;
    const viewerRect = viewer.getBoundingClientRect();
    const viewportCenter = viewerRect.top + viewerRect.height / 2;
    const pages = [...viewer.querySelectorAll('.pdf-page')];
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    pages.forEach((page, index) => {
      const rect = page.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    return bestIndex;
  }

  /** @param {{ imageUrl: string; aspectRatio: number }} signature */
  function insertSavedSignature(signature) {
    const pageIndex = visibleSignaturePageIndex();
    const pageSize = pageSizes[pageIndex];
    if (!pageSize) return;
    let width = Math.min(190, pageSize.width * 0.38);
    let height = width / Math.max(0.2, signature.aspectRatio);
    const maximumHeight = Math.min(120, pageSize.height * 0.2);
    if (height > maximumHeight) {
      height = maximumHeight;
      width = height * signature.aspectRatio;
    }
    const shape = /** @type {AnnotationShape} */ ({
      id: nextAnnotationId++,
      type: 'signature',
      x: (pageSize.width - width) / 2,
      y: (pageSize.height - height) / 2,
      width,
      height,
      rotation: 0,
      imageData: signature.imageUrl
    });
    shapes = { ...shapes, [pageIndex]: [...(shapes[pageIndex] ?? []), shape] };
    activeTool = 'select';
    signPanelOpen = false;
    addSignaturePanelOpen = false;
    setShapeSelection(pageIndex, [shape.id]);
    shapeGuides = { pageIndex, x: pageSize.width / 2, y: pageSize.height / 2, shape };
  }

  function submitProtection() {
    protectionError = '';
    if (encryptionEnabled) {
      if (disableProtectionPassword !== protectionPassword) {
        protectionError = 'Incorrect password.';
        return;
      }
      encryptionEnabled = false;
      protectionPassword = '';
      protectionConfirmPassword = '';
      disableProtectionPassword = '';
      showDisableProtectionPassword = false;
      onProtectionChange({ enabled: false, password: '' });
      return;
    }
    if (!protectionPassword) {
      protectionError = 'Enter a password.';
      return;
    }
    if (new TextEncoder().encode(protectionPassword).length > 32) {
      protectionError = 'Password must be 32 bytes or fewer.';
      return;
    }
    if (protectionPassword !== protectionConfirmPassword) {
      protectionError = 'Passwords do not match.';
      return;
    }
    encryptionEnabled = true;
    protectionConfirmPassword = '';
    disableProtectionPassword = '';
    showProtectionPassword = false;
    showProtectionConfirmPassword = false;
    onProtectionChange({ enabled: true, password: protectionPassword });
  }

  async function disableImportedEncryption() {
    passwordUnlockError = '';
    if (!passwordUnlockValue) {
      passwordUnlockError = 'Enter the password.';
      return;
    }
    if (unlockingPdf) return;
    unlockingPdf = true;
    try {
      const encryptedBytes = await workingFile.arrayBuffer();
      const response = await fetch('/api/pdf/decrypt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64: arrayBufferToBase64(encryptedBytes),
          password: passwordUnlockValue
        })
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? 'Incorrect password.');
      }
      const decryptedBytes = await response.arrayBuffer();
      workingFile = new File([decryptedBytes], workingFile.name, {
        type: 'application/pdf',
        lastModified: Date.now()
      });
      passwordUnlockOpen = false;
      passwordUnlockValue = '';
      passwordUnlockError = '';
      showPasswordUnlockValue = false;
      encryptionEnabled = false;
      protectionPassword = '';
      onProtectionChange({ enabled: false, password: '' });
      await loadPdf();
    } catch (error) {
      passwordUnlockError = error instanceof Error && /password/i.test(error.message)
        ? 'Incorrect password.'
        : error instanceof Error ? error.message : 'Could not decrypt this PDF.';
    } finally {
      unlockingPdf = false;
    }
  }

  onMount(() => {
    try {
      const storedSignatures = JSON.parse(localStorage.getItem('docuflex.savedSignatures') ?? '[]');
      if (Array.isArray(storedSignatures)) {
        savedSignatures = storedSignatures.filter((signature) =>
          signature && Number.isInteger(signature.id) && typeof signature.imageUrl === 'string' &&
          signature.imageUrl.startsWith('data:image/png;base64,') && Number.isFinite(signature.aspectRatio)
        ).slice(-6);
        nextSignatureId = Math.max(0, ...savedSignatures.map((signature) => signature.id)) + 1;
      }
    } catch (error) {
      console.warn('Could not restore saved signatures:', error);
    }
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
    let textSelectionStartedOnPage = false;

    /** @param {MouseEvent} event */
    function rememberTextSelectionOrigin(event) {
      const target = event.target;
      textSelectionStartedOnPage = Boolean(
        event.button === 0 &&
        isTextSelectionTool() &&
        target instanceof Element &&
        target.closest('.textLayer span')
      );
    }

    /** @param {Event} event */
    function blockExternalPdfSelection(event) {
      const target = event.target;
      if (
        !textSelectionStartedOnPage &&
        target instanceof Element &&
        (target.closest('.textLayer, .figma-color-picker, .scrubbable-number, .scrub-label'))
      ) event.preventDefault();
    }

    /** @param {MouseEvent} event */
    function blockExternalPdfSelectionDrag(event) {
      if (textSelectionStartedOnPage || (event.buttons & 1) === 0) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (!(hit instanceof Element) || !hit.closest('.textLayer')) return;
      event.preventDefault();
      const selection = window.getSelection();
      const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
      if (anchor?.closest('.textLayer')) selection?.removeAllRanges();
    }

    function clearTextSelectionOrigin() {
      textSelectionStartedOnPage = false;
    }

    /** @param {Element} target */
    function usesRotatedTextGeometry(target) {
      const page = target.closest('.pdf-page');
      const rotation = Number(page instanceof HTMLElement ? page.dataset.pageRotation : 0);
      return Number.isFinite(rotation) && ((rotation % 360) + 360) % 360 !== 0;
    }

    /** @param {MouseEvent} event */
    function beginProductionCharacterDrag(event) {
      if (!isTextSelectionTool() || event.button !== 0 || event.detail !== 1) return;
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
      // PDF.js already maps selection correctly for rotated text. The custom
      // horizontal drag correction below is only valid for unrotated pages.
      if (usesRotatedTextGeometry(target)) return;

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
      if (!productionCharacterDrag || wordDrag || (event.buttons & 1) === 0) return;
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
      productionCharacterDrag = null;
      productionDragDirection = 0;
      productionLineBounds = null;
    }

    /** @param {MouseEvent} event */
    function suppressProductionBlankDrag(event) {
      if (!isTextSelectionTool() || event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.pdf-page') && !target.closest('.textLayer span')) {
        event.preventDefault();
      }
    }

    /** @param {MouseEvent} event */
    function rememberPointerStart(event) {
      if (!isTextSelectionTool()) return;
      pointerStart = { x: event.clientX, y: event.clientY };
    }

    /** @param {MouseEvent} event */
    function beginWordDrag(event) {
      if (!isTextSelectionTool()) return;
      const target = event.target;
      if (event.detail !== 2 || !(target instanceof Element) || !target.closest('.textLayer span')) return;
      if (usesRotatedTextGeometry(target)) return;

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
      if (!isTextSelectionTool() || !wordDrag || (event.buttons & 1) === 0) return;
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
        isTextSelectionTool() &&
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
      if (target instanceof Element && target.closest('.page-context-menu')) return;
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

    /** @param {PointerEvent} event */
    function closePageContextMenu(event) {
      const target = event.target;
      if (pageContextMenu && (!(target instanceof Element) || !target.closest('.page-context-menu'))) {
        pageContextMenu = null;
      }
    }

    /** @param {KeyboardEvent} event */
    function updateZoomCursor(event) {
      if (event.key === 'Shift') zoomingOut = event.type === 'keydown';
    }

    function resetZoomCursor() {
      zoomingOut = false;
    }

    /** @param {PointerEvent} event */
    function commitTextFieldOnOutsidePointer(event) {
      if (!editingTextShape) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-text-editor], .selection-properties-panel, .figma-color-picker')
      ) return;
      commitActiveTextField();
    }

    document.addEventListener('mousedown', rememberTextSelectionOrigin, true);
    document.addEventListener('selectstart', blockExternalPdfSelection, true);
    document.addEventListener('mousemove', blockExternalPdfSelectionDrag, true);
    document.addEventListener('mousedown', beginTextSelectionCursor, true);
    document.addEventListener('mousedown', beginProductionCharacterDrag, true);
    document.addEventListener('mousedown', beginWordDrag, true);
    document.addEventListener('mousedown', rememberPointerStart);
    document.addEventListener('mousemove', extendProductionCharacterDrag);
    document.addEventListener('mousemove', extendWordDrag);
    document.addEventListener('mouseup', endTextSelectionCursor, true);
    document.addEventListener('mouseup', finishProductionCharacterDrag, true);
    document.addEventListener('mouseup', endWordDrag);
    document.addEventListener('mouseup', commitTextHighlight);
    document.addEventListener('mouseup', capturePdfTextSelection);
    document.addEventListener('mouseup', clearTextSelectionOrigin);
    document.addEventListener('dragstart', suppressProductionBlankDrag);
    document.addEventListener('click', clearPageSelection);
    document.addEventListener('pointerdown', closePageContextMenu);
    document.addEventListener('pointerdown', commitTextFieldOnOutsidePointer, true);
    window.addEventListener('keydown', handlePageMenuShortcut, true);
    window.addEventListener('keydown', updateZoomCursor);
    window.addEventListener('keydown', handleShapeKeyboard);
    window.addEventListener('keydown', handleHistoryShortcut);
    window.addEventListener('keyup', updateZoomCursor);
    window.addEventListener('blur', resetZoomCursor);
    window.addEventListener('blur', endTextSelectionCursor);
    return () => {
      document.removeEventListener('mousedown', rememberTextSelectionOrigin, true);
      document.removeEventListener('selectstart', blockExternalPdfSelection, true);
      document.removeEventListener('mousemove', blockExternalPdfSelectionDrag, true);
      document.removeEventListener('mousedown', beginTextSelectionCursor, true);
      document.removeEventListener('mousedown', beginProductionCharacterDrag, true);
      document.removeEventListener('mousedown', beginWordDrag, true);
      document.removeEventListener('mousedown', rememberPointerStart);
      document.removeEventListener('mousemove', extendProductionCharacterDrag);
      document.removeEventListener('mousemove', extendWordDrag);
      document.removeEventListener('mouseup', endTextSelectionCursor, true);
      document.removeEventListener('mouseup', finishProductionCharacterDrag, true);
      document.removeEventListener('mouseup', endWordDrag);
      document.removeEventListener('mouseup', commitTextHighlight);
      document.removeEventListener('mouseup', capturePdfTextSelection);
      document.removeEventListener('mouseup', clearTextSelectionOrigin);
      document.removeEventListener('dragstart', suppressProductionBlankDrag);
      document.removeEventListener('click', clearPageSelection);
      document.removeEventListener('pointerdown', closePageContextMenu);
      document.removeEventListener('pointerdown', commitTextFieldOnOutsidePointer, true);
      window.removeEventListener('keydown', handlePageMenuShortcut, true);
      window.removeEventListener('keydown', updateZoomCursor);
      window.removeEventListener('keydown', handleShapeKeyboard);
      window.removeEventListener('keydown', handleHistoryShortcut);
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
    // Browsers expose a macOS trackpad pinch as a Ctrl-modified wheel event,
    // while the explicit zoom shortcut uses Cmd. Pinch deltas are much
    // smaller, so keep shortcut scrolling at its original sensitivity and
    // accelerate only the native pinch gesture.
    const sensitivity = event.metaKey ? 0.002 : 0.01;
    const factor = Math.exp(-event.deltaY * deltaScale * sensitivity);
    zoomAt(zoomLevel * factor, event.clientX, event.clientY);
  }

  /** @param {{ x: number; y: number; width: number; height: number; color?: [number, number, number] }[]} rects */
  function mergeTextHighlightRects(rects) {
    const sorted = rects
      .map((rect) => ({ ...rect }))
      .sort((left, right) => left.y - right.y || left.x - right.x);
    /** @type {{ x: number; y: number; width: number; height: number; color?: [number, number, number] }[]} */
    const merged = [];
    for (const rect of sorted) {
      const previous = merged.at(-1);
      const previousCenterY = previous ? previous.y + previous.height / 2 : 0;
      const centerY = rect.y + rect.height / 2;
      const sameLine = previous && Math.abs(previousCenterY - centerY) <= Math.max(2, Math.min(previous.height, rect.height) * 0.35);
      const touchesHorizontally = previous && rect.x <= previous.x + previous.width + 3 && rect.x + rect.width >= previous.x - 3;
      const sameColor = previous && JSON.stringify(previous.color ?? null) === JSON.stringify(rect.color ?? null);
      if (sameLine && touchesHorizontally && sameColor) {
        const left = Math.min(previous.x, rect.x);
        const right = Math.max(previous.x + previous.width, rect.x + rect.width);
        const top = Math.min(previous.y, rect.y);
        const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
        previous.x = left;
        previous.y = top;
        previous.width = right - left;
        previous.height = bottom - top;
      } else {
        merged.push({ ...rect });
      }
    }
    return merged;
  }

  /** @param {DOMRect} rect @param {HTMLElement} shell */
  function selectedTextColor(rect, shell) {
    const canvas = shell.querySelector('canvas');
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    const canvasRect = canvas?.getBoundingClientRect();
    if (!canvas || !context || !canvasRect?.width || !canvasRect.height) {
      return /** @type {[number, number, number]} */ ([0, 0, 0]);
    }

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const left = Math.max(0, Math.floor((rect.left - canvasRect.left) * scaleX));
    const top = Math.max(0, Math.floor((rect.top - canvasRect.top) * scaleY));
    const width = Math.min(canvas.width - left, Math.max(1, Math.ceil(rect.width * scaleX)));
    const height = Math.min(canvas.height - top, Math.max(1, Math.ceil(rect.height * scaleY)));
    if (width <= 0 || height <= 0) return /** @type {[number, number, number]} */ ([0, 0, 0]);

    const pixels = context.getImageData(left, top, width, height).data;
    const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / 12_000)));
    /** @type {Map<string, { count: number; red: number; green: number; blue: number }>} */
    const buckets = new Map();
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const offset = (y * width + x) * 4;
        if (pixels[offset + 3] < 128) continue;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const key = `${Math.round(red / 24)}:${Math.round(green / 24)}:${Math.round(blue / 24)}`;
        const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
        bucket.count += 1;
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        buckets.set(key, bucket);
      }
    }
    const ranked = [...buckets.values()].sort((leftBucket, rightBucket) => rightBucket.count - leftBucket.count);
    const background = ranked[0];
    if (!background) return /** @type {[number, number, number]} */ ([0, 0, 0]);
    const backgroundColor = [background.red, background.green, background.blue].map((value) => value / background.count);
    const ink = ranked.slice(1).find((bucket) => {
      const color = [bucket.red, bucket.green, bucket.blue].map((value) => value / bucket.count);
      return Math.hypot(
        color[0] - backgroundColor[0],
        color[1] - backgroundColor[1],
        color[2] - backgroundColor[2]
      ) >= 42;
    });
    if (!ink) return /** @type {[number, number, number]} */ ([0, 0, 0]);
    return /** @type {[number, number, number]} */ ([ink.red, ink.green, ink.blue].map(
      (value) => Math.max(0, Math.min(1, value / ink.count / 255))
    ));
  }

  /** @param {[number, number, number] | undefined} color */
  function textMarkCssColor(color) {
    const [red, green, blue] = color ?? [0, 0, 0];
    return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
  }

  /** @param {string} value */
  function textMarkHexColor(value) {
    const normalized = value.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return /** @type {[number, number, number]} */ ([0, 0, 0]);
    return /** @type {[number, number, number]} */ ([0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255));
  }

  /** @param {[number, number, number] | undefined} color */
  function textMarkColorHex(color) {
    const values = color ?? [0, 0, 0];
    return `#${values.map((channel) => Math.round(clamp(channel, 0, 1) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  /** @param {{ x: number; y: number; width: number; height: number }} left @param {{ x: number; y: number; width: number; height: number }} right */
  function textMarkRectsMatch(left, right) {
    const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
    const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
    const smallerArea = Math.max(0.01, Math.min(left.width * left.height, right.width * right.height));
    return overlapWidth * overlapHeight / smallerArea >= 0.62;
  }

  /** @param {Record<number, { x: number; y: number; width: number; height: number }[]>} pages */
  function existingTextMarkState(pages) {
    /** @type {Record<string, boolean>} */
    const active = {};
    /** @type {Record<string, { pageIndex: number; id: number }[]>} */
    const markIds = {};
    for (const type of ['underline', 'crossout', 'highlight', 'blackout', 'whiteout']) {
      /** @type {{ pageIndex: number; id: number }[]} */
      const matches = [];
      let fullyCovered = true;
      for (const [page, selectedRects] of Object.entries(pages)) {
        const pageIndex = Number(page);
        const marks = (textHighlights[pageIndex] ?? []).filter((mark) => (mark.type ?? 'highlight') === type);
        for (const selectedRect of selectedRects) {
          const match = marks.find((mark) => mark.rects.some((rect) => textMarkRectsMatch(selectedRect, rect)));
          if (!match) {
            fullyCovered = false;
            continue;
          }
          if (!matches.some((entry) => entry.pageIndex === pageIndex && entry.id === match.id)) matches.push({ pageIndex, id: match.id });
        }
      }
      active[type] = fullyCovered && matches.length > 0;
      markIds[type] = active[type] ? matches : [];
      if (active[type] && ['underline', 'crossout', 'highlight'].includes(type)) {
        const first = matches[0];
        const mark = (textHighlights[first.pageIndex] ?? []).find((candidate) => candidate.id === first.id);
        const rect = mark?.rects[0];
        if (rect?.color) {
          if (type === 'underline') selectionUnderlineColor = textMarkColorHex(rect.color);
          else if (type === 'crossout') selectionCrossoutColor = textMarkColorHex(rect.color);
          else selectionHighlightColor = textMarkColorHex(rect.color);
        }
        if (rect?.thickness !== undefined) {
          if (type === 'underline') selectionUnderlineThickness = rect.thickness;
          else if (type === 'crossout') selectionCrossoutThickness = rect.thickness;
        }
      }
    }
    return { active, markIds };
  }

  /** @param {MouseEvent} event */
  function capturePdfTextSelection(event) {
    if (activeTool !== 'select' || !viewer) return;
    queueMicrotask(() => {
      const target = event.target;
      if (target instanceof Element && target.closest('.text-selection-panel, .figma-color-picker')) return;
      const currentViewer = viewer;
      if (!currentViewer) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        pdfTextSelection = null;
        colorPicker = null;
        return;
      }
      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      if (!ancestor?.closest('.textLayer')) return;
      const clientRects = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
      /** @type {Record<number, { x: number; y: number; width: number; height: number }[]>} */
      const pagesByIndex = {};
      [...currentViewer.querySelectorAll('.pdf-page')].forEach((shell, pageIndex) => {
        if (!(shell instanceof HTMLElement)) return;
        const pageRect = shell.getBoundingClientRect();
        const pageWidth = Number.parseFloat(shell.style.width) || shell.offsetWidth;
        const pageHeight = Number.parseFloat(shell.style.height) || shell.offsetHeight;
        const rects = clientRects.filter((rect) => {
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          return centerX >= pageRect.left && centerX <= pageRect.right && centerY >= pageRect.top && centerY <= pageRect.bottom;
        }).map((rect) => ({
          x: ((rect.left - pageRect.left) / pageRect.width) * pageWidth,
          y: ((rect.top - pageRect.top) / pageRect.height) * pageHeight,
          width: (rect.width / pageRect.width) * pageWidth,
          height: (rect.height / pageRect.height) * pageHeight
        }));
        if (rects.length) pagesByIndex[pageIndex] = mergeTextHighlightRects(rects);
      });
      if (Object.keys(pagesByIndex).length) {
        setShapeSelection(0, []);
        const existing = existingTextMarkState(pagesByIndex);
        pdfTextSelection = { pages: pagesByIndex, text: selection.toString(), ...existing };
        selection.removeAllRanges();
      }
    });
  }

  /** @param {'highlight' | 'underline' | 'crossout' | 'blackout' | 'whiteout'} type */
  function syncSelectedPdfTextMark(type) {
    if (!pdfTextSelection) return;
    const previousIds = pdfTextSelection.markIds[type] ?? [];
    for (const { pageIndex, id } of previousIds) {
      textHighlights = { ...textHighlights, [pageIndex]: (textHighlights[pageIndex] ?? []).filter((mark) => mark.id !== id) };
    }
    /** @type {{ pageIndex: number; id: number }[]} */
    const nextIds = [];
    if (!pdfTextSelection.active[type]) {
      pdfTextSelection = { ...pdfTextSelection, markIds: { ...pdfTextSelection.markIds, [type]: nextIds } };
      return;
    }
    const color = type === 'highlight' ? textMarkHexColor(selectionHighlightColor)
      : type === 'underline' ? textMarkHexColor(selectionUnderlineColor)
        : type === 'crossout' ? textMarkHexColor(selectionCrossoutColor) : undefined;
    const thickness = type === 'underline' ? selectionUnderlineThickness : type === 'crossout' ? selectionCrossoutThickness : undefined;
    for (const [page, sourceRects] of Object.entries(pdfTextSelection.pages)) {
      const pageIndex = Number(page);
      const rects = sourceRects.map((rect) => ({ ...rect, ...(color ? { color } : {}), ...(thickness !== undefined ? { thickness } : {}) }));
      const existing = textHighlights[pageIndex] ?? [];
      textHighlights = {
        ...textHighlights,
        [pageIndex]: [...existing, { id: nextAnnotationId, type, rects }]
      };
      nextIds.push({ pageIndex, id: nextAnnotationId++ });
    }
    pdfTextSelection = { ...pdfTextSelection, markIds: { ...pdfTextSelection.markIds, [type]: nextIds } };
  }

  /** @param {'highlight' | 'underline' | 'crossout' | 'blackout' | 'whiteout'} type */
  function toggleSelectedPdfTextMark(type) {
    if (!pdfTextSelection) return;
    pdfTextSelection = { ...pdfTextSelection, active: { ...pdfTextSelection.active, [type]: !pdfTextSelection.active[type] } };
    syncSelectedPdfTextMark(type);
  }

  /** @param {'underline' | 'crossout'} type @param {number} value */
  function updateSelectedPdfTextThickness(type, value) {
    const next = clamp(value, 0.5, 8);
    if (type === 'underline') selectionUnderlineThickness = next;
    else selectionCrossoutThickness = next;
    if (pdfTextSelection?.active[type]) syncSelectedPdfTextMark(type);
  }

  /** @param {'highlight' | 'underline' | 'crossout'} type @param {string} value */
  function updateSelectedPdfTextColor(type, value) {
    const color = normalizedHex(value) ?? `#${value.replace(/^#/, '')}`;
    if (type === 'highlight') selectionHighlightColor = color;
    else if (type === 'underline') selectionUnderlineColor = color;
    else selectionCrossoutColor = color;
    if (pdfTextSelection?.active[type]) syncSelectedPdfTextMark(type);
  }

  function commitTextHighlight() {
    if (!TEXT_MARK_TOOLS.has(activeTool)) return;
    const markType = /** @type {'highlight' | 'underline' | 'crossout' | 'blackout' | 'whiteout'} */ (activeTool);
    queueMicrotask(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !viewer) return;
      const range = selection.getRangeAt(0);
      const clientRects = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
      if (!clientRects.length) return;
      const pages = [...viewer.querySelectorAll('.pdf-page')];
      pages.forEach((shell, pageIndex) => {
        if (!(shell instanceof HTMLElement)) return;
        const pageRect = shell.getBoundingClientRect();
        const pageWidth = Number.parseFloat(shell.style.width) || shell.offsetWidth;
        const pageHeight = Number.parseFloat(shell.style.height) || shell.offsetHeight;
        const rects = clientRects
          .filter((rect) => {
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerX >= pageRect.left && centerX <= pageRect.right && centerY >= pageRect.top && centerY <= pageRect.bottom;
          })
          .map((rect) => ({
            x: ((rect.left - pageRect.left) / pageRect.width) * pageWidth,
            y: ((rect.top - pageRect.top) / pageRect.height) * pageHeight,
            width: (rect.width / pageRect.width) * pageWidth,
            height: (rect.height / pageRect.height) * pageHeight,
            ...(markType === 'highlight' ? { color: textMarkHexColor(selectionHighlightColor) } : {}),
            ...(markType === 'underline' ? { color: textMarkHexColor(selectionUnderlineColor), thickness: selectionUnderlineThickness } : {}),
            ...(markType === 'crossout' ? { color: textMarkHexColor(selectionCrossoutColor), thickness: selectionCrossoutThickness } : {})
          }))
          .sort((left, right) => left.y - right.y || left.x - right.x);
        const merged = mergeTextHighlightRects(rects);
        if (merged.length) {
          const existingMarks = textHighlights[pageIndex] ?? [];
          // Keep one non-overlapping rectangle set per mark type and page.
          // Repeating a selection therefore never stacks duplicate ink.
          const combinedRects = mergeTextHighlightRects([
            ...existingMarks
              .filter((mark) => (mark.type ?? 'highlight') === markType)
              .flatMap((mark) => mark.rects),
            ...merged
          ]);
          const highlight = { id: nextAnnotationId++, type: markType, rects: combinedRects };
          textHighlights = {
            ...textHighlights,
            [pageIndex]: [
              ...existingMarks.filter((mark) => (mark.type ?? 'highlight') !== markType),
              highlight
            ]
          };
        }
      });
      selection.removeAllRanges();
      viewer?.classList.remove('text-selecting');
    });
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

  /** @type {CanvasRenderingContext2D | null} */
  let textMeasureContext = null;

  /** @param {string} text */
  function textFieldTextWidth(text) {
    if (!textMeasureContext && typeof document !== 'undefined') {
      textMeasureContext = document.createElement('canvas').getContext('2d');
    }
    if (!textMeasureContext) return text.length * 8;
    textMeasureContext.font = '400 16px Helvetica, Arial, sans-serif';
    return textMeasureContext.measureText(text).width;
  }

  /** @param {string} text @param {number} width */
  function textFieldLines(text, width) {
    const availableWidth = Math.max(1, width - 12);
    /** @type {string[]} */
    const lines = [];
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      if (!paragraph) {
        lines.push('');
        continue;
      }
      let remaining = paragraph;
      while (remaining) {
        let fittingLength = 0;
        for (let index = 1; index <= remaining.length; index += 1) {
          if (textFieldTextWidth(remaining.slice(0, index)) > availableWidth) break;
          fittingLength = index;
        }
        if (fittingLength === 0) fittingLength = 1;
        if (fittingLength >= remaining.length) {
          lines.push(remaining.trimEnd());
          break;
        }
        let breakAt = remaining.lastIndexOf(' ', fittingLength - 1);
        if (breakAt <= 0) breakAt = fittingLength;
        lines.push(remaining.slice(0, breakAt).trimEnd());
        remaining = remaining.slice(breakAt).trimStart();
      }
    }
    return lines;
  }

  /** @param {AnnotationShape} shape @param {number} index */
  function resolvedTextStyle(shape, index) {
    const style = {
      color: shape.textColor ?? '#171717',
      fontFamily: shape.fontFamily ?? 'Helvetica',
      fontSize: Math.max(6, shape.fontSize ?? 16),
      fontWeight: shape.fontWeight ?? 400,
      letterSpacing: shape.letterSpacing ?? 0,
      textAlign: shape.textAlign ?? 'left',
      italic: Boolean(shape.italic),
      underline: Boolean(shape.underline),
      strikethrough: Boolean(shape.strikethrough)
    };
    for (const range of shape.textStyleRanges ?? []) {
      if (index < range.start || index >= range.end) continue;
      if (range.color) style.color = range.color;
      if (range.fontFamily) style.fontFamily = range.fontFamily;
      if (range.fontSize !== undefined) style.fontSize = range.fontSize;
      if (range.fontWeight !== undefined) style.fontWeight = range.fontWeight;
      if (range.letterSpacing !== undefined) style.letterSpacing = range.letterSpacing;
      if (range.textAlign !== undefined) style.textAlign = range.textAlign;
      if (range.italic !== undefined) style.italic = range.italic;
      if (range.underline !== undefined) style.underline = range.underline;
      if (range.strikethrough !== undefined) style.strikethrough = range.strikethrough;
    }
    return style;
  }

  /** @param {ReturnType<typeof resolvedTextStyle>} style */
  function textStyleKey(style) {
    return [style.color, style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing, style.textAlign, style.italic, style.underline, style.strikethrough].join('|');
  }

  /** @param {AnnotationShape} shape @param {number} index @param {string} character */
  function styledCharacterWidth(shape, index, character) {
    if (!textMeasureContext && typeof document !== 'undefined') textMeasureContext = document.createElement('canvas').getContext('2d');
    const style = resolvedTextStyle(shape, index);
    if (!textMeasureContext) return style.fontSize * 0.5 + style.letterSpacing;
    textMeasureContext.font = `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${textFontStack(style.fontFamily)}`;
    return textMeasureContext.measureText(character).width + style.letterSpacing;
  }

  /** @param {string | undefined} family */
  function textFontStack(family) {
    if (family === 'Arial') return 'Arial, Helvetica, sans-serif';
    if (family === 'Inter') return 'Inter Variable, Inter, Arial, sans-serif';
    if (family === 'Geist') return 'Geist Variable, Geist, Inter Variable, Arial, sans-serif';
    if (family === 'Times New Roman') return '"Times New Roman", Times, serif';
    if (family === 'Georgia') return 'Georgia, "Times New Roman", serif';
    if (family === 'Courier New') return '"Courier New", Courier, monospace';
    return 'Helvetica, Arial, sans-serif';
  }

  /** @param {AnnotationShape} shape @param {number} start @param {number} end */
  function styledTextWidth(shape, start, end) {
    let width = 0;
    for (let index = start; index < end; index += 1) width += styledCharacterWidth(shape, index, shape.text?.[index] ?? '');
    return width;
  }

  /** @param {AnnotationShape} shape */
  function styledTextFieldLines(shape) {
    const text = (shape.text ?? '').replace(/\r\n?/g, '\n');
    const availableWidth = Math.max(1, shape.width - 12);
    /** @type {{ start: number; end: number; width: number; segments: { start: number; end: number; text: string; style: ReturnType<typeof resolvedTextStyle> }[] }[]} */
    const lines = [];
    let lineStart = 0;
    let index = 0;
    let width = 0;
    let lastSpace = -1;

    /** @param {number} start @param {number} end */
    const pushLine = (start, end) => {
      while (end > start && text[end - 1] === ' ') end -= 1;
      const segments = [];
      let segmentStart = start;
      let previousKey = start < end ? textStyleKey(resolvedTextStyle(shape, start)) : '';
      for (let cursor = start + 1; cursor <= end; cursor += 1) {
        const nextKey = cursor < end ? textStyleKey(resolvedTextStyle(shape, cursor)) : '';
        if (cursor === end || nextKey !== previousKey) {
          segments.push({ start: segmentStart, end: cursor, text: text.slice(segmentStart, cursor), style: resolvedTextStyle(shape, segmentStart) });
          segmentStart = cursor;
          previousKey = nextKey;
        }
      }
      lines.push({ start, end, width: styledTextWidth(shape, start, end), segments });
    };

    while (index < text.length) {
      if (text[index] === '\n') {
        pushLine(lineStart, index);
        index += 1;
        lineStart = index;
        width = 0;
        lastSpace = -1;
        continue;
      }
      const characterWidth = styledCharacterWidth(shape, index, text[index]);
      if (width + characterWidth > availableWidth && index > lineStart) {
        const lineEnd = lastSpace >= lineStart ? lastSpace : index;
        pushLine(lineStart, lineEnd);
        index = lineEnd;
        while (index < text.length && text[index] === ' ') index += 1;
        lineStart = index;
        width = 0;
        lastSpace = -1;
        continue;
      }
      width += characterWidth;
      if (text[index] === ' ') lastSpace = index;
      index += 1;
    }
    if (lineStart <= text.length) pushLine(lineStart, text.length);
    return lines.length ? lines : [{ start: 0, end: 0, width: 0, segments: [] }];
  }

  /** @param {AnnotationShape} shape */
  function editableTextSegments(shape) {
    const text = shape.text ?? '';
    const boundaries = new Set([0, text.length]);
    for (const range of shape.textStyleRanges ?? []) {
      boundaries.add(clamp(range.start, 0, text.length));
      boundaries.add(clamp(range.end, 0, text.length));
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    return sorted.slice(0, -1).map((start, index) => ({
      text: text.slice(start, sorted[index + 1]),
      style: resolvedTextStyle(shape, start)
    })).filter((segment) => segment.text);
  }

  /** @param {AnnotationShape} shape */
  function editableTextParagraphs(shape) {
    const text = shape.text ?? '';
    const paragraphs = [];
    let start = 0;
    while (start <= text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      const boundaries = new Set([start, end]);
      for (const range of shape.textStyleRanges ?? []) {
        if (range.start > start && range.start < end) boundaries.add(range.start);
        if (range.end > start && range.end < end) boundaries.add(range.end);
      }
      const sorted = [...boundaries].sort((a, b) => a - b);
      const segments = sorted.slice(0, -1).map((segmentStart, index) => ({
        text: text.slice(segmentStart, sorted[index + 1]),
        style: resolvedTextStyle(shape, segmentStart),
        alignmentOverride: textAlignmentOverride(shape, segmentStart)
      })).filter((segment) => segment.text);
      paragraphs.push({ start, end, alignment: resolvedTextStyle(shape, start).textAlign, segments });
      if (newline < 0) break;
      start = newline + 1;
    }
    return paragraphs;
  }

  /** @param {AnnotationShape} shape @param {string} text @param {{ start: number; end: number }} range */
  function visualLineTextRange(shape, text, range) {
    const lines = styledTextFieldLines({ ...shape, text });
    const selectedLines = lines.filter((line) => line.end > range.start && line.start < range.end);
    if (!selectedLines.length) return range;
    return { start: selectedLines[0].start, end: selectedLines[selectedLines.length - 1].end };
  }

  /** @param {AnnotationShape} shape @param {number} index */
  function textAlignmentOverride(shape, index) {
    let alignment = null;
    for (const range of shape.textStyleRanges ?? []) {
      if (index >= range.start && index < range.end && range.textAlign !== undefined) alignment = range.textAlign;
    }
    return alignment;
  }

  /** @param {AnnotationShape} shape */
  function textEditorRenderKey(shape) {
    return JSON.stringify([
      shape.text,
      shape.textColor,
      shape.fontFamily,
      shape.fontSize,
      shape.fontWeight,
      shape.letterSpacing,
      shape.lineHeight,
      shape.textAlign,
      shape.verticalAlign,
      shape.italic,
      shape.underline,
      shape.strikethrough,
      shape.textStyleRanges
    ]);
  }

  /** @param {AnnotationShape} shape @param {number} lineCount */
  function textFieldStartY(shape, lineCount) {
    const fontSize = Math.max(6, shape.fontSize ?? 16);
    const lineHeight = Math.max(fontSize, shape.lineHeight ?? 19.2);
    const contentHeight = lineCount * lineHeight;
    if (shape.verticalAlign === 'middle') return (shape.height - contentHeight) / 2 + fontSize * 0.95;
    if (shape.verticalAlign === 'bottom') return shape.height - contentHeight + fontSize * 0.95 - 3;
    return fontSize * 0.95;
  }

  /** @param {number} id @param {boolean} [selectAll] */
  function focusTextEditor(id, selectAll = false) {
    const editor = viewer?.querySelector(`[data-text-editor="${id}"]`);
    if (!(editor instanceof HTMLElement)) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (!selectAll) range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** @param {number} id @param {number} start @param {number} end */
  function restoreTextEditorSelection(id, start, end) {
    const editor = viewer?.querySelector(`[data-text-editor="${id}"]`);
    if (!(editor instanceof HTMLElement)) return;
    const locate = (/** @type {number} */ target) => {
      const paragraphs = [...editor.querySelectorAll('[data-text-paragraph]')];
      const paragraph = paragraphs.find((item) => target >= Number(item.getAttribute('data-start')) && target <= Number(item.getAttribute('data-end'))) ?? paragraphs.at(-1);
      if (!(paragraph instanceof HTMLElement)) return null;
      const localTarget = clamp(target - Number(paragraph.dataset.start ?? 0), 0, paragraph.innerText.length);
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let offset = 0;
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (localTarget <= offset + length) return { node, offset: clamp(localTarget - offset, 0, length) };
        offset += length;
        node = walker.nextNode();
      }
      return { node: paragraph, offset: paragraph.childNodes.length };
    };
    const startPoint = locate(start);
    const endPoint = locate(end);
    if (!startPoint || !endPoint) return focusTextEditor(id);
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    const selection = window.getSelection();
    editor.focus({ preventScroll: true });
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /** @param {number} id @param {number} start @param {number} end @param {Partial<AnnotationShape>} changes */
  function paintTextEditorSelection(id, start, end, changes) {
    if (end <= start) return;
    restoreTextEditorSelection(id, start, end);
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const editor = viewer?.querySelector(`[data-text-editor="${id}"]`);
    if (!(editor instanceof HTMLElement) || !editor.contains(range.commonAncestorContainer)) return;
    const span = document.createElement('span');
    if (typeof changes.textColor === 'string') span.style.color = changes.textColor;
    if (typeof changes.fontFamily === 'string') span.style.fontFamily = textFontStack(changes.fontFamily);
    if (typeof changes.fontSize === 'number') span.style.fontSize = `${changes.fontSize}px`;
    if (typeof changes.fontWeight === 'number') span.style.fontWeight = String(changes.fontWeight);
    if (typeof changes.letterSpacing === 'number') span.style.letterSpacing = `${changes.letterSpacing}px`;
    if (typeof changes.italic === 'boolean') span.style.fontStyle = changes.italic ? 'italic' : 'normal';
    const current = resolvedTextStyle(findShape(selectedShape?.pageIndex ?? -1, id) ?? /** @type {AnnotationShape} */ ({}), start);
    const underline = typeof changes.underline === 'boolean' ? changes.underline : current.underline;
    const strikethrough = typeof changes.strikethrough === 'boolean' ? changes.strikethrough : current.strikethrough;
    span.style.textDecoration = `${underline ? 'underline' : ''}${underline && strikethrough ? ' ' : ''}${strikethrough ? 'line-through' : ''}` || 'none';
    span.append(range.extractContents());
    range.insertNode(span);
    range.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** @param {number} pageIndex @param {number} id */
  function openTextEditor(pageIndex, id) {
    setShapeSelection(pageIndex, [id]);
    editingTextShape = { pageIndex, id };
    tick().then(() => setTimeout(() => focusTextEditor(id), 0));
  }

  /** @param {Event} event */
  function updateTextField(event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLElement)) return;
    input.style.minHeight = `${Math.max(Number(input.dataset.minHeight) || 0, input.scrollHeight)}px`;
  }

  /** @param {Element} editor */
  function richTextEditorValue(editor) {
    return editor instanceof HTMLElement ? editor.innerText.replace(/\r/g, '') : '';
  }

  /** @param {string} previousText @param {string} nextText @param {TextStyleRange[]} ranges */
  function remapTextStyleRanges(previousText, nextText, ranges) {
    if (previousText === nextText) return ranges;
    let prefix = 0;
    while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix += 1;
    let oldEnd = previousText.length;
    let newEnd = nextText.length;
    while (oldEnd > prefix && newEnd > prefix && previousText[oldEnd - 1] === nextText[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    const delta = newEnd - oldEnd;
    return ranges.map((range) => {
      if (range.end <= prefix) return range;
      if (range.start >= oldEnd) return { ...range, start: range.start + delta, end: range.end + delta };
      return {
        ...range,
        start: Math.min(range.start, prefix),
        end: Math.max(prefix, range.end >= oldEnd ? range.end + delta : newEnd)
      };
    }).filter((range) => range.end > range.start);
  }

  function commitActiveTextField() {
    if (!editingTextShape) return;
    const { pageIndex, id } = editingTextShape;
    const input = viewer?.querySelector(`[data-text-editor="${id}"]`);
    const shape = findShape(pageIndex, id);
    if (shape && input instanceof HTMLElement) {
      const text = richTextEditorValue(input);
      replaceShape(pageIndex, {
        ...shape,
        text,
        textStyleRanges: remapTextStyleRanges(shape.text ?? '', text, shape.textStyleRanges ?? [])
      });
    }
    editingTextShape = null;
  }

  /** @param {Event} event @param {number} pageIndex @param {number} id */
  function captureTextFormatSelection(event, pageIndex, id) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLElement)) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !input.contains(selection.anchorNode) || !input.contains(selection.focusNode)) return;
    const pointOffset = (/** @type {Node} */ node, /** @type {number} */ offset) => {
      const element = node instanceof Element ? node : node.parentElement;
      const paragraph = element?.closest('[data-text-paragraph]');
      if (!(paragraph instanceof HTMLElement)) return 0;
      const before = document.createRange();
      before.selectNodeContents(paragraph);
      before.setEnd(node, offset);
      return Number(paragraph.dataset.start ?? 0) + before.toString().length;
    };
    if (!selection.anchorNode || !selection.focusNode) return;
    const anchor = pointOffset(selection.anchorNode, selection.anchorOffset);
    const focus = pointOffset(selection.focusNode, selection.focusOffset);
    textFormatSelection = { pageIndex, id, start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }

  /** @param {AnnotationShape} shape */
  function selectedTextRange(shape) {
    if (!selectedShape || !textFormatSelection || textFormatSelection.pageIndex !== selectedShape.pageIndex || textFormatSelection.id !== shape.id) return null;
    return textFormatSelection.end > textFormatSelection.start ? textFormatSelection : null;
  }

  /** @param {AnnotationShape} shape @param {'textColor' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'letterSpacing' | 'textAlign' | 'italic' | 'underline' | 'strikethrough'} property */
  function textFormattingValue(shape, property) {
    const range = selectedTextRange(shape);
    if (!range) return shape[property];
    const style = resolvedTextStyle(shape, range.start);
    if (property === 'textColor') return style.color;
    return style[property];
  }

  /** @param {Partial<AnnotationShape>} changes */
  function updateTextFormatting(changes) {
    const shape = inspectorSelection()[0];
    if (!shape || shape.type !== 'textfield' || !selectedShape) return;
    const range = selectedTextRange(shape);
    const inlineChange = ['textColor', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textAlign', 'italic', 'underline', 'strikethrough']
      .some((property) => Object.prototype.hasOwnProperty.call(changes, property));
    if (!range || !inlineChange) {
      const editor = viewer?.querySelector(`[data-text-editor="${shape.id}"]`);
      const text = editor instanceof HTMLElement ? richTextEditorValue(editor) : shape.text ?? '';
      const caret = textFormatSelection?.id === shape.id ? textFormatSelection : null;
      replaceShape(selectedShape.pageIndex, {
        ...shape,
        ...changes,
        text,
        textStyleRanges: remapTextStyleRanges(shape.text ?? '', text, shape.textStyleRanges ?? [])
      });
      if (editingTextShape?.id === shape.id) {
        tick().then(() => restoreTextEditorSelection(shape.id, caret?.start ?? text.length, caret?.end ?? text.length));
      }
      return;
    }
    const input = viewer?.querySelector(`[data-text-editor="${shape.id}"]`);
    const text = input instanceof HTMLElement ? richTextEditorValue(input) : shape.text ?? '';
    const existingRanges = remapTextStyleRanges(shape.text ?? '', text, shape.textStyleRanges ?? []);
    const formattingRange = changes.textAlign !== undefined ? visualLineTextRange(shape, text, range) : range;
    /** @type {TextStyleRange} */
    const inlineStyle = { start: formattingRange.start, end: formattingRange.end };
    if (typeof changes.textColor === 'string') inlineStyle.color = changes.textColor;
    if (typeof changes.fontFamily === 'string') inlineStyle.fontFamily = changes.fontFamily;
    if (typeof changes.fontSize === 'number') inlineStyle.fontSize = changes.fontSize;
    if (typeof changes.fontWeight === 'number') inlineStyle.fontWeight = changes.fontWeight;
    if (typeof changes.letterSpacing === 'number') inlineStyle.letterSpacing = changes.letterSpacing;
    if (changes.textAlign === 'left' || changes.textAlign === 'center' || changes.textAlign === 'right') inlineStyle.textAlign = changes.textAlign;
    if (typeof changes.italic === 'boolean') inlineStyle.italic = changes.italic;
    if (typeof changes.underline === 'boolean') inlineStyle.underline = changes.underline;
    if (typeof changes.strikethrough === 'boolean') inlineStyle.strikethrough = changes.strikethrough;
    paintTextEditorSelection(shape.id, formattingRange.start, formattingRange.end, changes);
    replaceShape(selectedShape.pageIndex, {
      ...shape,
      text,
      textStyleRanges: [...existingRanges, inlineStyle]
    });
    tick().then(() => restoreTextEditorSelection(shape.id, range.start, range.end));
  }

  /** @param {FocusEvent} event @param {number} id */
  function retainTextEditorFocus(event, id) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLElement)) return;
    setTimeout(() => {
      if (!textEditorPointerActive || editingTextShape?.id !== id || !input.isConnected || document.activeElement === input) return;
      input.focus({ preventScroll: true });
    }, 0);
  }

  /** @param {PointerEvent} event */
  function handleTextEditorPointerDown(event) {
    textEditorPointerActive = true;
    event.stopPropagation();
    setTimeout(() => (textEditorPointerActive = false), 200);
  }

  /** @param {KeyboardEvent} event */
  function handleTextFieldKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    commitActiveTextField();
  }

  /** @param {PointerEvent} event @param {number} pageIndex @param {AnnotationShape} shape */
  function handlePdfFormPointerDown(event, pageIndex, shape) {
    if (activeTool !== 'select' || shape.readOnly) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target;
    const input = target instanceof HTMLInputElement ? target : null;
    const localX = input ? event.clientX - input.getBoundingClientRect().left : 0;
    const textEnd = input && shape.type === 'input' ? textFieldTextWidth(input.value) + 16 : 0;
    const dragFromUnusedArea = shape.type === 'checkbox' || Boolean(input && localX >= Math.min(input.clientWidth - 14, textEnd));
    if (dragFromUnusedArea && viewer) {
      const shell = viewer.querySelectorAll('.pdf-page')[pageIndex];
      if (shell instanceof HTMLElement) {
        pendingFormDrag = {
          pointerId: event.pointerId,
          pageIndex,
          id: shape.id,
          clientX: event.clientX,
          clientY: event.clientY,
          start: pointOnPage(event, shell)
        };
      }
    }
    event.stopPropagation();
  }

  /** @param {Event} event @param {number} pageIndex @param {AnnotationShape} shape */
  function updatePdfFormField(event, pageIndex, shape) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    replaceShape(pageIndex, {
      ...shape,
      fieldValue: shape.type === 'checkbox' ? input.checked : input.value
    });
  }

  /** @param {MouseEvent} event @param {AnnotationShape} shape */
  function updatePdfFormCursor(event, shape) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || shape.type !== 'input') return;
    const localX = event.clientX - input.getBoundingClientRect().left;
    const textEnd = textFieldTextWidth(input.value) + 16;
    input.style.cursor = localX >= Math.min(input.clientWidth - 14, textEnd) ? 'move' : 'text';
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

  /** @param {number} cssLength */
  function measureDetails(cssLength) {
    const points = cssLength / BASE_PAGE_SCALE;
    const millimetres = points * 25.4 / 72;
    const primaryPrecision = millimetres < 10 ? 2 : 1;
    return {
      points,
      millimetres,
      primary: `${millimetres.toFixed(primaryPrecision)} mm`
    };
  }

  /** @param {number} rotation */
  function measureAngleLabel(rotation) {
    let angle = ((rotation + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(angle) < 0.05) angle = 0;
    return `${angle.toFixed(Math.abs(angle) < 10 && angle !== 0 ? 1 : 0)}°`;
  }

  /** @param {AnnotationShape} shape */
  function measureSecondaryLabel(shape) {
    const details = measureDetails(shape.width);
    return `${details.points.toFixed(1)} pt  ·  ${measureAngleLabel(shape.rotation)}`;
  }

  /** @param {number} rotation */
  function measureLabelFlip(rotation) {
    const normalized = ((rotation % 360) + 360) % 360;
    return normalized > 90 && normalized < 270 ? 180 : 0;
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

  /** @param {AnnotationShape} shape */
  function shapeVisualPoints(shape) {
    if (isLinearShape(shape)) return Object.values(linearEndpoints(shape));
    const center = shapeCenter(shape);
    const angle = (shape.rotation * Math.PI) / 180;
    return [
      [-shape.width / 2, -shape.height / 2],
      [shape.width / 2, -shape.height / 2],
      [shape.width / 2, shape.height / 2],
      [-shape.width / 2, shape.height / 2]
    ].map(([x, y]) => {
      const rotated = rotateVector(x, y, angle);
      return { x: center.x + rotated.x, y: center.y + rotated.y };
    });
  }

  /** @param {AnnotationShape[]} selected */
  function selectionBounds(selected) {
    const points = selected.flatMap(shapeVisualPoints);
    if (!points.length) return null;
    const left = Math.min(...points.map((point) => point.x));
    const right = Math.max(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const bottom = Math.max(...points.map((point) => point.y));
    return { x: left, y: top, width: Math.max(0.01, right - left), height: Math.max(0.01, bottom - top), rotation: 0 };
  }

  /** @param {number} pageIndex */
  function selectedShapesOnPage(pageIndex) {
    return (shapes[pageIndex] ?? []).filter((shape) => selectedShapeIds.has(shape.id));
  }

  function inspectorSelection() {
    return selectedShape ? selectedShapesOnPage(selectedShape.pageIndex).filter((shape) => shape.type !== 'crop') : [];
  }

  function inspectorFrame() {
    const selected = inspectorSelection();
    return selected.length === 1 ? selected[0] : selectionBounds(selected);
  }

  /** @param {AnnotationShape} shape */
  function shapeHasFill(shape) {
    return ['triangle', 'rectangle', 'circle'].includes(shape.type);
  }

  /** @param {AnnotationShape} shape */
  function shapeSupportsStroke(shape) {
    return ['triangle', 'rectangle', 'circle', 'check', 'cross', 'arrow', 'line', 'image'].includes(shape.type);
  }

  /** @param {AnnotationShape} shape @param {'fill' | 'stroke' | 'shadow' | 'backgroundBlur'} property */
  function shapePropertyPresent(shape, property) {
    if (property === 'fill') return shape.fillPresent ?? shapeHasFill(shape);
    if (property === 'stroke') return shape.strokePresent ?? shapeSupportsStroke(shape);
    if (property === 'shadow') return shape.shadowPresent ?? false;
    return shape.backgroundBlurPresent ?? false;
  }

  /** @param {AnnotationShape} shape @param {'fill' | 'stroke' | 'shadow' | 'backgroundBlur'} property */
  function shapePropertyEnabled(shape, property) {
    if (property === 'fill') return shape.fillEnabled ?? shapeHasFill(shape);
    if (property === 'stroke') return shape.strokeEnabled ?? shapeSupportsStroke(shape);
    if (property === 'shadow') return shape.shadowEnabled ?? true;
    return shape.backgroundBlurEnabled ?? true;
  }

  /** @param {AnnotationShape} shape */
  function shapeFill(shape) {
    if (!shapePropertyEnabled(shape, 'fill')) return 'transparent';
    return colorWithAlpha(shape.fillColor ?? '#ff4d55', shape.fillAlpha ?? 1);
  }

  /** @param {AnnotationShape} shape */
  function shapeStroke(shape) {
    if (!shapePropertyEnabled(shape, 'stroke')) return 'transparent';
    return colorWithAlpha(shape.strokeColor ?? (shapeHasFill(shape) ? '#de3542' : '#ff4d55'), shape.strokeAlpha ?? 1);
  }

  /** @param {AnnotationShape} shape */
  function shapeEffectStyle(shape) {
    const opacity = clamp(shape.opacity ?? 1, 0, 1);
    const shadow = shapePropertyPresent(shape, 'shadow') && shapePropertyEnabled(shape, 'shadow')
      ? `drop-shadow(${shape.shadowX ?? 0}px ${shape.shadowY ?? 3}px ${shape.shadowBlur ?? 6}px rgba(0,0,0,${clamp(shape.shadowOpacity ?? 0.25, 0, 1)}))`
      : 'none';
    return `opacity:${opacity};filter:${shadow};--shape-fill:${shapeFill(shape)};--shape-stroke:${shapeStroke(shape)};--shape-stroke-width:${Math.max(0, shape.strokeWidth ?? (shapeHasFill(shape) ? 1.35 : 1.4))}px`;
  }

  /** @param {AnnotationShape} shape */
  function shapeClipStyle(shape) {
    const radius = Math.max(0, shape.cornerRadius ?? 0);
    return radius ? `clip-path:inset(0 round ${radius}px)` : '';
  }

  /** @param {AnnotationShape} shape */
  function shapeBackdropStyle(shape) {
    const blur = Math.max(0, shape.backgroundBlur ?? 8);
    const radius = Math.max(0, shape.cornerRadius ?? 0);
    const clip = shape.type === 'circle'
      ? 'border-radius:50%'
      : shape.type === 'triangle'
        ? 'clip-path:polygon(50% 0,100% 100%,0 100%)'
        : `border-radius:${radius}px`;
    return `width:100%;height:100%;backdrop-filter:blur(${blur}px);-webkit-backdrop-filter:blur(${blur}px);${clip}`;
  }

  /** @param {string} color */
  function normalizedHex(color) {
    const value = color.trim().replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(value) ? `#${value}` : null;
  }

  /** @param {string} color @param {number} alpha */
  function colorWithAlpha(color, alpha) {
    const hex = normalizedHex(color) ?? '#000000';
    return `rgba(${Number.parseInt(hex.slice(1, 3), 16)},${Number.parseInt(hex.slice(3, 5), 16)},${Number.parseInt(hex.slice(5, 7), 16)},${clamp(alpha, 0, 1)})`;
  }

  /** @param {string} color */
  function hexToHsv(color) {
    const [red, green, blue] = normalizedRgb(color);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const delta = maximum - minimum;
    let hue = 0;
    if (delta) {
      if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
      else hue = 60 * ((red - green) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return { hue, saturation: maximum ? delta / maximum : 0, value: maximum };
  }

  /** @param {number} hue @param {number} saturation @param {number} value */
  function hsvToHex(hue, saturation, value) {
    const chroma = value * saturation;
    const section = ((hue % 360) + 360) % 360 / 60;
    const secondary = chroma * (1 - Math.abs(section % 2 - 1));
    const [red, green, blue] = section < 1 ? [chroma, secondary, 0]
      : section < 2 ? [secondary, chroma, 0]
        : section < 3 ? [0, chroma, secondary]
          : section < 4 ? [0, secondary, chroma]
            : section < 5 ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
    const match = value - chroma;
    return `#${[red, green, blue].map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  /** @param {'fillColor' | 'strokeColor' | 'textColor'} property */
  function openColorPicker(property) {
    const shape = inspectorSelection()[0];
    if (!shape) return;
    if (colorPicker?.property === property) {
      colorPicker = null;
      return;
    }
    const color = property === 'fillColor'
      ? shape.fillColor ?? '#ff4d55'
      : property === 'strokeColor'
        ? shape.strokeColor ?? (shapeHasFill(shape) ? '#de3542' : '#ff4d55')
        : String(textFormattingValue(shape, 'textColor') ?? '#171717');
    const hsv = hexToHsv(color);
    colorPicker = {
      property,
      ...hsv,
      alpha: property === 'fillColor' ? shape.fillAlpha ?? 1 : property === 'strokeColor' ? shape.strokeAlpha ?? 1 : 1
    };
  }

  /** @param {'selectionHighlightColor' | 'selectionUnderlineColor' | 'selectionCrossoutColor'} property */
  function openSelectionColorPicker(property) {
    if (colorPicker?.property === property) {
      colorPicker = null;
      return;
    }
    const color = property === 'selectionHighlightColor' ? selectionHighlightColor
      : property === 'selectionUnderlineColor' ? selectionUnderlineColor : selectionCrossoutColor;
    colorPicker = { property, ...hexToHsv(color), alpha: 1 };
  }

  /** @param {'markerColor' | 'penColor'} property */
  function openDrawingColorPicker(property) {
    if (colorPicker?.property === property) {
      colorPicker = null;
      return;
    }
    const marker = property === 'markerColor';
    colorPicker = { property, ...hexToHsv(marker ? markerColor : penColor), alpha: marker ? markerOpacity : penOpacity };
  }

  /** @param {'marker' | 'pen'} tool @param {string} value */
  function updateDrawingColor(tool, value) {
    const color = normalizedHex(value);
    if (!color) return;
    if (tool === 'marker') markerColor = color;
    else penColor = color;
    const property = tool === 'marker' ? 'markerColor' : 'penColor';
    if (colorPicker?.property === property) colorPicker = { ...colorPicker, ...hexToHsv(color) };
  }

  function applyColorPicker() {
    if (!colorPicker) return;
    const color = hsvToHex(colorPicker.hue, colorPicker.saturation, colorPicker.value);
    if (colorPicker.property === 'markerColor' || colorPicker.property === 'penColor') {
      if (colorPicker.property === 'markerColor') {
        markerColor = color;
        markerOpacity = colorPicker.alpha;
      } else {
        penColor = color;
        penOpacity = colorPicker.alpha;
      }
      return;
    }
    if (colorPicker.property.startsWith('selection')) {
      const type = colorPicker.property === 'selectionHighlightColor' ? 'highlight'
        : colorPicker.property === 'selectionUnderlineColor' ? 'underline' : 'crossout';
      updateSelectedPdfTextColor(type, color);
      return;
    }
    if (colorPicker.property === 'textColor') {
      updateTextFormatting({ textColor: color });
      return;
    }
    const alphaProperty = colorPicker.property === 'fillColor' ? 'fillAlpha' : 'strokeAlpha';
    const prefix = colorPicker.property === 'fillColor' ? 'fill' : 'stroke';
    updateSelectedShapes({
      [colorPicker.property]: color,
      [alphaProperty]: colorPicker.alpha,
      [`${prefix}Present`]: true,
      [`${prefix}Enabled`]: true
    });
  }

  /** @param {string} value */
  function setPickerHex(value) {
    if (!colorPicker) return;
    const color = normalizedHex(value);
    if (!color) return;
    colorPicker = { ...colorPicker, ...hexToHsv(color) };
    applyColorPicker();
  }

  /** @param {number} percentage */
  function setPickerAlpha(percentage) {
    if (!colorPicker || !Number.isFinite(percentage)) return;
    colorPicker = { ...colorPicker, alpha: clamp(percentage / 100, 0, 1) };
    applyColorPicker();
  }

  /** @param {PointerEvent} event @param {'saturation' | 'hue' | 'alpha'} control */
  function updateColorControl(event, control) {
    if (!colorPicker) return;
    const element = /** @type {HTMLElement} */ (event.currentTarget);
    const rect = element.getBoundingClientRect();
    element.setPointerCapture?.(event.pointerId);
    if (control === 'saturation') {
      colorPicker = {
        ...colorPicker,
        saturation: clamp((event.clientX - rect.left) / rect.width, 0, 1),
        value: 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1)
      };
    } else if (control === 'hue') {
      colorPicker = { ...colorPicker, hue: clamp((event.clientX - rect.left) / rect.width, 0, 1) * 360 };
    } else {
      colorPicker = { ...colorPicker, alpha: clamp((event.clientX - rect.left) / rect.width, 0, 1) };
    }
    applyColorPicker();
  }

  /** @param {AnnotationShape} shape */
  function roundedTrianglePath(shape) {
    const points = [
      { x: shape.x + shape.width / 2, y: shape.y },
      { x: shape.x + shape.width, y: shape.y + shape.height },
      { x: shape.x, y: shape.y + shape.height }
    ];
    const radius = Math.max(0, Math.min(shape.cornerRadius ?? 0, shape.width * 0.45, shape.height * 0.45));
    if (radius < 0.01) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y} L ${points[2].x} ${points[2].y} Z`;
    const toward = /** @param {{ x: number; y: number }} from @param {{ x: number; y: number }} to */ (from, to) => {
      const length = Math.max(0.001, Math.hypot(to.x - from.x, to.y - from.y));
      const distance = Math.min(radius, length * 0.42);
      return { x: from.x + (to.x - from.x) * distance / length, y: from.y + (to.y - from.y) * distance / length };
    };
    const incoming = points.map((point, index) => toward(point, points[(index + points.length - 1) % points.length]));
    const outgoing = points.map((point, index) => toward(point, points[(index + 1) % points.length]));
    return `M ${outgoing[0].x} ${outgoing[0].y} L ${incoming[1].x} ${incoming[1].y} Q ${points[1].x} ${points[1].y} ${outgoing[1].x} ${outgoing[1].y} L ${incoming[2].x} ${incoming[2].y} Q ${points[2].x} ${points[2].y} ${outgoing[2].x} ${outgoing[2].y} L ${incoming[0].x} ${incoming[0].y} Q ${points[0].x} ${points[0].y} ${outgoing[0].x} ${outgoing[0].y} Z`;
  }

  /** @param {string} color */
  function normalizedRgb(color) {
    const hex = normalizedHex(color) ?? '#000000';
    return [
      Number.parseInt(hex.slice(1, 3), 16) / 255,
      Number.parseInt(hex.slice(3, 5), 16) / 255,
      Number.parseInt(hex.slice(5, 7), 16) / 255
    ];
  }

  /** @param {AnnotationShape} shape */
  function shapeExportStyle(shape) {
    const fill = normalizedRgb(shape.fillColor ?? '#ff4d55');
    const stroke = normalizedRgb(shape.strokeColor ?? (shapeHasFill(shape) ? '#de3542' : '#ff4d55'));
    return [
      ...fill,
      ...stroke,
      clamp(shape.opacity ?? 1, 0, 1),
      Math.max(0, shape.strokeWidth ?? (shapeHasFill(shape) ? 1.35 : 1.4)),
      shapePropertyPresent(shape, 'fill') ? 1 : 0,
      shapePropertyEnabled(shape, 'fill') ? 1 : 0,
      shapePropertyPresent(shape, 'stroke') ? 1 : 0,
      shapePropertyEnabled(shape, 'stroke') ? 1 : 0,
      shapePropertyPresent(shape, 'shadow') ? 1 : 0,
      shapePropertyEnabled(shape, 'shadow') ? 1 : 0,
      clamp(shape.shadowOpacity ?? 0.25, 0, 1),
      Math.max(0, shape.shadowBlur ?? 6),
      shape.shadowX ?? 0,
      shape.shadowY ?? 3,
      shapePropertyPresent(shape, 'backgroundBlur') ? 1 : 0,
      shapePropertyEnabled(shape, 'backgroundBlur') ? 1 : 0,
      Math.max(0, shape.backgroundBlur ?? 8),
      clamp(shape.fillAlpha ?? 1, 0, 1),
      clamp(shape.strokeAlpha ?? 1, 0, 1)
    ];
  }

  /** @param {Partial<AnnotationShape>} changes */
  function updateSelectedShapes(changes) {
    if (!selectedShape) return;
    const selected = selectedShapesOnPage(selectedShape.pageIndex);
    replaceShapes(selectedShape.pageIndex, selected.map((shape) => ({ ...shape, ...changes })));
  }

  /**
   * Keeps a normal click editable, but turns a horizontal drag on a numeric input into Figma-style scrubbing.
   * @param {PointerEvent} event
   * @param {(value: number) => void} apply
   * @param {{ step?: number; min?: number; max?: number }} [options]
   */
  function startNumberScrub(event, apply, options = {}) {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    const input = event.currentTarget instanceof HTMLInputElement
      ? event.currentTarget
      : event.currentTarget.closest('label, .object-property-row')?.querySelector('input[type="number"]');
    if (!(input instanceof HTMLInputElement)) return;
    const startX = event.clientX;
    const startValue = Number(input.value) || 0;
    const step = options.step ?? 1;
    const precision = Math.max(0, String(step).split('.')[1]?.length ?? 0);
    let dragging = false;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    /** @param {PointerEvent} moveEvent */
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const delta = moveEvent.clientX - startX;
      if (!dragging && Math.abs(delta) < 4) return;
      if (!dragging) {
        dragging = true;
        input.blur();
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
      }
      moveEvent.preventDefault();
      let value = startValue + delta * step;
      const minimum = options.min;
      const maximum = options.max;
      if (typeof minimum === 'number' && Number.isFinite(minimum)) value = Math.max(minimum, value);
      if (typeof maximum === 'number' && Number.isFinite(maximum)) value = Math.min(maximum, value);
      value = Number(value.toFixed(precision));
      input.value = String(value);
      apply(value);
    };

    /** @param {PointerEvent} upEvent */
    const finish = (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (dragging) {
        input.addEventListener('click', (clickEvent) => clickEvent.preventDefault(), { once: true, capture: true });
      }
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  /** @param {'fillColor' | 'strokeColor'} property @param {string} value */
  function updateSelectedColor(property, value) {
    const color = normalizedHex(value);
    if (!color) return;
    const prefix = property === 'fillColor' ? 'fill' : 'stroke';
    updateSelectedShapes({ [property]: color, [`${prefix}Present`]: true, [`${prefix}Enabled`]: true });
    if (colorPicker?.property === property) colorPicker = { ...colorPicker, ...hexToHsv(color) };
  }

  /** @param {string} value */
  function updateSelectedTextColor(value) {
    const color = normalizedHex(value);
    if (!color) return;
    updateTextFormatting({ textColor: color });
    if (colorPicker?.property === 'textColor') colorPicker = { ...colorPicker, ...hexToHsv(color) };
  }

  /** @param {'fill' | 'stroke' | 'shadow' | 'backgroundBlur'} property */
  function toggleShapeProperty(property) {
    const shape = inspectorSelection()[0];
    if (!shape) return;
    updateSelectedShapes({ [`${property}Present`]: true, [`${property}Enabled`]: !shapePropertyEnabled(shape, property) });
  }

  /** @param {'x' | 'y' | 'width' | 'height' | 'rotation'} property @param {number} value */
  function updateSelectionGeometry(property, value) {
    if (!selectedShape || !Number.isFinite(value)) return;
    const pageIndex = selectedShape.pageIndex;
    const selected = selectedShapesOnPage(pageIndex);
    const frame = selectionBounds(selected);
    if (!frame || !selected.length) return;
    if (property === 'x' || property === 'y') {
      const delta = value - frame[property];
      replaceShapes(pageIndex, selected.map((shape) => ({ ...shape, [property]: shape[property] + delta })));
      return;
    }
    if (property === 'rotation') {
      const currentRotation = selected.length === 1 ? selected[0].rotation : (multiSelectionFrame?.rotation ?? 0);
      const delta = value - currentRotation;
      const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
      const radians = delta * Math.PI / 180;
      replaceShapes(pageIndex, selected.map((shape) => {
        const source = shapeCenter(shape);
        const offset = rotateVector(source.x - center.x, source.y - center.y, radians);
        return { ...shape, x: center.x + offset.x - shape.width / 2, y: center.y + offset.y - shape.height / 2, rotation: shape.rotation + delta };
      }));
      return;
    }
    const targetSize = Math.max(MIN_SHAPE_SIZE, value);
    const scaleX = property === 'width' ? targetSize / frame.width : 1;
    const scaleY = property === 'height' ? targetSize / frame.height : 1;
    replaceShapes(pageIndex, selected.map((shape) => {
      const center = shapeCenter(shape);
      return {
        ...shape,
        x: frame.x + (center.x - frame.x) * scaleX - shape.width * scaleX / 2,
        y: frame.y + (center.y - frame.y) * scaleY - shape.height * scaleY / 2,
        width: shape.width * scaleX,
        height: shape.height * scaleY
      };
    }));
  }

  function closeSelectionPanel() {
    if (selectedShape) setShapeSelection(selectedShape.pageIndex, []);
    colorPicker = null;
    shapeGuides = null;
  }

  /** @param {PointerEvent} event */
  function updateHoveredShape(event) {
    if (activeTool !== 'select' || drawingShape || shapeInteraction || pendingFormDrag) {
      hoveredShape = null;
      return;
    }
    const target = shapeTarget(event);
    const shape = target ? findShape(target.pageIndex, target.id) : null;
    if (!target || !shape || shape.type === 'crop' || shape.type === 'measure' || selectedShapeIds.has(shape.id)) {
      hoveredShape = null;
      return;
    }
    hoveredShape = { pageIndex: target.pageIndex, id: shape.id };
  }

  function handleViewerPointerLeave() {
    hideEraserCursor();
    hoveredShape = null;
  }

  /** @param {number} pageIndex @param {number[]} ids */
  function setShapeSelection(pageIndex, ids) {
    if (ids.length) pdfTextSelection = null;
    const previousKey = selectedShape ? `${selectedShape.pageIndex}:${[...selectedShapeIds].join(',')}` : '';
    const nextKey = ids.length ? `${pageIndex}:${ids.join(',')}` : '';
    if (previousKey !== nextKey) {
      colorPicker = null;
      textFormatSelection = null;
    }
    selectedShapeIds = new Set(ids);
    selectedShape = ids.length ? { pageIndex, id: ids[ids.length - 1] } : null;
    const bounds = selectionBounds(selectedShapesOnPage(pageIndex));
    multiSelectionFrame = ids.length > 1 && bounds ? { pageIndex, ...bounds } : null;
  }

  /** @param {string} base64 */
  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  /**
   * @param {number} pageIndex
   * @param {{ x: number; y: number; width: number; height: number }} bounds
   * @param {{ width: number; height: number }} oldSize
   * @param {{ width: number; height: number }} newSize
   */
  function remapPageContentToExpandedBounds(pageIndex, bounds, oldSize, newSize) {
    const offsetX = bounds.x * newSize.width;
    const offsetY = bounds.y * newSize.height;
    const scaleX = bounds.width * newSize.width / Math.max(0.001, oldSize.width);
    const scaleY = bounds.height * newSize.height / Math.max(0.001, oldSize.height);
    const transformRect = (/** @type {{ x: number; y: number; width: number; height: number }} */ rect) => ({
      ...rect,
      x: offsetX + rect.x * scaleX,
      y: offsetY + rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    });

    if (annotations[pageIndex]) {
      annotations = {
        ...annotations,
        [pageIndex]: annotations[pageIndex].map((stroke) => ({
          ...stroke,
          points: stroke.points.map((point) => ({
            ...point,
            x: offsetX + point.x * scaleX,
            y: offsetY + point.y * scaleY
          }))
        }))
      };
    }
    if (shapes[pageIndex]) {
      shapes = {
        ...shapes,
        [pageIndex]: shapes[pageIndex].map((shape) => ({
          ...shape,
          x: offsetX + shape.x * scaleX,
          y: offsetY + shape.y * scaleY,
          width: shape.width * scaleX,
          height: shape.height * scaleY
        }))
      };
    }
    if (textHighlights[pageIndex]) {
      textHighlights = {
        ...textHighlights,
        [pageIndex]: textHighlights[pageIndex].map((highlight) => ({
          ...highlight,
          rects: highlight.rects.map((rect) => transformRect(rect))
        }))
      };
    }
  }

  async function expandCroppedPagesForEditing() {
    const oldPageSizes = { ...pageSizes };
    const sourceBytes = await workingFile.arrayBuffer();
    const response = await fetch('/api/pdf/uncrop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64: arrayBufferToBase64(sourceBytes) })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.pdfBase64 || !Array.isArray(result.pages)) {
      throw new Error(result?.error ?? `Could not prepare the full page for cropping (${response.status}).`);
    }
    cropPagesPrepared = true;
    if (!result.changed) return;

    for (let pageIndex = 0; pageIndex < result.pages.length; pageIndex += 1) {
      const bounds = result.pages[pageIndex];
      const oldSize = oldPageSizes[pageIndex];
      if (!bounds?.cropped || !oldSize || bounds.width <= 0 || bounds.height <= 0) continue;
      const newSize = {
        width: oldSize.width / bounds.width,
        height: oldSize.height / bounds.height
      };
      remapPageContentToExpandedBounds(pageIndex, bounds, oldSize, newSize);
    }

    workingFile = new File([base64ToBytes(result.pdfBase64)], workingFile.name, {
      type: 'application/pdf',
      lastModified: Date.now()
    });
    htmlEditorStarted = false;
    htmlTextEditBaseFile = null;
    htmlEditorReady = false;
    htmlViewportMode = false;
    await loadPdf(false);

    const nextShapes = { ...shapes };
    for (let pageIndex = 0; pageIndex < result.pages.length; pageIndex += 1) {
      const bounds = result.pages[pageIndex];
      const pageSize = pageSizes[pageIndex];
      if (!bounds?.cropped || !pageSize) continue;
      const pageShapes = nextShapes[pageIndex] ?? [];
      if (pageShapes.some((shape) => shape.type === 'crop')) continue;
      nextShapes[pageIndex] = [...pageShapes, {
        id: nextAnnotationId++,
        type: /** @type {'crop'} */ ('crop'),
        x: bounds.x * pageSize.width,
        y: bounds.y * pageSize.height,
        width: bounds.width * pageSize.width,
        height: bounds.height * pageSize.height,
        rotation: 0
      }];
    }
    shapes = nextShapes;
  }

  /** @param {number} generation */
  async function prepareCropTool(generation) {
    let preferredPage = selectionAnchor ?? [...selectedPages][0] ?? selectedShape?.pageIndex ?? 0;
    if (!cropPagesPrepared) {
      editorTransition = 'Preparing Full Page for Cropping';
      try {
        await expandCroppedPagesForEditing();
      } catch (error) {
        console.error(error);
        window.alert(error instanceof Error ? error.message : 'Could not prepare the full page for cropping.');
      } finally {
        if (generation === editorTransitionGeneration) editorTransition = '';
      }
    }
    if (generation !== editorTransitionGeneration || activeTool !== 'crop') return;

    if (!pageSizes[preferredPage]) {
      preferredPage = Number(Object.keys(pageSizes)[0] ?? 0);
    }
    if (!pageSizes[preferredPage]) return;

    const nextShapes = { ...shapes };
    let preferredCrop = null;
    for (const [pageKey, pageSize] of Object.entries(pageSizes)) {
      const pageIndex = Number(pageKey);
      const pageShapes = shapes[pageIndex] ?? [];
      const existing = pageShapes.find((shape) => shape.type === 'crop') ?? null;
      const crop = existing ?? {
        id: nextAnnotationId++,
        type: /** @type {'crop'} */ ('crop'),
        x: 0,
        y: 0,
        width: pageSize.width,
        height: pageSize.height,
        rotation: 0
      };
      if (!existing) nextShapes[pageIndex] = [...pageShapes, crop];
      if (pageIndex === preferredPage) preferredCrop = crop;
    }
    shapes = nextShapes;
    if (preferredCrop) setShapeSelection(preferredPage, [preferredCrop.id]);
    shapeGuides = null;
  }

  /** @param {number} pageIndex @param {AnnotationShape[]} replacements */
  function replaceShapes(pageIndex, replacements) {
    const replacementMap = new Map(replacements.map((shape) => [shape.id, shape]));
    shapes = {
      ...shapes,
      [pageIndex]: (shapes[pageIndex] ?? []).map((shape) => replacementMap.get(shape.id) ?? shape)
    };
  }

  /** @param {NonNullable<typeof multiSelectionFrame>} frame @param {number} id */
  function frameAsShape(frame, id) {
    return /** @type {AnnotationShape} */ ({ id, type: 'rectangle', ...frame });
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
    const minimumVisible = Math.min(12 / zoomLevel, shape.width / 2, shape.height / 2);
    next.x = clamp(next.x, -next.width + minimumVisible, pageSize.width - minimumVisible);
    next.y = clamp(next.y, -next.height + minimumVisible, pageSize.height - minimumVisible);
    return { shape: next, x: guideX, y: guideY };
  }

  /** @param {KeyboardEvent} event */
  function handleShapeKeyboard(event) {
    if (!selectedShape) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
    const pageIndex = selectedShape.pageIndex;
    const selected = selectedShapesOnPage(pageIndex);
    if (!selected.length) return;
    if (event.key === 'Escape') {
      setShapeSelection(pageIndex, []);
      shapeGuides = null;
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      shapes = {
        ...shapes,
        [pageIndex]: (shapes[pageIndex] ?? []).filter(
          (candidate) => !selectedShapeIds.has(candidate.id)
        )
      };
      setShapeSelection(pageIndex, []);
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
    const pageSize = pageSizes[pageIndex];
    const amount = event.shiftKey ? 10 : 1;
    const bounds = multiSelectionFrame ?? selectionBounds(selected);
    if (!bounds) return;
    const minimumVisible = Math.min(12 / zoomLevel, bounds.width / 2, bounds.height / 2);
    const deltaX = clamp(
      direction.x * amount,
      -bounds.width + minimumVisible - bounds.x,
      pageSize.width - minimumVisible - bounds.x
    );
    const deltaY = clamp(
      direction.y * amount,
      -bounds.height + minimumVisible - bounds.y,
      pageSize.height - minimumVisible - bounds.y
    );
    replaceShapes(pageIndex, selected.map((shape) => ({ ...shape, x: shape.x + deltaX, y: shape.y + deltaY })));
    if (multiSelectionFrame) {
      multiSelectionFrame = { ...multiSelectionFrame, x: multiSelectionFrame.x + deltaX, y: multiSelectionFrame.y + deltaY };
    }
  }

  /** @param {PointerEvent} event @param {HTMLElement} shell @param {number} pageIndex */
  function beginShapeCreation(event, shell, pageIndex) {
    const start = pointOnPage(event, shell);
    const previousShapes = shapes[pageIndex] ?? [];
    const shape = {
      id: nextAnnotationId++,
      type: /** @type {'triangle' | 'rectangle' | 'circle' | 'check' | 'cross' | 'arrow' | 'line' | 'measure' | 'crop' | 'textfield' | 'checkbox' | 'input'} */ (activeTool),
      x: start.x,
      y: start.y,
      width: 0.01,
      height: 0.01,
      rotation: 0,
      text: activeTool === 'textfield' ? '' : undefined,
      fieldName: activeTool === 'checkbox' || activeTool === 'input' ? `DocuflexField${nextAnnotationId - 1}` : undefined,
      fieldValue: activeTool === 'checkbox' ? false : activeTool === 'input' ? '' : undefined,
      existingField: false
    };
    const retainedShapes = activeTool === 'crop'
      ? previousShapes.filter((candidate) => candidate.type !== 'crop')
      : previousShapes;
    shapes = { ...shapes, [pageIndex]: [...retainedShapes, shape] };
    setShapeSelection(pageIndex, [shape.id]);
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

    if (interaction.kind === 'multi-move') {
      const frame = interaction.initialFrame;
      const minimumVisible = Math.min(12 / zoomLevel, frame.width / 2, frame.height / 2);
      const minimumX = -frame.width + minimumVisible - frame.x;
      const maximumX = pageSize.width - minimumVisible - frame.x;
      const minimumY = -frame.height + minimumVisible - frame.y;
      const maximumY = pageSize.height - minimumVisible - frame.y;
      const deltaX = clamp(point.x - interaction.start.x, minimumX, maximumX);
      const deltaY = clamp(point.y - interaction.start.y, minimumY, maximumY);
      replaceShapes(interaction.pageIndex, interaction.initialShapes.map((/** @type {AnnotationShape} */ shape) => ({
        ...shape,
        x: shape.x + deltaX,
        y: shape.y + deltaY
      })));
      multiSelectionFrame = { ...frame, x: frame.x + deltaX, y: frame.y + deltaY };
      shapeGuides = null;
      return;
    }

    if (interaction.kind === 'multi-rotate') {
      const frame = interaction.initialFrame;
      const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
      const pointerAngle = Math.atan2(point.y - center.y, point.x - center.x);
      let delta = ((pointerAngle - interaction.startAngle) * 180) / Math.PI;
      if (event.shiftKey) delta = Math.round(delta / 15) * 15;
      const radians = (delta * Math.PI) / 180;
      const nextShapes = interaction.initialShapes.map((/** @type {AnnotationShape} */ shape) => {
        const originalCenter = shapeCenter(shape);
        const offset = rotateVector(originalCenter.x - center.x, originalCenter.y - center.y, radians);
        const nextCenter = { x: center.x + offset.x, y: center.y + offset.y };
        return {
          ...shape,
          x: nextCenter.x - shape.width / 2,
          y: nextCenter.y - shape.height / 2,
          rotation: shape.rotation + delta
        };
      });
      replaceShapes(interaction.pageIndex, nextShapes);
      multiSelectionFrame = { ...frame, rotation: frame.rotation + delta };
      shapeGuides = null;
      return;
    }

    if (interaction.kind === 'multi-resize') {
      const frame = interaction.initialFrame;
      const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
      const angle = (frame.rotation * Math.PI) / 180;
      const localPointer = rotateVector(point.x - center.x, point.y - center.y, -angle);
      let width = interaction.handleX === 0
        ? frame.width
        : Math.max(MIN_SHAPE_SIZE, interaction.handleX * localPointer.x + frame.width / 2);
      let height = interaction.handleY === 0
        ? frame.height
        : Math.max(MIN_SHAPE_SIZE, interaction.handleY * localPointer.y + frame.height / 2);
      if (event.altKey) {
        if (interaction.handleX !== 0) width = Math.max(MIN_SHAPE_SIZE, Math.abs(localPointer.x) * 2);
        if (interaction.handleY !== 0) height = Math.max(MIN_SHAPE_SIZE, Math.abs(localPointer.y) * 2);
      }
      if (event.shiftKey && interaction.handleX !== 0 && interaction.handleY !== 0) {
        const ratio = frame.width / frame.height;
        if (width / height > ratio) height = width / ratio;
        else width = height * ratio;
      }
      let nextCenter = center;
      if (!event.altKey) {
        const localShift = {
          x: interaction.handleX === 0 ? 0 : interaction.handleX * (width - frame.width) / 2,
          y: interaction.handleY === 0 ? 0 : interaction.handleY * (height - frame.height) / 2
        };
        const worldShift = rotateVector(localShift.x, localShift.y, angle);
        nextCenter = { x: center.x + worldShift.x, y: center.y + worldShift.y };
      }
      const scaleX = width / frame.width;
      const scaleY = height / frame.height;
      const transformPoint = (/** @type {{ x: number; y: number }} */ source) => {
        const local = rotateVector(source.x - center.x, source.y - center.y, -angle);
        const scaled = rotateVector(local.x * scaleX, local.y * scaleY, angle);
        return { x: nextCenter.x + scaled.x, y: nextCenter.y + scaled.y };
      };
      const nextShapes = interaction.initialShapes.map((/** @type {AnnotationShape} */ shape) => {
        if (isLinearShape(shape)) {
          const endpoints = linearEndpoints(shape);
          return shapeFromEndpoints(shape, transformPoint(endpoints.start), transformPoint(endpoints.end));
        }
        const transformedCenter = transformPoint(shapeCenter(shape));
        return {
          ...shape,
          x: transformedCenter.x - shape.width * scaleX / 2,
          y: transformedCenter.y - shape.height * scaleY / 2,
          width: shape.width * scaleX,
          height: shape.height * scaleY
        };
      });
      replaceShapes(interaction.pageIndex, nextShapes);
      multiSelectionFrame = {
        ...frame,
        x: nextCenter.x - width / 2,
        y: nextCenter.y - height / 2,
        width,
        height
      };
      shapeGuides = null;
      return;
    }

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

  /** @param {StrokePoint[]} points @param {number} amount */
  function smoothPenStroke(points, amount) {
    if (points.length < 3 || amount <= 0) return points;
    const normalized = clamp(amount / 100, 0, 1);
    const radius = Math.max(1, Math.round(1 + normalized * 7));
    const passes = Math.max(1, Math.round(1 + normalized * 3));
    let result = points;
    for (let pass = 0; pass < passes; pass += 1) {
      result = result.map((point, index) => {
        if (index === 0 || index === result.length - 1) return point;
        const start = Math.max(0, index - radius);
        const end = Math.min(result.length - 1, index + radius);
        let x = 0;
        let y = 0;
        let count = 0;
        for (let sample = start; sample <= end; sample += 1) {
          x += result[sample].x;
          y += result[sample].y;
          count += 1;
        }
        const strength = 0.28 + normalized * 0.67;
        return {
          x: point.x * (1 - strength) + x / count * strength,
          y: point.y * (1 - strength) + y / count * strength,
          pressure: point.pressure
        };
      });
    }
    return result;
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
    const pointerTarget = event.target;
    if (pointerTarget instanceof Element && pointerTarget.closest('[data-text-editor]')) return;

    const shapeHit = shapeTarget(event);
    const hitShape = shapeHit ? findShape(shapeHit.pageIndex, shapeHit.id) : null;
    const canTransformHitShape = activeTool === 'select' || (activeTool === 'crop' && hitShape?.type === 'crop');
    if (event.button === 0 && shapeHit && canTransformHitShape) {
      const shape = hitShape;
      const pages = [...viewer.querySelectorAll('.pdf-page')];
      const shell = pages[shapeHit.pageIndex];
      if (!shape || !(shell instanceof HTMLElement)) return;
      if (
        event.detail >= 2 &&
        shape.type === 'textfield' &&
        !event.shiftKey &&
        shapeHit.element.dataset.shapeHandle === undefined &&
        shapeHit.element.dataset.shapeRotate === undefined
      ) {
        event.preventDefault();
        event.stopPropagation();
        const pageIndex = shapeHit.pageIndex;
        const shapeId = shape.id;
        // Wait until Safari has completed the full second-click sequence before
        // inserting and focusing the textarea.
        setTimeout(() => openTextEditor(pageIndex, shapeId), 0);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      const alreadySelected = selectedShape?.pageIndex === shapeHit.pageIndex && selectedShapeIds.has(shapeHit.id);
      if (event.shiftKey && activeTool === 'select' && !alreadySelected) {
        const ids = selectedShape?.pageIndex === shapeHit.pageIndex ? new Set(selectedShapeIds) : new Set();
        ids.add(shapeHit.id);
        setShapeSelection(shapeHit.pageIndex, [...ids]);
        shapeGuides = null;
        return;
      }
      if (selectedShape?.pageIndex !== shapeHit.pageIndex || !selectedShapeIds.has(shapeHit.id)) {
        setShapeSelection(shapeHit.pageIndex, [shapeHit.id]);
      }
      const point = pointOnPage(event, shell);
      const handle = shapeHit.element.dataset.shapeHandle;
      const endpoint = shapeHit.element.dataset.shapeEndpoint;
      const selected = selectedShapesOnPage(shapeHit.pageIndex);
      if (selected.length > 1 && multiSelectionFrame) {
        const initialFrame = { ...multiSelectionFrame };
        const initialShapes = selected.map((candidate) => ({ ...candidate }));
        if (shapeHit.element.dataset.shapeRotate !== undefined) {
          const center = { x: initialFrame.x + initialFrame.width / 2, y: initialFrame.y + initialFrame.height / 2 };
          shapeInteraction = {
            pointerId: event.pointerId,
            kind: 'multi-rotate',
            pageIndex: shapeHit.pageIndex,
            initialFrame,
            initialShapes,
            startAngle: Math.atan2(point.y - center.y, point.x - center.x)
          };
        } else if (handle) {
          const [handleX, handleY] = handle.split(',').map(Number);
          shapeInteraction = {
            pointerId: event.pointerId,
            kind: 'multi-resize',
            pageIndex: shapeHit.pageIndex,
            initialFrame,
            initialShapes,
            handleX,
            handleY
          };
        } else {
          shapeInteraction = {
            pointerId: event.pointerId,
            kind: 'multi-move',
            pageIndex: shapeHit.pageIndex,
            initialFrame,
            initialShapes,
            start: point
          };
        }
      } else if (endpoint === 'start' || endpoint === 'end') {
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
      if (selectedShape) setShapeSelection(selectedShape.pageIndex, []);
      shapeGuides = null;
    }
    if (event.button === 0 && pageHit && SHAPE_TOOLS.has(activeTool) && activeTool !== 'crop') {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      beginShapeCreation(event, pageHit.shell, pageHit.pageIndex);
      viewer.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button === 0 && activeTool === 'select' && pageHit && !shapeHit) {
      if (selectedShape) setShapeSelection(selectedShape.pageIndex, []);
      shapeGuides = null;
    }

    if (event.button === 0 && pageHit && (activeTool === 'marker' || activeTool === 'pen')) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      const firstPoint = pointOnPage(event, pageHit.shell);
      const stroke = {
        id: nextAnnotationId++,
        type: /** @type {'marker' | 'pen'} */ (activeTool),
        points: [firstPoint],
        rawPoints: [firstPoint],
        color: activeTool === 'marker' ? markerColor : penColor,
        thickness: activeTool === 'marker' ? markerThickness : penThickness,
        opacity: activeTool === 'marker' ? markerOpacity : penOpacity,
        falloff: activeTool === 'marker' ? markerFalloff : 0,
        smoothing: activeTool === 'pen' ? penSmoothing : 0
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
    updateHoveredShape(event);
    if (viewer && pendingFormDrag && event.pointerId === pendingFormDrag.pointerId) {
      const distance = Math.hypot(event.clientX - pendingFormDrag.clientX, event.clientY - pendingFormDrag.clientY);
      if (distance >= 4) {
        const pending = pendingFormDrag;
        const shape = findShape(pending.pageIndex, pending.id);
        const shell = viewer.querySelectorAll('.pdf-page')[pending.pageIndex];
        pendingFormDrag = null;
        if (shape && shell instanceof HTMLElement) {
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
          setShapeSelection(pending.pageIndex, [shape.id]);
          shapeInteraction = {
            pointerId: event.pointerId,
            kind: 'move',
            pageIndex: pending.pageIndex,
            id: shape.id,
            start: pending.start,
            initial: { ...shape }
          };
          viewer.setPointerCapture(event.pointerId);
        }
      }
    }
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
      let points = drawingStroke.stroke.rawPoints ?? drawingStroke.stroke.points;
      const events = event.getCoalescedEvents?.() ?? [event];
      for (const coalescedEvent of events) {
        points = appendInterpolatedPoint(points, pointOnPage(coalescedEvent, shell));
      }
      drawingStroke.stroke = {
        ...drawingStroke.stroke,
        rawPoints: points,
        points: drawingStroke.stroke.type === 'pen'
          ? smoothPenStroke(points, drawingStroke.stroke.smoothing ?? 0)
          : points
      };
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
    if (pendingFormDrag?.pointerId === event.pointerId) pendingFormDrag = null;
    if (drawingShape && event.pointerId === drawingShape.pointerId) {
      const finishedPageIndex = drawingShape.pageIndex;
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
        const preferredWidth = shape.type === 'crop'
          ? pageSize.width * 0.72
          : shape.type === 'textfield' || shape.type === 'input'
          ? 180
          : shape.type === 'checkbox' ? 24 : shape.type === 'check' || shape.type === 'cross' ? 48 : 120;
        const preferredHeight = shape.type === 'crop'
          ? pageSize.height * 0.72
          : shape.type === 'textfield' ? 40 : shape.type === 'input' ? 34 : shape.type === 'checkbox' ? 24 : preferredWidth;
        const defaultWidth = shape.type === 'crop' ? preferredWidth : Math.min(preferredWidth, pageSize.width / 3);
        const defaultHeight = shape.type === 'crop' ? preferredHeight : Math.min(preferredHeight, pageSize.height / 4);
        replaceShape(drawingShape.pageIndex, {
          ...shape,
          x: shape.type === 'crop' ? (pageSize.width - defaultWidth) / 2 : clamp(drawingShape.start.x, 0, pageSize.width - defaultWidth),
          y: shape.type === 'crop' ? (pageSize.height - defaultHeight) / 2 : clamp(drawingShape.start.y, 0, pageSize.height - defaultHeight),
          width: defaultWidth,
          height: defaultHeight
        });
      }
      drawingShape = null;
      shapeGuides = null;
      if (shape?.type !== 'crop') activeTool = 'select';
      if (shape?.type === 'textfield') {
        editingTextShape = { pageIndex: finishedPageIndex, id: shape.id };
        tick().then(() => focusTextEditor(shape.id));
      } else if (shape?.type === 'input') {
        tick().then(() => {
          const input = viewer?.querySelector(`input[data-form-field="${shape.id}"]`);
          if (input instanceof HTMLInputElement) input.focus();
        });
      }
    }
    if (shapeInteraction && event.pointerId === shapeInteraction.pointerId) {
      shapeInteraction = null;
      shapeGuides = null;
    }
    if (drawingStroke && event.pointerId === drawingStroke.pointerId) {
      if (drawingStroke.stroke.type === 'marker' && markerStraighten) {
        drawingStroke.stroke = {
          ...drawingStroke.stroke,
          points: straightenMarker(drawingStroke.stroke.rawPoints ?? drawingStroke.stroke.points),
          rawPoints: undefined
        };
        replaceStroke(drawingStroke.pageIndex, drawingStroke.stroke);
      } else if (drawingStroke.stroke.type === 'pen') {
        drawingStroke.stroke = {
          ...drawingStroke.stroke,
          points: smoothPenStroke(drawingStroke.stroke.rawPoints ?? drawingStroke.stroke.points, drawingStroke.stroke.smoothing ?? 0),
          rawPoints: undefined
        };
        replaceStroke(drawingStroke.pageIndex, drawingStroke.stroke);
      } else if (drawingStroke.stroke.rawPoints) {
        drawingStroke.stroke = { ...drawingStroke.stroke, rawPoints: undefined };
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
        annotationMode: 2,
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

  /** @param {boolean} [resetAnnotations] @param {boolean} [preservePageLayout] @param {number | null} [expectedPageCount] */
  async function loadPdf(resetAnnotations = true, preservePageLayout = false, expectedPageCount = null) {
    const generation = ++loadGeneration;
    status = 'Rendering PDF…';
    pdfReady = false;
    cancelSharpRenders();
    if (resetAnnotations) {
      annotations = {};
      textHighlights = {};
      shapes = {};
    }
    selectedShape = null;
    editingTextShape = null;
    selectedShapeIds = new Set();
    multiSelectionFrame = null;
    drawingShape = null;
    shapeInteraction = null;
    shapeGuides = null;
    pageSizes = {};
    if (preservePageLayout && typeof expectedPageCount === 'number' && Number.isInteger(expectedPageCount) && expectedPageCount >= 0) pageCount = expectedPageCount;
    else if (!preservePageLayout) pageCount = 0;
    selectedPages = new Set();
    selectionAnchor = null;
    textLayerBuilders.forEach((builder) => builder.cancel());
    textLayerBuilders = [];
    textLayerAbortController?.abort();
    textLayerAbortController = new AbortController();
    viewer?.querySelectorAll('.textLayer').forEach((layer) => layer.remove());
    void pdfLoadingTask?.destroy();
    pdfLoadingTask = null;
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
      const bytes = await workingFile.arrayBuffer();
      // Keep a separate copy because PDF.js may transfer its input buffer to
      // the worker. This remains readable even when an IndexedDB-backed WebKit
      // blob URL becomes invalid after the initial document load.
      workingPdfBytes = bytes.slice(0);
      const loadingTask = pdfjs.getDocument({ data: bytes });
      pdfLoadingTask = loadingTask;
      loadingTask.onPassword = () => {
        if (generation !== loadGeneration) return;
        passwordUnlockOpen = true;
        passwordUnlockError = '';
        encryptionEnabled = true;
        protectionPassword = '';
        onProtectionChange({ enabled: true, password: '' });
      };
      const document = await loadingTask.promise;
      if (generation !== loadGeneration) {
        document.destroy();
        return;
      }
      pdfLoadingTask = null;
      pdfDocument = document;
      pageCount = document.numPages;
      await tick();
      await Promise.all([
        renderPages(pdfViewer, document, generation, resetAnnotations),
        renderThumbnails(document, generation)
      ]);
      status = '';
      pdfReady = true;
      if (searchPanelOpen && searchQuery) scheduleSearchUpdate();
      if (zoomLevel !== 1) scheduleSharpRender(0);
    } catch (error) {
      if (generation !== loadGeneration) return;
      console.error(error);
      if (!passwordUnlockOpen) status = 'Could not render this PDF.';
    }
  }

  /**
   * @param {typeof import('pdfjs-dist/web/pdf_viewer.mjs')} pdfViewer
   * @param {import('pdfjs-dist').PDFDocumentProxy} document
   * @param {number} generation
   * @param {boolean} loadFormWidgets
   */
  async function renderPages(pdfViewer, document, generation, loadFormWidgets) {
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
      shell.dataset.pageRotation = `${((viewport.rotation % 360) + 360) % 360}`;
      pageSizes = { ...pageSizes, [index]: { width: viewport.width, height: viewport.height } };
      if (loadFormWidgets) {
        const pageAnnotations = await page.getAnnotations({ intent: 'display' });
        const formShapes = pageAnnotations.flatMap((/** @type {any} */ annotation) => {
          if (annotation.subtype !== 'Widget' || !Array.isArray(annotation.rect)) return [];
          const isCheckbox = annotation.fieldType === 'Btn' && Boolean(annotation.checkBox);
          const isTextInput = annotation.fieldType === 'Tx';
          if (!isCheckbox && !isTextInput) return [];
          const converted = viewport.convertToViewportRectangle(annotation.rect);
          const x = Math.min(converted[0], converted[2]);
          const y = Math.min(converted[1], converted[3]);
          const width = Math.abs(converted[2] - converted[0]);
          const height = Math.abs(converted[3] - converted[1]);
          if (width < 1 || height < 1) return [];
          const rawValue = Array.isArray(annotation.fieldValue) ? annotation.fieldValue[0] : annotation.fieldValue;
          return [{
            id: nextAnnotationId++,
            type: /** @type {'checkbox' | 'input'} */ (isCheckbox ? 'checkbox' : 'input'),
            x,
            y,
            width,
            height,
            rotation: 0,
            fieldName: String(annotation.fieldName ?? annotation.id ?? `Field${nextAnnotationId}`),
            fieldValue: isCheckbox ? Boolean(rawValue && rawValue !== 'Off') : String(rawValue ?? ''),
            existingField: true,
            readOnly: Boolean(annotation.readOnly)
          }];
        });
        if (formShapes.length) shapes = { ...shapes, [index]: [...(shapes[index] ?? []), ...formShapes] };
      }
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
          annotationMode: 2,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
        }).promise,
        textLayerBuilder.render({ viewport, images: /** @type {any} */ (null) })
      ]);
      if (!ocrTextLayerActive && ((viewport.rotation % 360) + 360) % 360 === 0) {
        mergeAdjacentTextSpans(textLayerBuilder.div);
      }
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

    if (htmlViewportActive()) htmlEditor?.scrollToPage?.(pageIndex);
    else scrollViewerToPage(pageIndex);
  }

  /** @param {number} pageIndex */
  function scrollViewerToPage(pageIndex) {
    const page = viewer?.querySelectorAll('.pdf-page')[pageIndex];
    if (!viewer || !(page instanceof HTMLElement)) return;
    const viewerRect = viewer.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    viewer.scrollTo({
      top: Math.max(0, viewer.scrollTop + pageRect.top - viewerRect.top - 24),
      left: viewer.scrollLeft,
      behavior: 'smooth'
    });
  }

  function capturePageScrollState() {
    const sidebar = document.querySelector('.editor-sidebar');
    return {
      sidebarTop: sidebar instanceof HTMLElement ? sidebar.scrollTop : 0,
      viewerTop: viewer?.scrollTop ?? 0,
      viewerLeft: viewer?.scrollLeft ?? 0
    };
  }

  /** @param {{ sidebarTop: number; viewerTop: number; viewerLeft: number }} state */
  async function restorePageScrollState(state) {
    await tick();
    const sidebar = document.querySelector('.editor-sidebar');
    if (sidebar instanceof HTMLElement) sidebar.scrollTop = state.sidebarTop;
    if (viewer) {
      viewer.scrollTop = state.viewerTop;
      viewer.scrollLeft = state.viewerLeft;
    }
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

  /** @param {number} pageIndex @param {MouseEvent} event */
  function handlePageClick(pageIndex, event) {
    if (ignoreNextPageClick) {
      ignoreNextPageClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    selectPage(pageIndex, event);
  }

  /** @param {number} insertionIndex */
  function updatePageDragPreview(insertionIndex) {
    const remaining = Array.from({ length: pageCount }, (_, pageIndex) => pageIndex).filter((pageIndex) => !draggedPages.includes(pageIndex));
    const boundedIndex = Math.max(0, Math.min(insertionIndex, remaining.length));
    pageDragInsertionIndex = boundedIndex;
    const nextOrder = [...remaining.slice(0, boundedIndex), ...draggedPages, ...remaining.slice(boundedIndex)];
    if (!nextOrder.every((pageIndex, orderIndex) => pageDragPreviewOrder[orderIndex] === pageIndex)) {
      pageDragPreviewOrder = nextOrder;
    }
  }

  /** @param {PointerEvent} event @param {number} pageIndex */
  function beginPagePointerDrag(event, pageIndex) {
    if (event.button !== 0 || pageOperationBusy) return;
    pageDragCleanup?.();
    draggedPages = selectedPages.has(pageIndex) ? selectedPageIndexes() : [pageIndex];
    pageContextMenu = null;
    const button = event.currentTarget;
    if (!(button instanceof HTMLElement)) return;
    const rect = button.getBoundingClientRect();
    const uiScale = rect.width / Math.max(1, button.offsetWidth);
    const canvas = button.querySelector('canvas');
    let imageUrl = '';
    try {
      if (canvas instanceof HTMLCanvasElement) imageUrl = canvas.toDataURL('image/png');
    } catch (error) {
      console.warn('Could not create the page drag preview:', error);
    }
    pagePointerDrag = {
      pointerId: event.pointerId,
      pageIndex,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: button.offsetWidth,
      height: button.offsetHeight,
      uiScale: Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1,
      imageUrl,
      active: false
    };
    /** @type {number | undefined} */
    let pageAutoScrollFrame;
    let pageAutoScrollSpeed = 0;

    /** @param {number} clientY */
    function updatePageInsertionAt(clientY) {
      if (!pagePointerDrag?.active) return;
      const remaining = Array.from({ length: pageCount }, (_, pageIndex) => pageIndex).filter((candidate) => !draggedPages.includes(candidate));

      /** @param {number} page */
      function stablePageCenter(page) {
        const entry = document.querySelector(`.thumbnail-entry[data-page-index="${page}"]`);
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

      let insertionIndex = pageDragInsertionIndex;
      const hysteresis = 18;
      while (insertionIndex < remaining.length) {
        const nextCenter = stablePageCenter(remaining[insertionIndex]);
        if (nextCenter === null || clientY <= nextCenter + hysteresis) break;
        insertionIndex += 1;
      }
      while (insertionIndex > 0) {
        const previousCenter = stablePageCenter(remaining[insertionIndex - 1]);
        if (previousCenter === null || clientY >= previousCenter - hysteresis) break;
        insertionIndex -= 1;
      }
      if (insertionIndex !== pageDragInsertionIndex) updatePageDragPreview(insertionIndex);
    }

    function runPageAutoScroll() {
      if (!pagePointerDrag?.active) return;
      const sidebar = document.querySelector('.editor-sidebar');
      if (sidebar instanceof HTMLElement && pageAutoScrollSpeed !== 0) {
        sidebar.scrollTop += pageAutoScrollSpeed;
        updatePageInsertionAt(pagePointerDrag.clientY);
      }
      pageAutoScrollFrame = requestAnimationFrame(runPageAutoScroll);
    }

    /** @param {PointerEvent} moveEvent */
    function movePagePointerDrag(moveEvent) {
      if (!pagePointerDrag || moveEvent.pointerId !== pagePointerDrag.pointerId) return;
      const distance = Math.hypot(moveEvent.clientX - pagePointerDrag.startX, moveEvent.clientY - pagePointerDrag.startY);
      if (!pagePointerDrag.active && distance < 6) return;
      if (!pagePointerDrag.active) {
        if (!selectedPages.has(pageIndex)) {
          selectedPages = new Set([pageIndex]);
          selectionAnchor = pageIndex;
        }
        const remainingBeforePage = Array.from({ length: pageCount }, (_, candidate) => candidate)
          .filter((candidate) => !draggedPages.includes(candidate) && candidate < draggedPages[0]).length;
        pageDragInsertionIndex = remainingBeforePage;
        updatePageDragPreview(remainingBeforePage);
        document.documentElement.classList.add('page-dragging');
        pageAutoScrollFrame = requestAnimationFrame(runPageAutoScroll);
      }
      moveEvent.preventDefault();
      pagePointerDrag = { ...pagePointerDrag, clientX: moveEvent.clientX, clientY: moveEvent.clientY, active: true };

      const sidebar = document.querySelector('.editor-sidebar');
      if (sidebar instanceof HTMLElement) {
        const sidebarRect = sidebar.getBoundingClientRect();
        const scrollZone = Math.min(190, sidebarRect.height * 0.24);
        const topDistance = moveEvent.clientY - sidebarRect.top;
        const bottomDistance = sidebarRect.bottom - moveEvent.clientY;
        if (topDistance < scrollZone) {
          pageAutoScrollSpeed = -Math.max(2, 34 * (1 - Math.max(0, topDistance) / scrollZone));
        } else if (bottomDistance < scrollZone) {
          pageAutoScrollSpeed = Math.max(2, 34 * (1 - Math.max(0, bottomDistance) / scrollZone));
        } else {
          pageAutoScrollSpeed = 0;
        }
      }
      updatePageInsertionAt(moveEvent.clientY);
    }

    /** @param {PointerEvent} endEvent */
    function finishPagePointerDrag(endEvent) {
      if (!pagePointerDrag || endEvent.pointerId !== pagePointerDrag.pointerId) return;
      const wasActive = pagePointerDrag.active;
      const dragged = [...draggedPages].sort((left, right) => left - right);
      const order = pageDragPreviewOrder.length ? [...pageDragPreviewOrder] : [];
      pageDragCleanup?.();
      if (!wasActive || !order.length) return;
      ignoreNextPageClick = true;
      window.setTimeout(() => { ignoreNextPageClick = false; }, 0);
      const nextSelection = new Set(dragged.map((page) => order.indexOf(page)));
      if (!order.every((page, index) => page === index)) {
        pageDragPreviewOrder = order;
        void reorderPages(order, nextSelection);
      }
    }

    pageDragCleanup = () => {
      window.removeEventListener('pointermove', movePagePointerDrag);
      window.removeEventListener('pointerup', finishPagePointerDrag);
      window.removeEventListener('pointercancel', finishPagePointerDrag);
      if (pageAutoScrollFrame !== undefined) cancelAnimationFrame(pageAutoScrollFrame);
      document.documentElement.classList.remove('page-dragging');
      pagePointerDrag = null;
      draggedPages = [];
      pageDragPreviewOrder = [];
      pageDragInsertionIndex = 0;
      pageDragCleanup = null;
    };
    window.addEventListener('pointermove', movePagePointerDrag, { passive: false });
    window.addEventListener('pointerup', finishPagePointerDrag);
    window.addEventListener('pointercancel', finishPagePointerDrag);
  }

  /** @param {string} operation @param {Record<string, unknown>} details @param {ArrayBuffer | null} [source] */
  async function requestPageOperation(operation, details, source = null) {
    const bytes = source ?? await workingFile.arrayBuffer();
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

  /** @template T @param {Record<number, T[]>} records @param {number[]} order */
  function reorderPageRecords(records, order) {
    return Object.fromEntries(order.flatMap((oldIndex, newIndex) =>
      records[oldIndex]?.length ? [[newIndex, records[oldIndex]]] : []
    ));
  }

  /** @template T @param {Record<number, T[]>} records @param {number} insertAt @param {T[][]} inserted @returns {Record<number, T[]>} */
  function insertPageRecords(records, insertAt, inserted) {
    /** @type {Record<number, T[]>} */
    const result = {};
    for (let oldIndex = 0; oldIndex < pageCount; oldIndex += 1) {
      const newIndex = oldIndex < insertAt ? oldIndex : oldIndex + inserted.length;
      if (records[oldIndex]?.length) result[newIndex] = records[oldIndex];
    }
    inserted.forEach((pageRecords, offset) => {
      if (pageRecords?.length) result[insertAt + offset] = structuredClone(pageRecords);
    });
    return result;
  }

  /** @param {number[]} order @param {Set<number>} nextSelection */
  async function reorderPages(order, nextSelection) {
    const sidebar = document.querySelector('.editor-sidebar');
    const sidebarScrollTop = sidebar instanceof HTMLElement ? sidebar.scrollTop : 0;
    const viewerScrollTop = viewer?.scrollTop ?? 0;
    const viewerScrollLeft = viewer?.scrollLeft ?? 0;
    pageOperationBusy = true;
    editorTransition = 'Reordering Pages';
    try {
      const result = await requestPageOperation('reorder', { order });
      annotations = reorderPageRecords(annotations, order);
      shapes = reorderPageRecords(shapes, order);
      textHighlights = reorderPageRecords(textHighlights, order);
      workingFile = new File([result], workingFile.name, { type: 'application/pdf', lastModified: Date.now() });
      htmlEditorStarted = false;
      htmlTextEditBaseFile = null;
      htmlEditorReady = false;
      htmlViewportMode = false;
      await loadPdf(false, true, order.length);
      /** @type {{ canvas: HTMLCanvasElement; cssWidth: string; cssHeight: string; shellHeight: string }[]} */
      const thumbnailFrames = [...document.querySelectorAll('.thumbnail-page')].flatMap((shell) => {
        const canvas = shell.querySelector('canvas');
        if (!(shell instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return [];
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d')?.drawImage(canvas, 0, 0);
        return [{
          canvas: copy,
          cssWidth: canvas.style.width,
          cssHeight: canvas.style.height,
          shellHeight: shell.style.height
        }];
      });
      pageDragPreviewOrder = [];
      await tick();
      const normalizedShells = [...document.querySelectorAll('.thumbnail-page')];
      thumbnailFrames.forEach((frame, index) => {
        const shell = normalizedShells[index];
        const canvas = shell?.querySelector('canvas');
        if (!(shell instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return;
        shell.style.height = frame.shellHeight;
        canvas.width = frame.canvas.width;
        canvas.height = frame.canvas.height;
        canvas.style.width = frame.cssWidth;
        canvas.style.height = frame.cssHeight;
        canvas.getContext('2d')?.drawImage(frame.canvas, 0, 0);
      });
      const restoredSidebar = document.querySelector('.editor-sidebar');
      if (restoredSidebar instanceof HTMLElement) restoredSidebar.scrollTop = sidebarScrollTop;
      if (viewer) {
        viewer.scrollTop = viewerScrollTop;
        viewer.scrollLeft = viewerScrollLeft;
      }
      selectedPages = nextSelection;
      selectionAnchor = [...nextSelection][0] ?? null;
    } catch (error) {
      console.error(error);
      pageDragPreviewOrder = [];
      window.alert(error instanceof Error ? error.message : 'Could not reorder the pages.');
    } finally {
      pageOperationBusy = false;
      editorTransition = '';
    }
  }

  async function copySelectedPages() {
    const pages = selectedPageIndexes();
    if (!pages.length || pageOperationBusy) return;
    pageOperationBusy = true;
    try {
      const result = await requestPageOperation('extract', { pages });
      pageClipboard = {
        pdfBase64: arrayBufferToBase64(result),
        annotations: pages.map((page) => structuredClone(annotations[page] ?? [])),
        shapes: pages.map((page) => structuredClone(shapes[page] ?? [])),
        textHighlights: pages.map((page) => structuredClone(textHighlights[page] ?? []))
      };
      pageContextMenu = null;
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not copy the pages.');
    } finally {
      pageOperationBusy = false;
    }
  }

  async function pastePages() {
    if (!pageClipboard || pageOperationBusy) return;
    const scrollState = capturePageScrollState();
    const selected = selectedPageIndexes();
    const insertAt = selected.length ? selected[selected.length - 1] + 1 : pageCount;
    pageContextMenu = null;
    pageOperationBusy = true;
    editorTransition = 'Pasting Pages';
    try {
      const result = await requestPageOperation('insert', {
        insertAt,
        insertPdfBase64: pageClipboard.pdfBase64
      });
      annotations = insertPageRecords(annotations, insertAt, pageClipboard.annotations);
      shapes = insertPageRecords(shapes, insertAt, pageClipboard.shapes);
      textHighlights = insertPageRecords(textHighlights, insertAt, pageClipboard.textHighlights);
      const insertedCount = pageClipboard.annotations.length;
      const nextPageCount = pageCount + insertedCount;
      workingFile = new File([result], workingFile.name, { type: 'application/pdf', lastModified: Date.now() });
      htmlEditorStarted = false;
      htmlTextEditBaseFile = null;
      htmlEditorReady = false;
      htmlViewportMode = false;
      await loadPdf(false, true, nextPageCount);
      await restorePageScrollState(scrollState);
      selectedPages = new Set(Array.from({ length: insertedCount }, (_, offset) => insertAt + offset));
      selectionAnchor = insertAt;
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not paste the pages.');
    } finally {
      pageOperationBusy = false;
      editorTransition = '';
    }
  }

  /** @param {DataTransfer | null} transfer */
  function transferMayContainPdf(transfer) {
    if (!transfer) return false;
    const fileItems = [...transfer.items].filter((item) => item.kind === 'file');
    if (fileItems.some((item) => item.type === 'application/pdf')) return true;
    return fileItems.some((item) => !item.type) || [...transfer.types].includes('Files');
  }

  /** @param {DragEvent} event @param {number} insertAt */
  function showExternalPdfDropTarget(event, insertAt) {
    if (pageOperationBusy || !transferMayContainPdf(event.dataTransfer)) return;
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

  /** @param {DragEvent} event */
  function handleExternalPdfSidebarDrag(event) {
    if (pageOperationBusy || !transferMayContainPdf(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const sidebar = event.currentTarget;
    if (!(sidebar instanceof HTMLElement)) return;
    const rect = sidebar.getBoundingClientRect();
    const scrollZone = Math.min(150, rect.height * 0.2);
    const topDistance = event.clientY - rect.top;
    const bottomDistance = rect.bottom - event.clientY;
    if (topDistance < scrollZone) sidebar.scrollTop -= Math.max(5, 24 * (1 - Math.max(0, topDistance) / scrollZone));
    else if (bottomDistance < scrollZone) sidebar.scrollTop += Math.max(5, 24 * (1 - Math.max(0, bottomDistance) / scrollZone));
  }

  /** @param {File} droppedFile @param {number} insertAt */
  async function insertDroppedPdf(droppedFile, insertAt) {
    if (pageOperationBusy) return;
    const scrollState = capturePageScrollState();
    pageOperationBusy = true;
    editorTransition = 'Adding PDF Pages';
    try {
      const droppedBytes = await droppedFile.arrayBuffer();
      const pdfjs = await import('pdfjs-dist');
      const inspectionTask = pdfjs.getDocument({ data: droppedBytes.slice(0) });
      const droppedDocument = await inspectionTask.promise;
      const insertedCount = droppedDocument.numPages;
      await droppedDocument.destroy();
      if (!insertedCount) throw new Error('The dropped PDF does not contain any pages.');

      const result = await requestPageOperation('insert', {
        insertAt,
        insertPdfBase64: arrayBufferToBase64(droppedBytes)
      });
      const emptyInsertedRecords = Array.from({ length: insertedCount }, () => []);
      annotations = insertPageRecords(annotations, insertAt, emptyInsertedRecords);
      shapes = insertPageRecords(shapes, insertAt, emptyInsertedRecords);
      textHighlights = insertPageRecords(textHighlights, insertAt, emptyInsertedRecords);
      const nextPageCount = pageCount + insertedCount;
      workingFile = new File([result], workingFile.name, { type: 'application/pdf', lastModified: Date.now() });
      htmlEditorStarted = false;
      htmlTextEditBaseFile = null;
      htmlEditorReady = false;
      htmlViewportMode = false;
      await loadPdf(false, true, nextPageCount);
      await restorePageScrollState(scrollState);
      selectedPages = new Set(Array.from({ length: insertedCount }, (_, offset) => insertAt + offset));
      selectionAnchor = insertAt;
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not add the dropped PDF.');
    } finally {
      externalPdfDropIndex = null;
      pageOperationBusy = false;
      editorTransition = '';
    }
  }

  /** @param {DragEvent} event @param {number} insertAt */
  function dropExternalPdf(event, insertAt) {
    if (pageOperationBusy) return;
    event.preventDefault();
    event.stopPropagation();
    externalPdfDropIndex = null;
    const droppedFile = [...(event.dataTransfer?.files ?? [])].find((candidate) =>
      candidate.type === 'application/pdf' || candidate.name.toLowerCase().endsWith('.pdf')
    );
    if (droppedFile) void insertDroppedPdf(droppedFile, insertAt);
  }

  async function deleteSelectedPages() {
    const removed = new Set(selectedPageIndexes());
    if (!removed.size || removed.size >= pageCount || pageOperationBusy) return;
    pageContextMenu = null;
    const order = Array.from({ length: pageCount }, (_, index) => index).filter((index) => !removed.has(index));
    const nearest = Math.min(order.length - 1, Math.min(...removed));
    await reorderPages(order, new Set([nearest]));
  }

  /** @param {number} degrees */
  async function rotateSelectedPages(degrees) {
    const pages = selectedPageIndexes();
    if (!pages.length || pageOperationBusy) return;
    const scrollState = capturePageScrollState();
    pageContextMenu = null;
    pageOperationBusy = true;
    editorTransition = degrees > 0 ? 'Rotating Pages Right' : 'Rotating Pages Left';
    try {
      const result = await requestPageOperation('rotate', { pages, rotation: degrees });
      const selected = new Set(pages);
      /** @param {{ x: number; y: number }} point @param {{ width: number; height: number }} pageSize */
      const rotatePoint = (point, pageSize) => degrees > 0
        ? { ...point, x: pageSize.height - point.y, y: point.x }
        : { ...point, x: point.y, y: pageSize.width - point.x };
      annotations = Object.fromEntries(Object.entries(annotations).map(([page, strokes]) => {
        const pageIndex = Number(page);
        const size = pageSizes[pageIndex];
        if (!selected.has(pageIndex) || !size) return [page, strokes];
        return [page, strokes.map((stroke) => ({
          ...stroke,
          points: stroke.points.map((point) => rotatePoint(point, size)),
          rawPoints: stroke.rawPoints?.map((point) => rotatePoint(point, size))
        }))];
      }));
      shapes = Object.fromEntries(Object.entries(shapes).map(([page, pageShapes]) => {
        const pageIndex = Number(page);
        const size = pageSizes[pageIndex];
        if (!selected.has(pageIndex) || !size) return [page, pageShapes];
        return [page, pageShapes.map((shape) => {
          const center = rotatePoint({ x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 }, size);
          return {
            ...shape,
            x: center.x - shape.height / 2,
            y: center.y - shape.width / 2,
            width: shape.height,
            height: shape.width,
            rotation: (shape.rotation + degrees + 360) % 360
          };
        })];
      }));
      textHighlights = Object.fromEntries(Object.entries(textHighlights).map(([page, highlights]) => {
        const pageIndex = Number(page);
        const size = pageSizes[pageIndex];
        if (!selected.has(pageIndex) || !size) return [page, highlights];
        return [page, highlights.map((highlight) => ({
          ...highlight,
          rects: highlight.rects.map((rect) => {
            const center = rotatePoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, size);
            return { ...rect, x: center.x - rect.height / 2, y: center.y - rect.width / 2, width: rect.height, height: rect.width };
          })
        }))];
      }));
      workingFile = new File([result], workingFile.name, { type: 'application/pdf', lastModified: Date.now() });
      htmlEditorStarted = false;
      htmlTextEditBaseFile = null;
      htmlEditorReady = false;
      htmlViewportMode = false;
      await loadPdf(false, true, pageCount);
      await restorePageScrollState(scrollState);
      selectedPages = new Set(pages);
      selectionAnchor = pages[0] ?? null;
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not rotate the pages.');
    } finally {
      pageOperationBusy = false;
      editorTransition = '';
    }
  }

  async function exportSelectedPages() {
    const pages = selectedPageIndexes();
    if (!pages.length || pageOperationBusy) return;
    pageContextMenu = null;
    pageOperationBusy = true;
    editorTransition = 'Exporting Pages';
    try {
      let sourcePdf = await workingFile.arrayBuffer();
      if (htmlEditorStarted && htmlEditor?.applyTextEdits) sourcePdf = await htmlEditor.applyTextEdits(sourcePdf);
      const annotatedResponse = await fetch('/api/pdf/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: arrayBufferToBase64(sourcePdf), annotations: exportableAnnotations(), encryptionPassword: '' })
      });
      if (!annotatedResponse.ok) throw new Error('Could not prepare the selected pages for export.');
      const result = await requestPageOperation('extract', { pages }, await annotatedResponse.arrayBuffer());
      const blob = new Blob([result], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${workingFile.name.replace(/\.pdf$/i, '') || 'document'}-pages-${pages.map((page) => page + 1).join('-')}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not export the pages.');
    } finally {
      pageOperationBusy = false;
      editorTransition = '';
    }
  }

  /** @param {KeyboardEvent} event */
  function handlePageMenuShortcut(event) {
    if (!pageContextMenu || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
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
    event.stopImmediatePropagation();
    void action();
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
          color: [
            ...normalizedRgb(stroke.color ?? (stroke.type === 'marker' ? '#FFE43B' : '#E21D32')),
            clamp(stroke.opacity ?? (stroke.type === 'marker' ? 0.34 : 0.94), 0, 1),
            Math.max(0.25, stroke.thickness ?? (stroke.type === 'marker' ? 16 : 2.05)),
            clamp((stroke.falloff ?? 0) / 100, 0, 1)
          ],
          points: stroke.points.map((point) => ({
            x: point.x / pageSize.width,
            y: point.y / pageSize.height
          }))
        }));
    });
    const exportedShapes = Object.entries(shapes).flatMap(([page, pageShapes]) => {
      const pageSize = pageSizes[Number(page)];
      if (!pageSize?.width || !pageSize.height) return [];
      return pageShapes.filter((shape) => {
        if (shape.type === 'measure') return false;
        if (shape.type !== 'crop') return true;
        return shape.x > 0.01 || shape.y > 0.01 ||
          shape.width < pageSize.width - 0.02 || shape.height < pageSize.height - 0.02;
      }).map((shape) => {
        return {
          page: Number(page),
          type: shape.type,
          x: shape.x / pageSize.width,
          y: shape.y / pageSize.height,
          width: shape.width / pageSize.width,
          height: shape.height / pageSize.height,
          rotation: shape.rotation,
          radiusX: Math.max(0, shape.cornerRadius ?? 0) / pageSize.width,
          radiusY: Math.max(0, shape.cornerRadius ?? 0) / pageSize.height,
          color: shapeExportStyle(shape),
          text: shape.text ?? '',
          textStyle: shape.type === 'textfield' ? {
            color: shape.textColor ?? '#171717',
            fontFamily: shape.fontFamily ?? 'Helvetica',
            fontSize: shape.fontSize ?? 16,
            fontWeight: shape.fontWeight ?? 400,
            letterSpacing: shape.letterSpacing ?? 0,
            lineHeight: shape.lineHeight ?? 19.2,
            textAlign: shape.textAlign ?? 'left',
            verticalAlign: shape.verticalAlign ?? 'top',
            italic: Boolean(shape.italic),
            underline: Boolean(shape.underline),
            strikethrough: Boolean(shape.strikethrough)
          } : null,
          textStyleRanges: shape.type === 'textfield' ? shape.textStyleRanges ?? [] : [],
          imageData: shape.imageData ?? '',
          fieldName: shape.fieldName ?? '',
          fieldValue: shape.fieldValue ?? '',
          existingField: Boolean(shape.existingField)
        };
      });
    });
    const exportedHighlights = Object.entries(textHighlights).flatMap(([page, highlights]) => {
      const pageSize = pageSizes[Number(page)];
      if (!pageSize?.width || !pageSize.height) return [];
      return highlights.flatMap((highlight) => highlight.rects.map((rect, rectIndex) => ({
        id: `${highlight.type ?? 'highlight'}-${highlight.id}-${rectIndex}`,
        page: Number(page),
        type: highlight.type ?? 'highlight',
        x: rect.x / pageSize.width,
        y: rect.y / pageSize.height,
        width: rect.width / pageSize.width,
        height: rect.height / pageSize.height,
        rotation: 0,
        radiusX: 0,
        radiusY: 0,
        color: [...(rect.color ?? []), rect.thickness ?? 0],
        text: ''
      })));
    });
    const watermarks = appliedWatermarkText
      ? Array.from({ length: pageCount }, (_, page) => ({
          id: `watermark-${page}`,
          page,
          type: 'watermark',
          x: 0.08,
          y: 0.35,
          width: 0.84,
          height: 0.3,
          rotation: -32,
          radiusX: 0,
          radiusY: 0,
          color: [],
          text: appliedWatermarkText,
          imageData: '',
          fieldName: '',
          fieldValue: '',
          existingField: false
        }))
      : [];
    return [...strokes, ...exportedShapes, ...exportedHighlights, ...watermarks];
  }

  /** @param {{ id: string; page: number; x: number; y: number; width: number; height: number }[]} resolved */
  function applyResolvedTextHighlights(resolved) {
    const resolvedById = new Map(resolved.map((rect) => [rect.id, rect]));
    textHighlights = Object.fromEntries(Object.entries(textHighlights).map(([page, highlights]) => {
      const pageIndex = Number(page);
      const pageSize = pageSizes[pageIndex];
      if (!pageSize?.width || !pageSize.height) return [page, highlights];
      return [page, highlights.map((highlight) => ({
        ...highlight,
        rects: highlight.rects.map((rect, rectIndex) => {
          const resolvedRect = resolvedById.get(`${highlight.type ?? 'highlight'}-${highlight.id}-${rectIndex}`);
          if (!resolvedRect || resolvedRect.page !== pageIndex) return rect;
          return {
            ...rect,
            x: resolvedRect.x * pageSize.width,
            y: resolvedRect.y * pageSize.height,
            width: resolvedRect.width * pageSize.width,
            height: resolvedRect.height * pageSize.height
          };
        })
      }))];
    }));
  }

  export async function downloadPdf() {
    if (passwordUnlockOpen || unlockingPdf) {
      throw new Error('Unlock this password-protected PDF before downloading.');
    }
    let sourcePdf = await workingFile.arrayBuffer();
    if (htmlEditorStarted && htmlEditor?.applyTextEdits) {
      sourcePdf = await htmlEditor.applyTextEdits(sourcePdf);
    }
    const response = await fetch('/api/pdf/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfBase64: arrayBufferToBase64(sourcePdf),
        annotations: exportableAnnotations(),
        encryptionPassword: encryptionEnabled ? protectionPassword : ''
      })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? `PDF export failed (${response.status}).`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const baseName = workingFile.name.replace(/\.pdf$/i, '') || 'document';
    anchor.href = url;
    anchor.download = `${baseName}-edited.pdf`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  onDestroy(() => {
    loadGeneration += 1;
    pageDragCleanup?.();
    if (historyCommitTimer) clearTimeout(historyCommitTimer);
    if (searchUpdateFrame !== undefined) cancelAnimationFrame(searchUpdateFrame);
    stopSignatureCamera();
    cancelSharpRenders();
    textLayerBuilders.forEach((builder) => builder.cancel());
    textLayerAbortController?.abort();
    void pdfLoadingTask?.destroy();
    pdfDocument?.destroy?.();
  });
</script>

<aside
  class="editor-sidebar"
  aria-label="PDF pages"
  ondragover={handleExternalPdfSidebarDrag}
  ondragleave={(event) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) externalPdfDropIndex = null;
  }}
>
  <div class="thumbnail-list">
    {#each (pageDragPreviewOrder.length ? pageDragPreviewOrder : Array.from({ length: pageCount }, (_, index) => index)) as index (index)}
      <div
        role="listitem"
        data-page-index={index}
        class:dragging={Boolean(pagePointerDrag?.active && draggedPages.includes(index))}
        class="thumbnail-entry"
        animate:flip={{ duration: pageOperationBusy ? 0 : 220, easing: cubicOut }}
      >
        <button
          class:page-selected={selectedPages.has(index)}
          class="thumbnail-page"
          aria-label={`Go to page ${index + 1}`}
          aria-pressed={selectedPages.has(index)}
          aria-grabbed={Boolean(pagePointerDrag?.active && draggedPages.includes(index))}
          onclick={(event) => handlePageClick(index, event)}
          oncontextmenu={(event) => openPageContextMenu(event, index)}
          onpointerdown={(event) => beginPagePointerDrag(event, index)}
        >
          <span class="page-pill">{index + 1}/{pageCount}</span>
          <canvas></canvas>
          {#if appliedWatermarkText}
            <span class="thumbnail-watermark">{appliedWatermarkText}</span>
          {/if}
        </button>
        {#if index < pageCount - 1}
          <div
            class:pdf-drop-target={externalPdfDropIndex === index + 1}
            class="page-separator"
            role="presentation"
            ondragenter={(event) => showExternalPdfDropTarget(event, index + 1)}
            ondragover={(event) => showExternalPdfDropTarget(event, index + 1)}
            ondragleave={(event) => hideExternalPdfDropTarget(event, index + 1)}
            ondrop={(event) => dropExternalPdf(event, index + 1)}
          ></div>
        {/if}
      </div>
    {/each}
  </div>
</aside>

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
    {#if appliedWatermarkText}<span class="thumbnail-watermark">{appliedWatermarkText}</span>{/if}
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
    <button class="page-menu-item rotate-right" role="menuitem" disabled={pageOperationBusy} onclick={() => rotateSelectedPages(90)}>
      <img src="/pages/rotate-ccw.svg" alt="" />
      <span>Rotate Right</span>
      <kbd>R</kbd>
    </button>
    <button class="page-menu-item" role="menuitem" disabled={pageOperationBusy} onclick={() => rotateSelectedPages(-90)}>
      <img src="/pages/rotate-ccw.svg" alt="" />
      <span>Rotate Left</span>
      <kbd>L</kbd>
    </button>
    <button class="page-menu-item export-page" role="menuitem" disabled={pageOperationBusy} onclick={exportSelectedPages}>
      <img src="/pages/reply.svg" alt="" />
      <span>Export</span>
      <kbd>E</kbd>
    </button>
    <button class="page-menu-item" role="menuitem" disabled={pageOperationBusy} onclick={copySelectedPages}>
      <img src="/pages/copy.svg" alt="" />
      <span>Copy</span>
      <kbd>C</kbd>
    </button>
    <button class="page-menu-item" role="menuitem" disabled={!pageClipboard || pageOperationBusy} onclick={pastePages}>
      <img src="/pages/clipboard-plus.svg" alt="" />
      <span>Paste</span>
      <kbd>V</kbd>
    </button>
    <button
      class="page-menu-item delete-page"
      role="menuitem"
      disabled={selectedPages.size >= pageCount || pageOperationBusy}
      onclick={deleteSelectedPages}
    >
      <img src="/pages/trash.svg" alt="" />
      <span>Delete</span>
      <kbd>D</kbd>
    </button>
  </div>
{/if}

<section class="pdf-workspace" aria-label={`PDF editor for ${workingFile.name}`} bind:this={workspace}>
  {#if htmlEditorStarted}
    <div class:active={htmlViewportVisible} class="html-editor-layer">
      <HtmlPdfEditor
        bind:this={htmlEditor}
        bind:zoomLevel
        {activeTool}
        {zoomingOut}
        file={htmlTextEditBaseFile ?? workingFile}
        visualAnnotations={htmlVisualAnnotations}
        onEditorReady={handleHtmlEditorReady}
      />
    </div>
  {/if}
  <div
    class:editor-hidden={htmlViewportVisible}
    class:pan-mode={activeTool === 'pan'}
    class:panning={isPanning}
    class:zoom-mode={activeTool === 'zoom'}
    class:zoom-out={zoomingOut}
    class:drawing-mode={activeTool === 'marker' || activeTool === 'pen'}
    class:shape-mode={SHAPE_TOOLS.has(activeTool)}
    class:highlight-mode={TEXT_MARK_TOOLS.has(activeTool)}
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
    onpointerleave={handleViewerPointerLeave}
  >
    <div class="pdf-document" style:--zoom-level={zoomLevel}>
      {#each Array(pageCount) as _, index}
        {@const currentSelectedShapes = selectedShape?.pageIndex === index ? (shapes[index] ?? []).filter((shape) => selectedShapeIds.has(shape.id)) : []}
        {@const singleSelection = currentSelectedShapes.length === 1 ? currentSelectedShapes[0] : null}
        {@const currentSelection = currentSelectedShapes.length > 1 && multiSelectionFrame?.pageIndex === index && selectedShape ? frameAsShape(multiSelectionFrame, selectedShape.id) : singleSelection}
        {@const hoverSelection = hoveredShape?.pageIndex === index ? findShape(index, hoveredShape.id) : null}
        {@const cropShape = (shapes[index] ?? []).find((shape) => shape.type === 'crop')}
        {@const activeTextEditorShape = editingTextShape?.pageIndex === index
          ? (shapes[index] ?? []).find((shape) => shape.id === editingTextShape?.id) ?? null
          : null}
        <div class="pdf-page" aria-label={`Page ${index + 1}`}>
          <canvas></canvas>
          {#if appliedWatermarkText && pageSizes[index]}
            <svg
              class="annotation-layer watermark-layer"
              viewBox={`0 0 ${pageSizes[index].width} ${pageSizes[index].height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <text
                x={pageSizes[index].width / 2}
                y={pageSizes[index].height / 2}
                font-size={watermarkFontSize(appliedWatermarkText, pageSizes[index])}
                transform={`rotate(-32 ${pageSizes[index].width / 2} ${pageSizes[index].height / 2})`}
              >{appliedWatermarkText}</text>
            </svg>
          {/if}
          <svg
            class="annotation-layer search-highlight-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#each (searchMatches[index] ?? []) as rect}
              <rect
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                rx={Math.min(2, rect.height * 0.1)}
              />
            {/each}
          </svg>
          <svg
            class="annotation-layer marker-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#each (annotations[index] ?? []).filter((stroke) => stroke.type === 'marker') as stroke (stroke.id)}
              <path class="marker-edge" d={strokePath(stroke.points)} style:stroke={stroke.color ?? '#FFE43B'} style:stroke-width={`${(stroke.thickness ?? 16) * (1 + (stroke.falloff ?? 35) / 250)}px`} style:opacity={(stroke.opacity ?? 0.34) * (stroke.falloff ?? 35) / 100 * 0.72} />
              <path class="marker-ink" d={strokePath(stroke.points)} style:stroke={stroke.color ?? '#FFE43B'} style:stroke-width={`${stroke.thickness ?? 16}px`} style:opacity={stroke.opacity ?? 0.34} />
            {/each}
          </svg>
          <svg
            class="annotation-layer text-highlight-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#each (textHighlights[index] ?? []) as highlight (highlight.id)}
              {#each highlight.rects as rect}
                {#if (highlight.type ?? 'highlight') === 'highlight'}
                  <rect
                    class="text-highlight"
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    rx={Math.min(2, rect.height * 0.12)}
                    style:fill={textMarkCssColor(rect.color ?? [1, 0.894, 0.231])}
                  />
                {:else if ['underline', 'crossout'].includes(highlight.type ?? 'highlight')}
                  <line
                    class="text-decoration"
                    x1={rect.x}
                    y1={rect.y + rect.height * ((highlight.type ?? 'highlight') === 'underline' ? 0.9 : 0.52)}
                    x2={rect.x + rect.width}
                    y2={rect.y + rect.height * ((highlight.type ?? 'highlight') === 'underline' ? 0.9 : 0.52)}
                    stroke={textMarkCssColor(rect.color)}
                    style:--decoration-width={`${rect.thickness ?? Math.max(1.25, Math.min(2.2, rect.height * 0.09))}px`}
                  />
                {/if}
              {/each}
            {/each}
          </svg>
          <svg
            class="annotation-layer shape-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            style:--shape-ui-scale={1 / zoomLevel}
            aria-label={`Shapes on page ${index + 1}`}
          >
            {#each (shapes[index] ?? []) as shape (shape.id)}
              {@const wrappedTextLines = shape.type === 'textfield' ? styledTextFieldLines(shape) : []}
              <g
                transform={`rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`}
                style={shapeEffectStyle(shape)}
              >
                {#if shapePropertyPresent(shape, 'backgroundBlur') && shapePropertyEnabled(shape, 'backgroundBlur') && !['textfield', 'checkbox', 'input', 'crop', 'measure', 'line', 'arrow', 'check', 'cross'].includes(shape.type)}
                  <foreignObject x={shape.x} y={shape.y} width={shape.width} height={shape.height} class="shape-background-blur">
                    <div style={shapeBackdropStyle(shape)}></div>
                  </foreignObject>
                {/if}
                {#if shape.type === 'textfield'}
                  {#if editingTextShape?.pageIndex !== index || editingTextShape.id !== shape.id}
                    {@const displayedHeight = Math.max(shape.height, Math.max(1, wrappedTextLines.length) * Math.max(shape.fontSize ?? 16, shape.lineHeight ?? 19.2))}
                    {@const textStartY = textFieldStartY(shape, wrappedTextLines.length)}
                    <g
                      class="pdf-text-field-display"
                      class:placeholder={!shape.text}
                      data-shape-id={shape.id}
                      data-shape-page={index}
                    >
                      <rect
                        class="pdf-text-field-hit"
                        x={shape.x}
                        y={shape.y}
                        width={shape.width}
                        height={displayedHeight}
                      />
                      {#if shape.text}
                        {#each wrappedTextLines as line, lineIndex}
                          {@const lineAlignment = resolvedTextStyle(shape, line.start).textAlign}
                          {@const lineX = lineAlignment === 'center' ? shape.x + shape.width / 2 : lineAlignment === 'right' ? shape.x + shape.width - 6 : shape.x + 6}
                          {@const lineAnchor = lineAlignment === 'center' ? 'middle' : lineAlignment === 'right' ? 'end' : 'start'}
                          <text
                            x={lineX}
                            y={shape.y + textStartY + lineIndex * Math.max(shape.fontSize ?? 16, shape.lineHeight ?? 19.2)}
                            text-anchor={lineAnchor}
                          >{#each line.segments as segment}<tspan
                              fill={segment.style.color}
                              style:font-family={textFontStack(segment.style.fontFamily)}
                              font-size={`${segment.style.fontSize}px`}
                              font-weight={segment.style.fontWeight}
                              font-style={segment.style.italic ? 'italic' : 'normal'}
                              letter-spacing={`${segment.style.letterSpacing}px`}
                              text-decoration={`${segment.style.underline ? 'underline' : ''}${segment.style.underline && segment.style.strikethrough ? ' ' : ''}${segment.style.strikethrough ? 'line-through' : ''}` || 'none'}
                            >{segment.text}</tspan>{/each}</text>
                        {/each}
                      {:else}
                        <text x={shape.x + 6} y={shape.y + 15.2}>Type here</text>
                      {/if}
                    </g>
                  {/if}
                {:else if shape.type === 'signature' || shape.type === 'image'}
                  <image
                    class:pdf-signature={shape.type === 'signature'}
                    class:pdf-imported-image={shape.type === 'image'}
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    href={shape.imageData}
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                    preserveAspectRatio="none"
                    style={shapeClipStyle(shape)}
                  />
                  {#if shape.type === 'image' && shapePropertyPresent(shape, 'stroke') && shapePropertyEnabled(shape, 'stroke')}
                    <rect
                      class="pdf-imported-image-stroke"
                      x={shape.x}
                      y={shape.y}
                      width={shape.width}
                      height={shape.height}
                      rx={Math.max(0, shape.cornerRadius ?? 0)}
                    />
                  {/if}
                {:else if shape.type === 'checkbox' || shape.type === 'input' || shape.type === 'crop'}
                  <g></g>
                {:else if shape.type === 'rectangle'}
                  <rect
                    class="pdf-shape"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                    rx={Math.max(0, shape.cornerRadius ?? 0)}
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
                {:else if shape.type === 'measure'}
                  {@const measureY = shape.y + shape.height / 2}
                  {@const measurePrimary = measureDetails(shape.width).primary}
                  {@const measureSecondary = measureSecondaryLabel(shape)}
                  {@const measureBadgeWidth = Math.max(96, measurePrimary.length * 8.1, measureSecondary.length * 5.7) / zoomLevel}
                  {@const measureBadgeHeight = 37 / zoomLevel}
                  {@const measureBadgeX = shape.x + shape.width / 2 - measureBadgeWidth / 2}
                  {@const measureBadgeY = measureY - 50 / zoomLevel}
                  <line
                    class="shape-linear-hit measure-hit"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    x1={shape.x}
                    y1={measureY}
                    x2={shape.x + shape.width}
                    y2={measureY}
                  />
                  <line class="measure-halo" x1={shape.x} y1={measureY} x2={shape.x + shape.width} y2={measureY} />
                  <line class="measure-rule" x1={shape.x} y1={measureY} x2={shape.x + shape.width} y2={measureY} />
                  {#each Array(11) as _, tickIndex}
                    {@const isMajorTick = tickIndex === 0 || tickIndex === 5 || tickIndex === 10}
                    {@const tickHeight = (isMajorTick ? 10 : tickIndex % 5 === 0 ? 8 : 5.5) / zoomLevel}
                    <line
                      class:major={isMajorTick}
                      class="measure-tick"
                      x1={shape.x + shape.width * tickIndex / 10}
                      x2={shape.x + shape.width * tickIndex / 10}
                      y1={measureY - tickHeight}
                      y2={measureY + tickHeight}
                    />
                  {/each}
                  <circle class="measure-endpoint" cx={shape.x} cy={measureY} r={2.8 / zoomLevel} />
                  <circle class="measure-endpoint" cx={shape.x + shape.width} cy={measureY} r={2.8 / zoomLevel} />
                  <g
                    class="measure-badge"
                    transform={`rotate(${measureLabelFlip(shape.rotation)} ${shape.x + shape.width / 2} ${measureY})`}
                  >
                    <rect
                      x={measureBadgeX}
                      y={measureBadgeY}
                      width={measureBadgeWidth}
                      height={measureBadgeHeight}
                      rx={8 / zoomLevel}
                    />
                    <text
                      class="measure-primary"
                      x={shape.x + shape.width / 2}
                      y={measureBadgeY + 13 / zoomLevel}
                      font-size={13 / zoomLevel}
                    >{measurePrimary}</text>
                    <text
                      class="measure-secondary"
                      x={shape.x + shape.width / 2}
                      y={measureBadgeY + 27 / zoomLevel}
                      font-size={9.5 / zoomLevel}
                    >{measureSecondary}</text>
                    <path
                      class="measure-badge-pointer"
                      d={`M ${shape.x + shape.width / 2 - 5 / zoomLevel} ${measureBadgeY + measureBadgeHeight - 0.5 / zoomLevel} L ${shape.x + shape.width / 2} ${measureBadgeY + measureBadgeHeight + 5 / zoomLevel} L ${shape.x + shape.width / 2 + 5 / zoomLevel} ${measureBadgeY + measureBadgeHeight - 0.5 / zoomLevel} Z`}
                    />
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
                  <path
                    class="pdf-shape"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    d={roundedTrianglePath(shape)}
                    style:fill={shapeFill(shape)}
                    style:stroke={shapeStroke(shape)}
                  />
                {/if}
              </g>
            {/each}
          </svg>
          {#if hoverSelection && hoverSelection.type !== 'crop'}
            <svg
              class="annotation-layer shape-hover-layer"
              viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
              preserveAspectRatio="none"
              style:--shape-ui-scale={1 / zoomLevel}
              aria-hidden="true"
            >
              <g transform={`rotate(${hoverSelection.rotation} ${hoverSelection.x + hoverSelection.width / 2} ${hoverSelection.y + hoverSelection.height / 2})`}>
                {#if isLinearShape(hoverSelection)}
                  <line
                    class="shape-hover-line"
                    x1={hoverSelection.x}
                    y1={hoverSelection.y + hoverSelection.height / 2}
                    x2={hoverSelection.x + hoverSelection.width}
                    y2={hoverSelection.y + hoverSelection.height / 2}
                  />
                {:else}
                  <rect
                    class="shape-hover-box"
                    x={hoverSelection.x}
                    y={hoverSelection.y}
                    width={hoverSelection.width}
                    height={hoverSelection.height}
                  />
                {/if}
              </g>
            </svg>
          {/if}
          <div class="pdf-form-layer" aria-label={`Form fields on page ${index + 1}`}>
            {#each (shapes[index] ?? []).filter((shape) => shape.type === 'checkbox' || shape.type === 'input') as shape (shape.id)}
              <div
                class:existing={shape.existingField}
                class:readonly={shape.readOnly}
                class="pdf-form-widget"
                role="group"
                aria-label={shape.fieldName || (shape.type === 'checkbox' ? 'PDF checkbox' : 'PDF text input')}
                data-shape-id={shape.id}
                data-shape-page={index}
                style:left={`${shape.x}px`}
                style:top={`${shape.y}px`}
                style:width={`${shape.width}px`}
                style:height={`${shape.height}px`}
                onpointerdown={(event) => handlePdfFormPointerDown(event, index, shape)}
              >
                {#if shape.type === 'checkbox'}
                  <input
                    class="pdf-checkbox-field"
                    data-form-field={shape.id}
                    type="checkbox"
                    aria-label={shape.fieldName || 'PDF checkbox'}
                    checked={Boolean(shape.fieldValue)}
                    disabled={shape.readOnly}
                    onchange={(event) => updatePdfFormField(event, index, shape)}
                  />
                {:else}
                  <input
                    class="pdf-input-field"
                    data-form-field={shape.id}
                    type="text"
                    aria-label={shape.fieldName || 'PDF text input'}
                    value={String(shape.fieldValue ?? '')}
                    readonly={shape.readOnly}
                    oninput={(event) => updatePdfFormField(event, index, shape)}
                    onmousemove={(event) => updatePdfFormCursor(event, shape)}
                    ondblclick={(event) => {
                      event.stopPropagation();
                      event.currentTarget.focus();
                      event.currentTarget.select();
                    }}
                  />
                {/if}
              </div>
            {/each}
          </div>
          {#if cropShape}
            {@const cropPageWidth = pageSizes[index]?.width ?? 1}
            {@const cropPageHeight = pageSizes[index]?.height ?? 1}
            <svg
              class="annotation-layer crop-overlay-layer"
              viewBox={`0 0 ${cropPageWidth} ${cropPageHeight}`}
              preserveAspectRatio="none"
              style:--shape-ui-scale={1 / zoomLevel}
              aria-hidden="true"
            >
              <path
                class="crop-shade"
                fill-rule="evenodd"
                d={`M 0 0 H ${cropPageWidth} V ${cropPageHeight} H 0 Z M ${cropShape.x} ${cropShape.y} H ${cropShape.x + cropShape.width} V ${cropShape.y + cropShape.height} H ${cropShape.x} Z`}
              />
              {#if activeTool === 'crop'}
                <rect
                  class="crop-hit"
                  data-shape-id={cropShape.id}
                  data-shape-page={index}
                  x={cropShape.x}
                  y={cropShape.y}
                  width={cropShape.width}
                  height={cropShape.height}
                />
                <rect
                  class="crop-edge"
                  x={cropShape.x}
                  y={cropShape.y}
                  width={cropShape.width}
                  height={cropShape.height}
                />
                {#each [1 / 3, 2 / 3] as fraction}
                  <line
                    class="crop-grid"
                    x1={cropShape.x + cropShape.width * fraction}
                    x2={cropShape.x + cropShape.width * fraction}
                    y1={cropShape.y}
                    y2={cropShape.y + cropShape.height}
                  />
                  <line
                    class="crop-grid"
                    x1={cropShape.x}
                    x2={cropShape.x + cropShape.width}
                    y1={cropShape.y + cropShape.height * fraction}
                    y2={cropShape.y + cropShape.height * fraction}
                  />
                {/each}
                {#each [
                  ['0,-1', cropShape.x, cropShape.y, cropShape.x + cropShape.width, cropShape.y],
                  ['0,1', cropShape.x, cropShape.y + cropShape.height, cropShape.x + cropShape.width, cropShape.y + cropShape.height],
                  ['-1,0', cropShape.x, cropShape.y, cropShape.x, cropShape.y + cropShape.height],
                  ['1,0', cropShape.x + cropShape.width, cropShape.y, cropShape.x + cropShape.width, cropShape.y + cropShape.height]
                ] as edge}
                  <line
                    class="crop-resize-edge"
                    data-shape-id={cropShape.id}
                    data-shape-page={index}
                    data-shape-handle={edge[0]}
                    x1={Number(edge[1])}
                    y1={Number(edge[2])}
                    x2={Number(edge[3])}
                    y2={Number(edge[4])}
                    stroke-width={18 / zoomLevel}
                  />
                {/each}
                {#each [[-1, -1], [1, -1], [-1, 1], [1, 1]] as handle}
                  {@const cropHandleSize = 10 / zoomLevel}
                  {@const cropHandleX = cropShape.x + ((handle[0] + 1) * cropShape.width) / 2}
                  {@const cropHandleY = cropShape.y + ((handle[1] + 1) * cropShape.height) / 2}
                  <rect
                    class="crop-resize-handle"
                    data-shape-id={cropShape.id}
                    data-shape-page={index}
                    data-shape-handle={`${handle[0]},${handle[1]}`}
                    x={cropHandleX - cropHandleSize / 2}
                    y={cropHandleY - cropHandleSize / 2}
                    width={cropHandleSize}
                    height={cropHandleSize}
                    stroke-width={2 / zoomLevel}
                  />
                {/each}
              {/if}
            </svg>
          {/if}
          {#if currentSelection && currentSelection.type !== 'crop'}
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
                {#if currentSelection.type !== 'checkbox' && currentSelection.type !== 'input'}
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
                {/if}
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
              </g>
            </svg>
          {/if}
          {#if activeTextEditorShape?.type === 'textfield'}
            <div
              class="pdf-text-editor-overlay"
              data-shape-id={activeTextEditorShape.id}
              data-shape-page={index}
              style:left={`${activeTextEditorShape.x}px`}
              style:top={`${activeTextEditorShape.y}px`}
              style:width={`${activeTextEditorShape.width}px`}
              style:min-height={`${activeTextEditorShape.height}px`}
              style:transform={`rotate(${activeTextEditorShape.rotation}deg)`}
              style:transform-origin={`${activeTextEditorShape.width / 2}px ${activeTextEditorShape.height / 2}px`}
            >
              {#key textEditorRenderKey(activeTextEditorShape)}
              <div
                data-text-editor={activeTextEditorShape.id}
                data-min-height={activeTextEditorShape.height}
                contenteditable="true"
                tabindex="0"
                role="textbox"
                aria-multiline="true"
                aria-label="Edit text field"
                style:color={activeTextEditorShape.textColor ?? '#171717'}
                style:font-family={textFontStack(activeTextEditorShape.fontFamily)}
                style:font-size={`${Math.max(6, activeTextEditorShape.fontSize ?? 16)}px`}
                style:font-weight={activeTextEditorShape.fontWeight ?? 400}
                style:font-style={activeTextEditorShape.italic ? 'italic' : 'normal'}
                style:letter-spacing={`${activeTextEditorShape.letterSpacing ?? 0}px`}
                style:line-height={`${Math.max(activeTextEditorShape.fontSize ?? 16, activeTextEditorShape.lineHeight ?? 19.2)}px`}
                style:text-align={activeTextEditorShape.textAlign ?? 'left'}
                style:text-decoration={`${activeTextEditorShape.underline ? 'underline' : ''}${activeTextEditorShape.underline && activeTextEditorShape.strikethrough ? ' ' : ''}${activeTextEditorShape.strikethrough ? 'line-through' : ''}` || 'none'}
                oninput={updateTextField}
                onkeydown={handleTextFieldKeydown}
                onpointerdown={handleTextEditorPointerDown}
                onpointerup={(event) => captureTextFormatSelection(event, index, activeTextEditorShape.id)}
                onkeyup={(event) => captureTextFormatSelection(event, index, activeTextEditorShape.id)}
                onmousedown={(event) => event.stopPropagation()}
                onclick={(event) => event.stopPropagation()}
                onblur={(event) => retainTextEditorFocus(event, activeTextEditorShape.id)}
              >{#each editableTextParagraphs(activeTextEditorShape) as paragraph}<div
                  data-text-paragraph
                  data-start={paragraph.start}
                  data-end={paragraph.end}
                  style:text-align={paragraph.alignment}
                  >{#each paragraph.segments as segment}<span
                    style:display={segment.alignmentOverride ? 'block' : 'inline'}
                    style:width={segment.alignmentOverride ? '100%' : null}
                    style:text-align={segment.alignmentOverride ?? null}
                    style:color={segment.style.color}
                    style:font-family={textFontStack(segment.style.fontFamily)}
                    style:font-size={`${segment.style.fontSize}px`}
                    style:font-weight={segment.style.fontWeight}
                    style:font-style={segment.style.italic ? 'italic' : 'normal'}
                    style:letter-spacing={`${segment.style.letterSpacing}px`}
                    style:text-decoration={`${segment.style.underline ? 'underline' : ''}${segment.style.underline && segment.style.strikethrough ? ' ' : ''}${segment.style.strikethrough ? 'line-through' : ''}` || 'none'}
                  >{segment.text}</span>{/each}{#if !paragraph.segments.length}<br />{/if}</div>{/each}</div>
              {/key}
            </div>
          {/if}
          <svg
            class="annotation-layer pen-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#each (annotations[index] ?? []).filter((stroke) => stroke.type === 'pen') as stroke (stroke.id)}
              <path class="pen-soft-edge" d={strokePath(stroke.points)} style:stroke={stroke.color ?? '#E21D32'} style:stroke-width={`${(stroke.thickness ?? 2.05) + 1.35}px`} style:opacity={(stroke.opacity ?? 0.94) * 0.16} />
              <path class="pen-ink" d={strokePath(stroke.points)} style:stroke={stroke.color ?? '#E21D32'} style:stroke-width={`${stroke.thickness ?? 2.05}px`} style:opacity={stroke.opacity ?? 0.94} />
            {/each}
          </svg>
          <svg
            class="annotation-layer redaction-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#each (textHighlights[index] ?? []).filter((mark) => mark.type === 'blackout' || mark.type === 'whiteout') as redaction (redaction.id)}
              {#each redaction.rects as rect}
                <rect
                  class:blackout={redaction.type === 'blackout'}
                  class:whiteout={redaction.type === 'whiteout'}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                />
              {/each}
            {/each}
          </svg>
          {#if pdfTextSelection?.pages[index]?.length}
            <svg
              class="annotation-layer native-selection-layer"
              viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {#each pdfTextSelection.pages[index] as rect}
                <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} />
              {/each}
            </svg>
          {/if}
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
  <input
    class="signature-upload-input"
    type="file"
    accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
    aria-label="Upload signature photo"
    bind:this={signatureUploadInput}
    onchange={uploadSignaturePhoto}
  />
  <input
    class="signature-upload-input"
    type="file"
    accept="image/*"
    aria-label="Import image"
    bind:this={imageUploadInput}
    onchange={importImageFile}
  />
  {#if cameraCaptureOpen}
    <div class="signature-camera-overlay" role="presentation" transition:fade={{ duration: 170 }}>
      <div class="signature-camera-card" role="dialog" aria-modal="true" aria-label="Take signature photo" transition:fly={{ y: 10, duration: 230, easing: cubicOut }}>
        <div class="signature-camera-preview">
          <video bind:this={signatureCameraVideo} autoplay playsinline muted></video>
          <div class="signature-camera-guide" bind:this={signatureCameraFrame}></div>
          <button class="signature-camera-close" type="button" aria-label="Close camera" onclick={closeSignatureCamera}>
            <span></span><span></span>
          </button>
          {#if cameraStarting}<div class="signature-camera-status">Starting camera…</div>{/if}
          {#if cameraError}<div class="signature-camera-status error">{cameraError}</div>{/if}
        </div>
        <footer class="signature-camera-footer">
          <span>Place Signature inside Frame</span>
          <button class="signature-action primary" type="button" disabled={cameraStarting || signatureProcessing || Boolean(cameraError)} onclick={captureSignaturePhoto}>
            <img src="/camera.svg" alt="" />
            <span>{signatureProcessing ? 'Extracting…' : 'Take Photo'}</span>
          </button>
        </footer>
      </div>
    </div>
  {/if}
  {#if signatureDrawOpen}
    <div class="signature-camera-overlay" role="presentation" transition:fade={{ duration: 170 }}>
      <div class="signature-camera-card signature-draw-card" role="dialog" aria-modal="true" aria-label="Draw signature" transition:fly={{ y: 10, duration: 230, easing: cubicOut }}>
        <div class="signature-draw-field">
          <canvas
            bind:this={signatureDrawCanvas}
            aria-label="Signature drawing field"
            onpointerdown={startSignatureDrawing}
            onpointermove={continueSignatureDrawing}
            onpointerup={finishSignatureDrawing}
            onpointercancel={finishSignatureDrawing}
          ></canvas>
          <div class="signature-draw-baseline"></div>
          <button class="signature-camera-close" type="button" aria-label="Close signature drawing" onclick={closeSignatureDrawPad}>
            <span></span><span></span>
          </button>
        </div>
        <footer class="signature-camera-footer signature-draw-footer">
          <span>Draw your signature above the line</span>
          <div class="signature-draw-controls">
            <button class="signature-action secondary" type="button" disabled={!signatureDrawHasInk || signatureProcessing} onclick={clearSignatureDrawPad}>Clear</button>
            <button class="signature-action primary" type="button" disabled={!signatureDrawHasInk || signatureProcessing} onclick={saveDrawnSignature}>
              <span>{signatureProcessing ? 'Saving…' : 'Add Signature'}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  {/if}
  {#if activeTool === 'marker' || activeTool === 'pen'}
    {@const drawingIsMarker = activeTool === 'marker'}
    {@const drawingColor = drawingIsMarker ? markerColor : penColor}
    <div class="protect-panel selection-properties-panel drawing-properties-panel" role="dialog" aria-label={`${drawingIsMarker ? 'Marker' : 'Pen'} properties`} transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
      <header class="protect-panel-header">
        <img src={`/toolbar/small/${activeTool}.svg`} alt="" />
        <h2>{drawingIsMarker ? 'Marker' : 'Pen'}</h2>
        <button class="protect-panel-close" type="button" aria-label={`Close ${activeTool} properties`} onclick={() => { colorPicker = null; activeTool = 'select'; }}><span></span><span></span></button>
      </header>
      <div class="selection-properties-scroll">
        <section class="selection-property-section drawing-property-section" aria-label="Appearance">
          <div class="drawing-color-row">
            <span>Color</span>
            <input aria-label={`${activeTool} color hex`} value={drawingColor.replace('#', '').toUpperCase()} oninput={(event) => updateDrawingColor(drawingIsMarker ? 'marker' : 'pen', event.currentTarget.value)} />
            <button class="property-color" type="button" aria-label={`Open ${activeTool} color picker`} class:active={colorPicker?.property === `${activeTool}Color`} style:--property-color={drawingColor} onclick={() => openDrawingColorPicker(drawingIsMarker ? 'markerColor' : 'penColor')}></button>
          </div>
          <div class="drawing-number-grid">
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => drawingIsMarker ? markerThickness = value : penThickness = value, { step: 0.05, min: 0.5, max: 40 })}>Width</span><input class="scrubbable-number" type="number" min="0.5" max="40" step="0.25" value={drawingIsMarker ? markerThickness : penThickness} onpointerdown={(event) => startNumberScrub(event, (value) => drawingIsMarker ? markerThickness = value : penThickness = value, { step: 0.05, min: 0.5, max: 40 })} oninput={(event) => drawingIsMarker ? markerThickness = clamp(Number(event.currentTarget.value), 0.5, 40) : penThickness = clamp(Number(event.currentTarget.value), 0.5, 40)} /></label>
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => drawingIsMarker ? markerOpacity = value / 100 : penOpacity = value / 100, { min: 1, max: 100 })}>Opacity</span><input class="scrubbable-number" type="number" min="1" max="100" step="1" value={Math.round((drawingIsMarker ? markerOpacity : penOpacity) * 100)} onpointerdown={(event) => startNumberScrub(event, (value) => drawingIsMarker ? markerOpacity = value / 100 : penOpacity = value / 100, { min: 1, max: 100 })} oninput={(event) => drawingIsMarker ? markerOpacity = clamp(Number(event.currentTarget.value) / 100, 0.01, 1) : penOpacity = clamp(Number(event.currentTarget.value) / 100, 0.01, 1)} /><em>%</em></label>
          </div>
          {#if drawingIsMarker}
            <label class="inspector-field inspector-field-wide"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => markerFalloff = value, { min: 0, max: 100 })}>Falloff</span><input class="scrubbable-number" type="number" min="0" max="100" step="1" value={markerFalloff} onpointerdown={(event) => startNumberScrub(event, (value) => markerFalloff = value, { min: 0, max: 100 })} oninput={(event) => markerFalloff = clamp(Number(event.currentTarget.value), 0, 100)} /><em>%</em></label>
            <button class:active={markerStraighten} class="drawing-toggle" type="button" onclick={() => markerStraighten = !markerStraighten}><span>Straighten</span><em>{markerStraighten ? 'On' : 'Off'}</em></button>
          {:else}
            <label class="inspector-field inspector-field-wide"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => penSmoothing = value, { min: 0, max: 100 })}>Smoothing</span><input class="scrubbable-number" type="number" min="0" max="100" step="1" value={penSmoothing} onpointerdown={(event) => startNumberScrub(event, (value) => penSmoothing = value, { min: 0, max: 100 })} oninput={(event) => penSmoothing = clamp(Number(event.currentTarget.value), 0, 100)} /><em>%</em></label>
          {/if}
        </section>
      </div>
    </div>
    {#if colorPicker?.property === 'markerColor' || colorPicker?.property === 'penColor'}
      {@const pickerHex = hsvToHex(colorPicker.hue, colorPicker.saturation, colorPicker.value)}
      <div class="figma-color-picker drawing-color-picker" role="dialog" aria-label="Color picker" transition:fly={{ x: 8, duration: 190, easing: cubicOut }}>
        <div class="color-saturation" style:--picker-hue={`hsl(${colorPicker.hue} 100% 50%)`} role="slider" aria-label="Color saturation and brightness" aria-valuenow={Math.round(colorPicker.saturation * 100)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'saturation')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'saturation'); }}><span style:left={`${colorPicker.saturation * 100}%`} style:top={`${(1 - colorPicker.value) * 100}%`} style:--thumb-color={pickerHex}></span></div>
        <div class="picker-slider hue-slider" role="slider" aria-label="Hue" aria-valuenow={Math.round(colorPicker.hue)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'hue')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'hue'); }}><span style:left={`${colorPicker.hue / 360 * 100}%`} style:--thumb-color={pickerHex}></span></div>
        <div class="picker-slider alpha-slider" style:--picker-color={pickerHex} role="slider" aria-label="Color opacity" aria-valuenow={Math.round(colorPicker.alpha * 100)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'alpha')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'alpha'); }}><span style:left={`${colorPicker.alpha * 100}%`} style:--thumb-color={colorWithAlpha(pickerHex, colorPicker.alpha)}></span></div>
      </div>
    {/if}
  {/if}
  {#if ['highlight', 'underline', 'crossout'].includes(activeTool)}
    {@const textMarkPanelType = /** @type {'highlight' | 'underline' | 'crossout'} */ (activeTool)}
    {@const textMarkPanelLabel = textMarkPanelType === 'crossout' ? 'Crossout' : textMarkPanelType[0].toUpperCase() + textMarkPanelType.slice(1)}
    {@const textMarkPanelColor = textMarkPanelType === 'highlight' ? selectionHighlightColor : textMarkPanelType === 'underline' ? selectionUnderlineColor : selectionCrossoutColor}
    {@const textMarkPanelProperty = textMarkPanelType === 'highlight' ? 'selectionHighlightColor' : textMarkPanelType === 'underline' ? 'selectionUnderlineColor' : 'selectionCrossoutColor'}
    <div class="protect-panel selection-properties-panel text-tool-properties-panel" role="dialog" aria-label={`${textMarkPanelLabel} properties`} transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
      <header class="protect-panel-header">
        <img src={`/toolbar/small/${activeTool}.svg`} alt="" />
        <h2>{textMarkPanelLabel}</h2>
        <button class="protect-panel-close" type="button" aria-label={`Close ${textMarkPanelLabel} properties`} onclick={() => { colorPicker = null; activeTool = 'select'; }}><span></span><span></span></button>
      </header>
      <div class="selection-properties-scroll">
        <section class="selection-property-section drawing-property-section" aria-label="Appearance">
          <div class="drawing-color-row">
            <span>Color</span>
            <input aria-label={`${textMarkPanelLabel} color hex`} value={textMarkPanelColor.replace('#', '').toUpperCase()} oninput={(event) => updateSelectedPdfTextColor(textMarkPanelType, event.currentTarget.value)} />
            <button class="property-color" type="button" aria-label={`Open ${textMarkPanelLabel} color picker`} class:active={colorPicker?.property === textMarkPanelProperty} style:--property-color={textMarkPanelColor} onclick={() => openSelectionColorPicker(textMarkPanelProperty)}></button>
          </div>
          {#if textMarkPanelType !== 'highlight'}
            <label class="inspector-field inspector-field-wide"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedPdfTextThickness(textMarkPanelType, value), { step: 0.05, min: 0.5, max: 8 })}>Width</span><input class="scrubbable-number" type="number" min="0.5" max="8" step="0.25" value={textMarkPanelType === 'underline' ? selectionUnderlineThickness : selectionCrossoutThickness} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedPdfTextThickness(textMarkPanelType, value), { step: 0.05, min: 0.5, max: 8 })} oninput={(event) => updateSelectedPdfTextThickness(textMarkPanelType, Number(event.currentTarget.value))} /></label>
          {/if}
        </section>
      </div>
    </div>
    {#if colorPicker?.property === textMarkPanelProperty}
      {@const pickerHex = hsvToHex(colorPicker.hue, colorPicker.saturation, colorPicker.value)}
      <div class="figma-color-picker text-tool-color-picker" role="dialog" aria-label="Color picker" transition:fly={{ x: 8, duration: 190, easing: cubicOut }}>
        <div class="color-saturation" style:--picker-hue={`hsl(${colorPicker.hue} 100% 50%)`} role="slider" aria-label="Color saturation and brightness" aria-valuenow={Math.round(colorPicker.saturation * 100)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'saturation')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'saturation'); }}><span style:left={`${colorPicker.saturation * 100}%`} style:top={`${(1 - colorPicker.value) * 100}%`} style:--thumb-color={pickerHex}></span></div>
        <div class="picker-slider hue-slider" role="slider" aria-label="Hue" aria-valuenow={Math.round(colorPicker.hue)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'hue')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'hue'); }}><span style:left={`${colorPicker.hue / 360 * 100}%`} style:--thumb-color={pickerHex}></span></div>
      </div>
    {/if}
  {/if}
  {#if activeTool === 'select' && pdfTextSelection}
    <div class="protect-panel selection-properties-panel text-selection-panel" role="dialog" aria-label="Selected text properties" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
      <header class="protect-panel-header">
        <img src="/toolbar/small/select.svg" alt="" />
        <h2>Select</h2>
        <button class="protect-panel-close" type="button" aria-label="Close text properties" onclick={() => { pdfTextSelection = null; window.getSelection()?.removeAllRanges(); }}><span></span><span></span></button>
      </header>
      <div class="selection-properties-scroll">
        <section class="selection-property-section text-mark-properties" aria-label="Text annotations">
          <div class="text-mark-row decorated-mark-row">
            <button class:active={pdfTextSelection.active.underline} type="button" onmousedown={(event) => event.preventDefault()} onclick={() => toggleSelectedPdfTextMark('underline')}>Underline</button>
            <input class="text-mark-thickness scrubbable-number" aria-label="Underline thickness" type="number" min="0.5" max="8" step="0.25" value={selectionUnderlineThickness} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedPdfTextThickness('underline', value), { step: 0.05, min: 0.5, max: 8 })} oninput={(event) => updateSelectedPdfTextThickness('underline', Number(event.currentTarget.value))} />
            <input class="text-mark-hex" aria-label="Underline color" value={selectionUnderlineColor.replace('#', '')} oninput={(event) => updateSelectedPdfTextColor('underline', event.currentTarget.value)} />
            <button class="property-color text-mark-color" type="button" aria-label="Choose underline color" class:active={colorPicker?.property === 'selectionUnderlineColor'} style:--property-color={selectionUnderlineColor} onmousedown={(event) => event.preventDefault()} onclick={() => openSelectionColorPicker('selectionUnderlineColor')}></button>
          </div>
          <div class="text-mark-row decorated-mark-row">
            <button class:active={pdfTextSelection.active.crossout} type="button" onmousedown={(event) => event.preventDefault()} onclick={() => toggleSelectedPdfTextMark('crossout')}>Crossout</button>
            <input class="text-mark-thickness scrubbable-number" aria-label="Crossout thickness" type="number" min="0.5" max="8" step="0.25" value={selectionCrossoutThickness} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedPdfTextThickness('crossout', value), { step: 0.05, min: 0.5, max: 8 })} oninput={(event) => updateSelectedPdfTextThickness('crossout', Number(event.currentTarget.value))} />
            <input class="text-mark-hex" aria-label="Crossout color" value={selectionCrossoutColor.replace('#', '')} oninput={(event) => updateSelectedPdfTextColor('crossout', event.currentTarget.value)} />
            <button class="property-color text-mark-color" type="button" aria-label="Choose crossout color" class:active={colorPicker?.property === 'selectionCrossoutColor'} style:--property-color={selectionCrossoutColor} onmousedown={(event) => event.preventDefault()} onclick={() => openSelectionColorPicker('selectionCrossoutColor')}></button>
          </div>
          <div class="text-mark-row highlight-mark-row">
            <button class:active={pdfTextSelection.active.highlight} type="button" onmousedown={(event) => event.preventDefault()} onclick={() => toggleSelectedPdfTextMark('highlight')}>Highlight</button>
            <input class="text-mark-hex" aria-label="Highlight color" value={selectionHighlightColor.replace('#', '')} oninput={(event) => updateSelectedPdfTextColor('highlight', event.currentTarget.value)} />
            <button class="property-color text-mark-color" type="button" aria-label="Choose highlight color" class:active={colorPicker?.property === 'selectionHighlightColor'} style:--property-color={selectionHighlightColor} onmousedown={(event) => event.preventDefault()} onclick={() => openSelectionColorPicker('selectionHighlightColor')}></button>
          </div>
          <div class="text-redaction-grid">
            <button class:active={pdfTextSelection.active.blackout} type="button" onmousedown={(event) => event.preventDefault()} onclick={() => toggleSelectedPdfTextMark('blackout')}>Blackout</button>
            <button class:active={pdfTextSelection.active.whiteout} type="button" onmousedown={(event) => event.preventDefault()} onclick={() => toggleSelectedPdfTextMark('whiteout')}>Whiteout</button>
          </div>
        </section>
      </div>
    </div>
    {#if colorPicker?.property.startsWith('selection')}
      {@const pickerHex = hsvToHex(colorPicker.hue, colorPicker.saturation, colorPicker.value)}
      <div class="figma-color-picker text-selection-color-picker" role="dialog" aria-label="Color picker" transition:fly={{ x: 8, duration: 190, easing: cubicOut }}>
        <div class="color-saturation" style:--picker-hue={`hsl(${colorPicker.hue} 100% 50%)`} role="slider" aria-label="Color saturation and brightness" aria-valuenow={Math.round(colorPicker.saturation * 100)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'saturation')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'saturation'); }}>
          <span style:left={`${colorPicker.saturation * 100}%`} style:top={`${(1 - colorPicker.value) * 100}%`} style:--thumb-color={pickerHex}></span>
        </div>
        <div class="picker-slider hue-slider" role="slider" aria-label="Hue" aria-valuenow={Math.round(colorPicker.hue)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'hue')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'hue'); }}>
          <span style:left={`${colorPicker.hue / 360 * 100}%`} style:--thumb-color={pickerHex}></span>
        </div>
      </div>
    {/if}
  {/if}
  {#if activeTool === 'select' && selectedShape && inspectorSelection().length}
    {@const inspectedObjects = shapes && inspectorSelection()}
    {@const inspectedObject = inspectedObjects[0]}
    {@const inspectedFrame = shapes && inspectorFrame()}
    <div
      class="protect-panel selection-properties-panel"
      role="dialog"
      aria-label="Selected object properties"
      transition:fly={{ x: 18, duration: 240, easing: cubicOut }}
    >
      <header class="protect-panel-header">
        <img src="/toolbar/small/select.svg" alt="" />
        <h2>{inspectedObjects.length > 1 ? `${inspectedObjects.length} Selected` : 'Select'}</h2>
        <button class="protect-panel-close" type="button" aria-label="Close properties" onclick={closeSelectionPanel}>
          <span></span><span></span>
        </button>
      </header>
      <div class="selection-properties-scroll">
        {#if inspectedFrame}
          <section class="selection-property-section geometry-section" aria-label="Geometry">
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('x', value))}>X</span><input class="scrubbable-number" bind:this={inspectorXInput} type="number" step="1" value={Math.round(inspectedFrame.x)} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('x', value))} oninput={(event) => updateSelectionGeometry('x', Number(event.currentTarget.value))} /></label>
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('y', value))}>Y</span><input class="scrubbable-number" bind:this={inspectorYInput} type="number" step="1" value={Math.round(inspectedFrame.y)} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('y', value))} oninput={(event) => updateSelectionGeometry('y', Number(event.currentTarget.value))} /></label>
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('width', value), { min: 1 })}>W</span><input class="scrubbable-number" bind:this={inspectorWidthInput} type="number" min="1" step="1" value={Math.round(inspectedFrame.width)} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('width', value), { min: 1 })} oninput={(event) => updateSelectionGeometry('width', Number(event.currentTarget.value))} /></label>
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('height', value), { min: 1 })}>H</span><input class="scrubbable-number" bind:this={inspectorHeightInput} type="number" min="1" step="1" value={Math.round(inspectedFrame.height)} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('height', value), { min: 1 })} oninput={(event) => updateSelectionGeometry('height', Number(event.currentTarget.value))} /></label>
          </section>
          <section class="selection-property-section appearance-section" aria-label="Appearance">
            <label class="inspector-field opacity-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedShapes({ opacity: value / 100 }), { min: 0, max: 100 })}>Opacity</span><input class="scrubbable-number" type="number" min="0" max="100" step="1" value={Math.round((inspectedObject.opacity ?? 1) * 100)} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedShapes({ opacity: value / 100 }), { min: 0, max: 100 })} oninput={(event) => updateSelectedShapes({ opacity: clamp(Number(event.currentTarget.value) / 100, 0, 1) })} /><em>%</em></label>
            <label class="inspector-field corner-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedShapes({ cornerRadius: value * 10 }), { min: 0 })}>Corner</span><input class="scrubbable-number" type="number" min="0" step="1" value={Math.round((inspectedObject.cornerRadius ?? 0) / 10)} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedShapes({ cornerRadius: value * 10 }), { min: 0 })} oninput={(event) => updateSelectedShapes({ cornerRadius: Math.max(0, Number(event.currentTarget.value) * 10) })} /></label>
            <label class="inspector-field inspector-field-wide"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('rotation', value))}>Rotation</span><input class="scrubbable-number" bind:this={inspectorRotationInput} type="number" step="1" value={Math.round(inspectedObjects.length === 1 ? inspectedObject.rotation : (multiSelectionFrame?.rotation ?? 0))} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectionGeometry('rotation', value))} oninput={(event) => updateSelectionGeometry('rotation', Number(event.currentTarget.value))} /><em>°</em></label>
          </section>
        {/if}
        {#if inspectedObjects.length === 1 && inspectedObject.type === 'textfield'}
          <section class="selection-property-section typography-section" aria-label="Typography">
            <div class="typography-color-row">
              <span>Color</span>
              <input aria-label="Text color hex" value={String(textFormattingValue(inspectedObject, 'textColor') ?? '#171717').replace('#', '').toUpperCase()} oninput={(event) => updateSelectedTextColor(event.currentTarget.value)} />
              <button class="property-color" type="button" aria-label="Open text color picker" class:active={colorPicker?.property === 'textColor'} style:--property-color={String(textFormattingValue(inspectedObject, 'textColor') ?? '#171717')} onclick={() => openColorPicker('textColor')}></button>
            </div>
            <label class="typography-select-row">
              <span>Font</span>
              <select value={String(textFormattingValue(inspectedObject, 'fontFamily') ?? 'Helvetica')} onchange={(event) => updateTextFormatting({ fontFamily: event.currentTarget.value })}>
                <option value="Helvetica">Helvetica</option>
                <option value="Arial">Arial</option>
                <option value="Times New Roman">Times New Roman</option>
                <option value="Georgia">Georgia</option>
                <option value="Courier New">Courier New</option>
                <option value="Inter">Inter</option>
                <option value="Geist">Geist</option>
              </select>
            </label>
            <div class="typography-weight-size-grid">
              <label class="typography-select-row compact-weight-row">
                <span>Weight</span>
                <select value={String(textFormattingValue(inspectedObject, 'fontWeight') ?? 400)} onchange={(event) => updateTextFormatting({ fontWeight: Number(event.currentTarget.value) })}>
                  <option value="300">Light</option>
                  <option value="400">Regular</option>
                  <option value="500">Medium</option>
                  <option value="600">Semibold</option>
                  <option value="700">Bold</option>
                  <option value="800">Extra Bold</option>
                </select>
              </label>
              <label class="inspector-field typography-size-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateTextFormatting({ fontSize: value }), { step: 0.1, min: 6, max: 200 })}>Size</span><input class="scrubbable-number" type="number" min="6" max="200" step="0.5" value={Number(textFormattingValue(inspectedObject, 'fontSize') ?? 16)} onpointerdown={(event) => startNumberScrub(event, (value) => updateTextFormatting({ fontSize: value }), { step: 0.1, min: 6, max: 200 })} oninput={(event) => updateTextFormatting({ fontSize: Math.max(6, Number(event.currentTarget.value)) })} /></label>
            </div>
            <div class="typography-spacing-grid">
              <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateTextFormatting({ letterSpacing: value }), { step: 0.05, min: -5, max: 20 })}>Letter</span><input class="scrubbable-number" type="number" min="-5" max="20" step="0.1" value={inspectedObject.letterSpacing ?? 0} onpointerdown={(event) => startNumberScrub(event, (value) => updateTextFormatting({ letterSpacing: value }), { step: 0.05, min: -5, max: 20 })} oninput={(event) => updateTextFormatting({ letterSpacing: Number(event.currentTarget.value) })} /></label>
              <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateTextFormatting({ lineHeight: value }), { step: 0.1, min: 8, max: 80 })}>Line</span><input class="scrubbable-number" type="number" min="8" max="80" step="0.5" value={inspectedObject.lineHeight ?? 19.2} onpointerdown={(event) => startNumberScrub(event, (value) => updateTextFormatting({ lineHeight: value }), { step: 0.1, min: 8, max: 80 })} oninput={(event) => updateTextFormatting({ lineHeight: Math.max(8, Number(event.currentTarget.value)) })} /></label>
            </div>
            <div class="typography-alignment-row">
              <span>Horizontal</span>
              <div class="typography-segments" aria-label="Horizontal text alignment">
                <button class:active={(textFormattingValue(inspectedObject, 'textAlign') ?? 'left') === 'left'} type="button" title="Align left" onclick={() => updateTextFormatting({ textAlign: 'left' })}><img src="/align/align-left.svg" alt="" /></button>
                <button class:active={textFormattingValue(inspectedObject, 'textAlign') === 'center'} type="button" title="Align center" onclick={() => updateTextFormatting({ textAlign: 'center' })}><img src="/align/align-center.svg" alt="" /></button>
                <button class:active={textFormattingValue(inspectedObject, 'textAlign') === 'right'} type="button" title="Align right" onclick={() => updateTextFormatting({ textAlign: 'right' })}><img src="/align/align-right.svg" alt="" /></button>
              </div>
            </div>
            <div class="typography-alignment-row">
              <span>Vertical</span>
              <div class="typography-segments" aria-label="Vertical text alignment">
                <button class:active={(inspectedObject.verticalAlign ?? 'top') === 'top'} type="button" title="Align top" onclick={() => updateTextFormatting({ verticalAlign: 'top' })}><img src="/align/align-top.svg" alt="" /></button>
                <button class:active={inspectedObject.verticalAlign === 'middle'} type="button" title="Align middle" onclick={() => updateTextFormatting({ verticalAlign: 'middle' })}><img src="/align/align-middle.svg" alt="" /></button>
                <button class:active={inspectedObject.verticalAlign === 'bottom'} type="button" title="Align bottom" onclick={() => updateTextFormatting({ verticalAlign: 'bottom' })}><img src="/align/align-bottom.svg" alt="" /></button>
              </div>
            </div>
            <div class="typography-style-row" aria-label="Text styles">
              <button class:active={Number(textFormattingValue(inspectedObject, 'fontWeight') ?? 400) >= 700} type="button" title="Bold" onclick={() => updateTextFormatting({ fontWeight: Number(textFormattingValue(inspectedObject, 'fontWeight') ?? 400) >= 700 ? 400 : 700 })}><b>B</b></button>
              <button class:active={Boolean(textFormattingValue(inspectedObject, 'italic'))} type="button" title="Italic" onclick={() => updateTextFormatting({ italic: !Boolean(textFormattingValue(inspectedObject, 'italic')) })}><i>I</i></button>
              <button class:active={Boolean(textFormattingValue(inspectedObject, 'underline'))} type="button" title="Underline" onclick={() => updateTextFormatting({ underline: !Boolean(textFormattingValue(inspectedObject, 'underline')) })}><u>U</u></button>
              <button class:active={Boolean(textFormattingValue(inspectedObject, 'strikethrough'))} type="button" title="Strikethrough" onclick={() => updateTextFormatting({ strikethrough: !Boolean(textFormattingValue(inspectedObject, 'strikethrough')) })}><s>S</s></button>
            </div>
          </section>
        {/if}
        {#if shapeHasFill(inspectedObject) || shapeSupportsStroke(inspectedObject)}
        <section class="selection-property-section object-properties" aria-label="Object properties">
          {#if shapeHasFill(inspectedObject)}
            <div class:property-disabled={!shapePropertyEnabled(inspectedObject, 'fill')} class="object-property-row color-property-row">
              <button class="property-visibility" type="button" aria-label="Toggle fill" aria-pressed={shapePropertyEnabled(inspectedObject, 'fill')} onclick={() => toggleShapeProperty('fill')}><img src={shapePropertyEnabled(inspectedObject, 'fill') ? '/eye.svg' : '/eye-off.svg'} alt="" /></button>
              <span class="property-name">Fill</span>
              <input class="property-hex" aria-label="Fill color hex" value={(inspectedObject.fillColor ?? '#FF4D55').replace('#', '').toUpperCase()} oninput={(event) => updateSelectedColor('fillColor', event.currentTarget.value)} />
              <button class="property-color" type="button" aria-label="Open fill color picker" class:active={colorPicker?.property === 'fillColor'} style:--property-color={shapeFill(inspectedObject)} onclick={() => openColorPicker('fillColor')}></button>
            </div>
          {/if}
          {#if shapeSupportsStroke(inspectedObject)}
            <div class:property-disabled={!shapePropertyEnabled(inspectedObject, 'stroke')} class="object-property-row stroke-property-row">
              <button class="property-visibility" type="button" aria-label="Toggle stroke" aria-pressed={shapePropertyEnabled(inspectedObject, 'stroke')} onclick={() => toggleShapeProperty('stroke')}><img src={shapePropertyEnabled(inspectedObject, 'stroke') ? '/eye.svg' : '/eye-off.svg'} alt="" /></button>
              <span class="property-name scrub-label" role="presentation" onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedShapes({ strokeWidth: value }), { step: 0.05, min: 0 })}>Stroke</span>
              <input class="property-number scrubbable-number" type="number" min="0" step="0.25" aria-label="Stroke width" value={inspectedObject.strokeWidth ?? (shapeHasFill(inspectedObject) ? 1.35 : 1.4)} onpointerdown={(event) => startNumberScrub(event, (value) => updateSelectedShapes({ strokeWidth: value }), { step: 0.05, min: 0 })} oninput={(event) => updateSelectedShapes({ strokeWidth: Math.max(0, Number(event.currentTarget.value)) })} />
              <input class="property-hex" aria-label="Stroke color hex" value={(inspectedObject.strokeColor ?? (shapeHasFill(inspectedObject) ? '#DE3542' : '#FF4D55')).replace('#', '').toUpperCase()} oninput={(event) => updateSelectedColor('strokeColor', event.currentTarget.value)} />
              <button class="property-color" type="button" aria-label="Open stroke color picker" class:active={colorPicker?.property === 'strokeColor'} style:--property-color={shapeStroke(inspectedObject)} onclick={() => openColorPicker('strokeColor')}></button>
            </div>
          {/if}
        </section>
        {/if}
      </div>
    </div>
    {#if colorPicker}
      {@const pickerHex = hsvToHex(colorPicker.hue, colorPicker.saturation, colorPicker.value)}
      <div class="figma-color-picker" role="dialog" aria-label="Color picker" transition:fly={{ x: 8, duration: 190, easing: cubicOut }}>
        <div
          class="color-saturation"
          style:--picker-hue={`hsl(${colorPicker.hue} 100% 50%)`}
          role="slider"
          aria-label="Color saturation and brightness"
          aria-valuenow={Math.round(colorPicker.saturation * 100)}
          tabindex="0"
          onpointerdown={(event) => updateColorControl(event, 'saturation')}
          onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'saturation'); }}
        >
          <span style:left={`${colorPicker.saturation * 100}%`} style:top={`${(1 - colorPicker.value) * 100}%`} style:--thumb-color={pickerHex}></span>
        </div>
        <div class="picker-slider hue-slider" role="slider" aria-label="Hue" aria-valuenow={Math.round(colorPicker.hue)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'hue')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'hue'); }}>
          <span style:left={`${colorPicker.hue / 360 * 100}%`} style:--thumb-color={pickerHex}></span>
        </div>
        {#if colorPicker.property !== 'textColor'}
          <div class="picker-slider alpha-slider" style:--picker-color={pickerHex} role="slider" aria-label="Color opacity" aria-valuenow={Math.round(colorPicker.alpha * 100)} tabindex="0" onpointerdown={(event) => updateColorControl(event, 'alpha')} onpointermove={(event) => { if (event.buttons) updateColorControl(event, 'alpha'); }}>
            <span style:left={`${colorPicker.alpha * 100}%`} style:--thumb-color={colorWithAlpha(pickerHex, colorPicker.alpha)}></span>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
  {#if searchPanelOpen}
    <div
      class="protect-panel search-panel"
      role="dialog"
      aria-label="Search PDF"
      transition:fly={{ x: 18, duration: 240, easing: cubicOut }}
    >
      <header class="protect-panel-header">
        <img src="/search.svg" alt="" />
        <h2>Search</h2>
        <button class="protect-panel-close" type="button" aria-label="Close search" onclick={closeSearchPanel}>
          <span></span>
          <span></span>
        </button>
      </header>
      <div class="search-panel-content">
        <div class="search-controls">
          <div class="password-field search-field">
            <input
              bind:this={searchInput}
              type="search"
              placeholder="Search"
              aria-label="Search document"
              value={searchQuery}
              oninput={handleSearchInput}
              onkeydown={handleSearchKeydown}
            />
          </div>
          <button
            class="search-direction search-previous"
            type="button"
            aria-label="Previous search result"
            disabled={activeSearchOccurrence <= 0}
            onclick={previousSearchOccurrence}
          >
            <img src="/arrowright.svg" alt="" />
          </button>
          <button
            class="search-direction search-next"
            type="button"
            aria-label="Next search result"
            disabled={activeSearchOccurrence < 0 || activeSearchOccurrence >= searchOccurrences.length - 1}
            onclick={nextSearchOccurrence}
          >
            <img src="/arrowright.svg" alt="" />
          </button>
        </div>
      </div>
    </div>
  {/if}
  {#if watermarkPanelOpen}
    <div
      class="protect-panel watermark-panel"
      role="dialog"
      aria-label="Watermark PDF"
      transition:fly={{ x: 18, duration: 240, easing: cubicOut }}
    >
      <header class="protect-panel-header">
        <img src="/toolbar/small/watermark.svg" alt="" />
        <h2>Watermark</h2>
        <button class="protect-panel-close" type="button" aria-label="Close watermark" onclick={closeWatermarkPanel}>
          <span></span>
          <span></span>
        </button>
      </header>
      <form class="watermark-panel-content" onsubmit={(event) => { event.preventDefault(); applyWatermark(); }}>
        <div class="password-field search-field">
          <input
            bind:this={watermarkInput}
            type="text"
            maxlength="80"
            placeholder="Watermark text"
            aria-label="Watermark text"
            bind:value={watermarkText}
          />
        </div>
        <button
          class:encrypted={Boolean(appliedWatermarkText)}
          class="protect-submit"
          type="submit"
          disabled={!watermarkText.trim() && !appliedWatermarkText}
        >
          {watermarkText.trim()
            ? (appliedWatermarkText ? 'Update Watermark' : 'Apply Watermark')
            : 'Remove Watermark'}
        </button>
      </form>
    </div>
  {/if}
  {#if protectPanelOpen}
    <div
      class:encrypted={encryptionEnabled}
      class:has-error={Boolean(protectionError)}
      class="protect-panel"
      role="dialog"
      aria-label="Password Protect"
      transition:fly={{ x: 18, duration: 240, easing: cubicOut }}
    >
      <header class="protect-panel-header">
        <img src="/lock.svg" alt="" />
        <h2>Password Protect</h2>
        <button class="protect-panel-close" type="button" aria-label="Close password protection" onclick={closeProtectPanel}>
          <span></span>
          <span></span>
        </button>
      </header>
      <form class="protect-panel-form" onsubmit={(event) => { event.preventDefault(); submitProtection(); }}>
        <div class:has-error={Boolean(protectionError)} class="protect-fields">
          {#if encryptionEnabled}
            <div class="password-field" class:error={Boolean(protectionError)} in:fly={{ y: 8, duration: 220, easing: cubicOut }}>
              <input
                type={showDisableProtectionPassword ? 'text' : 'password'}
                placeholder="Password"
                aria-label="Password"
                autocomplete="current-password"
                bind:value={disableProtectionPassword}
                oninput={() => protectionError = ''}
              />
              <button
                class="password-visibility"
                type="button"
                aria-label={showDisableProtectionPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showDisableProtectionPassword}
                onclick={() => showDisableProtectionPassword = !showDisableProtectionPassword}
              >
                <img class:visible={!showDisableProtectionPassword} src="/eye.svg" alt="" />
                <img class:visible={showDisableProtectionPassword} src="/eye-off.svg" alt="" />
              </button>
            </div>
          {:else}
            <div class="password-fields-enter" in:fly={{ y: -8, duration: 220, easing: cubicOut }}>
              <div
                class="password-field"
                class:error={protectionError === 'Enter a password.' || protectionError === 'Password must be 32 bytes or fewer.'}
              >
                <input
                  type={showProtectionPassword ? 'text' : 'password'}
                  placeholder="Password"
                  aria-label="Password"
                  autocomplete="new-password"
                  bind:value={protectionPassword}
                  oninput={() => protectionError = ''}
                />
                <button
                  class="password-visibility"
                  type="button"
                  aria-label={showProtectionPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showProtectionPassword}
                  onclick={() => showProtectionPassword = !showProtectionPassword}
                >
                  <img class:visible={!showProtectionPassword} src="/eye.svg" alt="" />
                  <img class:visible={showProtectionPassword} src="/eye-off.svg" alt="" />
                </button>
              </div>
              <div class="password-field" class:error={protectionError === 'Passwords do not match.'}>
                <input
                  type={showProtectionConfirmPassword ? 'text' : 'password'}
                  placeholder="Confirm Password"
                  aria-label="Confirm password"
                  autocomplete="new-password"
                  bind:value={protectionConfirmPassword}
                  oninput={() => protectionError = ''}
                />
                <button
                  class="password-visibility"
                  type="button"
                  aria-label={showProtectionConfirmPassword ? 'Hide confirmed password' : 'Show confirmed password'}
                  aria-pressed={showProtectionConfirmPassword}
                  onclick={() => showProtectionConfirmPassword = !showProtectionConfirmPassword}
                >
                  <img class:visible={!showProtectionConfirmPassword} src="/eye.svg" alt="" />
                  <img class:visible={showProtectionConfirmPassword} src="/eye-off.svg" alt="" />
                </button>
              </div>
            </div>
          {/if}
          <p class:visible={Boolean(protectionError)} class="protection-error" aria-live="polite">{protectionError}</p>
        </div>
        <div class="protect-warning">
          <h3>Warning:</h3>
          <p>Full <span>AES-256 Encryption.</span> If you lose the Password, the file can NOT be restored.</p>
        </div>
        <footer class="protect-actions">
          <button class:encrypted={encryptionEnabled} class="protect-submit" type="submit">
            <img src="/lock.svg" alt="" />
            <span>{encryptionEnabled ? 'Disable Encryption' : 'Enable Encryption'}</span>
          </button>
        </footer>
      </form>
    </div>
  {/if}
  {#if signPanelOpen}
    <div
      class:has-signatures={savedSignatures.length > 0}
      class="protect-panel sign-panel"
      style={`--signature-count: ${Math.min(savedSignatures.length, 2)}`}
      role="dialog"
      aria-label="Sign"
      transition:fly={{ x: 18, duration: 240, easing: cubicOut }}
    >
      <header class="protect-panel-header sign-panel-header">
        <img src="/toolbar/small/sign.svg" alt="" />
        <h2>Sign</h2>
        <button
          class="protect-panel-close"
          type="button"
          aria-label="Close signatures"
          onclick={closeSignPanel}
        >
          <span></span>
          <span></span>
        </button>
      </header>
      <div class="saved-signature-content">
        {#if savedSignatures.length > 0}
          <div class="saved-signature-list">
            {#each savedSignatures as signature (signature.id)}
              <div class="saved-signature-row">
                <button class="saved-signature" type="button" aria-label={`Insert ${signature.name}`} onclick={() => insertSavedSignature(signature)}>
                  <img src={signature.imageUrl} alt={signature.name} />
                </button>
                <button class="saved-signature-remove" type="button" aria-label={`Delete ${signature.name}`} onclick={(event) => removeSavedSignature(event, signature.id)}>
                  <span></span><span></span>
                </button>
              </div>
            {/each}
          </div>
        {/if}
        <footer class="saved-signature-actions">
          <button class="signature-action secondary" type="button" onclick={openAddSignaturePanel}>
            <span class="signature-plus" aria-hidden="true"></span>
            <span>Add Signature</span>
          </button>
        </footer>
      </div>
    </div>

    {#if addSignaturePanelOpen}
      <div
        class:below-signatures={savedSignatures.length > 0}
        class:draw-mode={signatureTab === 'draw'}
        class="protect-panel add-signature-panel"
        style:top={`${savedSignatures.length > 0 ? Math.min(300, 132 + Math.min(savedSignatures.length, 2) * 112) + 32 : 164}px`}
        role="dialog"
        aria-label="Add Signature"
        transition:fly={{ y: -10, duration: 240, easing: cubicOut }}
      >
        <header class="protect-panel-header sign-panel-header">
          <img src="/toolbar/small/sign.svg" alt="" />
          <h2>Add Signature</h2>
          <button class="protect-panel-close" type="button" aria-label="Close add signature" onclick={closeAddSignaturePanel}>
            <span></span>
            <span></span>
          </button>
        </header>
        <div class="add-signature-content">
          <div class="signature-tabs" role="tablist" aria-label="Signature method">
            <span
              class="signature-tab-indicator"
              style={`transform: translateX(${signatureTab === 'draw' ? 0 : 100}%);`}
            ></span>
            <button class:active={signatureTab === 'draw'} type="button" role="tab" aria-selected={signatureTab === 'draw'} onclick={() => signatureTab = 'draw'}>Draw</button>
            <button class:active={signatureTab === 'image'} type="button" role="tab" aria-selected={signatureTab === 'image'} onclick={() => signatureTab = 'image'}>Image</button>
          </div>

          <div class="signature-tab-content">
            {#key signatureTab}
              <div class="signature-tab-copy" in:fly={{ x: 8, duration: 210, easing: cubicOut }} out:fade={{ duration: 100 }}>
                {#if signatureTab === 'image'}
                  <p>Write your signature on paper and take a photo or upload a photo of your signature.</p>
                {:else if signatureTab === 'draw'}
                  <p>Draw your signature using your mouse, trackpad, or touchscreen.</p>
                {/if}
                {#if cameraError}<p class="signature-processing-error">{cameraError}</p>{/if}
              </div>
            {/key}
          </div>

          <footer class="signature-actions">
            {#if signatureTab === 'image'}
              <button class="signature-action primary" type="button" disabled={signatureProcessing} onclick={openSignatureCamera}>
                <img src="/camera.svg" alt="" />
                <span>Take Photo</span>
              </button>
              <button class="signature-action secondary" type="button" disabled={signatureProcessing} onclick={chooseSignaturePhoto}>
                <span class="signature-plus" aria-hidden="true"></span>
                <span>{signatureProcessing ? 'Extracting…' : 'Upload Photo'}</span>
              </button>
            {:else}
              <button class="signature-action primary" type="button" onclick={openSignatureDrawPad}>
                <img src="/toolbar/small/sign.svg" alt="" />
                <span>Draw Signature</span>
              </button>
            {/if}
          </footer>
        </div>
      </div>
    {/if}
  {/if}
  {#if passwordUnlockOpen}
    <div class="preparation-overlay password-unlock-overlay" role="presentation">
      <div
        class:has-error={Boolean(passwordUnlockError)}
        class="protect-panel encrypted unlock-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Unlock password protected PDF"
        transition:fly={{ y: 10, duration: 240, easing: cubicOut }}
      >
        <header class="protect-panel-header">
          <img src="/lock.svg" alt="" />
          <h2>Password Protect</h2>
          <button class="protect-panel-close" type="button" aria-label="Close encrypted document" onclick={onRequestClose}>
            <span></span>
            <span></span>
          </button>
        </header>
        <form class="protect-panel-form" onsubmit={(event) => { event.preventDefault(); void disableImportedEncryption(); }}>
          <div class:has-error={Boolean(passwordUnlockError)} class="protect-fields">
            <div class="password-field" class:error={Boolean(passwordUnlockError)}>
              <input
                type={showPasswordUnlockValue ? 'text' : 'password'}
                placeholder="Password"
                aria-label="Password"
                autocomplete="current-password"
                bind:value={passwordUnlockValue}
                oninput={() => passwordUnlockError = ''}
              />
              <button
                class="password-visibility"
                type="button"
                aria-label={showPasswordUnlockValue ? 'Hide password' : 'Show password'}
                aria-pressed={showPasswordUnlockValue}
                onclick={() => showPasswordUnlockValue = !showPasswordUnlockValue}
              >
                <img class:visible={!showPasswordUnlockValue} src="/eye.svg" alt="" />
                <img class:visible={showPasswordUnlockValue} src="/eye-off.svg" alt="" />
              </button>
            </div>
            <p class:visible={Boolean(passwordUnlockError)} class="protection-error" aria-live="polite">{passwordUnlockError}</p>
          </div>
          <div class="protect-warning">
            <h3>Warning:</h3>
            <p>Full <span>AES-256 Encryption.</span> If you lose the Password, the file can NOT be restored.</p>
          </div>
          <footer class="protect-actions">
            <button class="protect-submit encrypted" type="submit" disabled={unlockingPdf}>
              <img src="/lock.svg" alt="" />
              <span>{unlockingPdf ? 'Disabling Encryption…' : 'Disable Encryption'}</span>
            </button>
          </footer>
        </form>
      </div>
    </div>
  {/if}
  {#if editorTransition}
    <div class="preparation-overlay" role="presentation">
      <div class="preparation-dialog" role="dialog" aria-modal="true" aria-label={editorTransition}>
        <img class="preparation-spinner" src="/spinner.svg" alt="" />
        <span class="preparation-text">{editorTransition}</span>
      </div>
    </div>
  {/if}
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
    position: relative;
    width: 244px;
    transition: opacity 120ms ease, visibility 120ms ease;
  }

  .thumbnail-entry.dragging {
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
  }

  :global(html.page-dragging),
  :global(html.page-dragging *) {
    cursor: grabbing !important;
    user-select: none !important;
  }

  .page-drag-ghost {
    position: fixed;
    z-index: 80;
    box-sizing: border-box;
    overflow: visible;
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 0 0 2px #529dff, 0 24px 48px rgba(0, 0, 0, 0.25), 0 7px 16px rgba(0, 0, 0, 0.14);
    opacity: 1;
    will-change: transform;
    pointer-events: none;
  }

  .page-drag-ghost > img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 8px;
  }

  .page-drag-count {
    position: absolute;
    right: 9px;
    bottom: 9px;
    padding: 5px 8px;
    border-radius: 999px;
    background: rgba(23, 23, 23, 0.86);
    color: #fff;
    font-family: Geist, Inter, sans-serif;
    font-size: 12px;
    line-height: 1;
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

  .thumbnail-watermark {
    position: absolute;
    z-index: 2;
    top: 50%;
    left: 50%;
    max-width: 82%;
    overflow: hidden;
    color: rgba(80, 87, 97, 0.2);
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 20px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0.02em;
    text-overflow: clip;
    white-space: nowrap;
    transform: translate(-50%, -50%) rotate(-32deg);
    transform-origin: center;
    pointer-events: none;
    mix-blend-mode: multiply;
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
    position: relative;
    width: 100%;
    height: 46.2px;
    margin: 0;
  }

  .page-separator::before {
    position: absolute;
    top: 20px;
    right: 0;
    left: 0;
    height: 1.2px;
    background: #d5d5d5;
    content: '';
    transition: height 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
  }

  .page-separator::after {
    position: absolute;
    top: 20.6px;
    left: 50%;
    box-sizing: border-box;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 11h14M12 4v14' fill='none' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / 24px 24px no-repeat,
      #1684f8;
    box-shadow: 0 2px 7px rgba(22, 132, 248, 0.28);
    content: '';
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, -50%) scale(0.72);
    transition: opacity 140ms ease, transform 170ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .page-separator.pdf-drop-target::before {
    height: 2px;
    background: #1684f8;
    box-shadow: 0 0 0 0.5px rgba(22, 132, 248, 0.12);
  }

  .page-separator.pdf-drop-target::after {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }

  .page-context-menu {
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

  .page-menu-item {
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

  .page-menu-item:hover:not(:disabled),
  .page-menu-item:focus-visible {
    border-color: rgba(0, 0, 0, 0.07);
    background: rgba(234, 234, 234, 0.62);
    color: #111;
    outline: none;
    transform: translateX(1px);
  }

  .page-menu-item img {
    display: block;
    width: 20px;
    height: 20px;
    object-fit: contain;
    transform: translateX(-2px);
    transition: filter 180ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 180ms ease;
  }

  .page-menu-item.rotate-right img {
    transform: translateX(-2px) scaleX(-1);
  }

  .page-menu-item.export-page img {
    width: 24px;
    height: 24px;
  }

  .page-menu-item:hover:not(:disabled):not(.delete-page) img,
  .page-menu-item:focus-visible:not(:disabled):not(.delete-page) img {
    filter: brightness(0);
  }

  .page-menu-item kbd {
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

  .page-menu-item:hover:not(:disabled) kbd,
  .page-menu-item:focus-visible:not(:disabled) kbd {
    border-color: rgba(0, 0, 0, 0.06);
    background: rgba(0, 0, 0, 0.065);
    color: rgba(0, 0, 0, 0.34);
  }

  .page-menu-item:disabled {
    color: rgba(63, 63, 63, 0.34);
    cursor: default;
  }

  .page-menu-item:disabled img {
    opacity: 0.32;
  }

  .page-menu-item.delete-page:not(:disabled) {
    color: #ff2f38;
  }

  .pdf-workspace {
    position: relative;
    grid-column: 2;
    grid-row: 2;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #f5f5f5;
  }

  .protect-panel {
    position: absolute;
    z-index: 40;
    top: 20px;
    right: 18px;
    display: grid;
    grid-template-rows: 50px 1fr;
    box-sizing: border-box;
    width: min(320px, calc(100% - 36px));
    height: 392px;
    max-height: calc(100% - 40px);
    overflow: hidden;
    border: 1.5px solid #c5c5c5;
    border-radius: 13px;
    background: #fafafa;
    box-shadow: 0 9px 24px rgba(0, 0, 0, 0.07);
    color: #000;
    font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    transition: height 300ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms ease;
    -webkit-font-smoothing: antialiased;
  }

  .protect-panel.encrypted {
    height: 342px;
  }

  .protect-panel.search-panel {
    height: 126px;
  }

  .protect-panel.watermark-panel {
    height: 179px;
  }

  .protect-panel.selection-properties-panel {
    height: auto;
    max-height: calc(100% - 40px);
  }

  .protect-panel.text-selection-panel {
    max-height: none;
    font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 18px;
    font-style: normal;
    font-weight: 400;
    font-variation-settings: "wght" 400;
  }

  .text-selection-panel button,
  .text-selection-panel input {
    font-family: inherit;
    font-style: normal;
    font-weight: 400;
    font-variation-settings: "wght" 400;
    font-size: 18px;
  }

  .text-mark-properties {
    display: grid;
    gap: 9px;
    border-bottom: 0;
  }

  .drawing-property-section {
    display: grid;
    gap: 10px;
    border-bottom: 0;
  }

  .drawing-color-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 40px;
    align-items: center;
    min-height: 39px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    font-size: 18px;
  }

  .drawing-color-row > span { padding-left: 12px; color: #7a7a7a; }
  .drawing-color-row input {
    min-width: 0;
    padding: 0 8px;
    border: 0;
    outline: 0;
    background: transparent;
    color: #111;
    font: inherit;
    text-align: right;
  }

  .drawing-color-row .property-color { justify-self: center; }

  .drawing-number-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
  }

  .drawing-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 39px;
    padding: 0 12px;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    color: #111;
    font: inherit;
    font-size: 18px;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
  }

  .drawing-toggle em { color: #7a7a7a; font-style: normal; transition: color 150ms ease; }
  .drawing-toggle.active { border-color: #111; background: #111; color: #fff; }
  .drawing-toggle.active em { color: #fff; }
  .figma-color-picker.drawing-color-picker { top: 118px; }
  .figma-color-picker.text-tool-color-picker { top: 118px; }

  .text-mark-row {
    display: grid;
    align-items: center;
    box-sizing: border-box;
    height: 39px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
  }

  .decorated-mark-row {
    grid-template-columns: minmax(0, 1fr) 48px 68px 38px;
  }

  .highlight-mark-row {
    grid-template-columns: minmax(0, 1fr) 82px 38px;
  }

  .text-mark-row button {
    align-self: stretch;
    padding: 0 10px;
    border: 0;
    border-right: 1px solid #d7d7d7;
    background: transparent;
    color: #111;
    font: inherit;
    font-size: 18px;
    text-align: left;
    cursor: pointer;
  }

  .text-mark-row > button:first-child:hover { background: #eaeaea; }

  .text-mark-row > button:first-child.active,
  .text-redaction-grid button.active {
    border-color: #111;
    background: #111;
    color: #fff;
  }

  .text-mark-row input {
    box-sizing: border-box;
    min-width: 0;
    width: 100%;
    height: 100%;
    padding: 0 6px;
    border: 0;
    border-right: 1px solid #d7d7d7;
    outline: 0;
    background: transparent;
    color: #111;
    font: inherit;
    font-size: 18px;
    text-align: center;
  }

  .text-mark-color {
    justify-self: center;
    width: 24px !important;
    height: 24px !important;
    padding: 0 !important;
    border-right: 0 !important;
    cursor: pointer;
    background: var(--property-color) !important;
    transform: translateY(7px);
  }

  .figma-color-picker.text-selection-color-picker { top: 88px; }

  .text-mark-thickness::-webkit-inner-spin-button,
  .text-mark-thickness::-webkit-outer-spin-button { margin: 0; appearance: none; }
  .text-mark-thickness { appearance: textfield; cursor: ew-resize; }

  .text-redaction-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
  }

  .text-redaction-grid button {
    height: 39px;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    font: inherit;
    font-size: 18px;
    cursor: pointer;
  }

  .text-redaction-grid button { background: #f3f3f3; color: #111; transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease; }

  .selection-properties-scroll {
    min-height: 0;
    max-height: calc(100vh - 132px);
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }

  .selection-property-section {
    padding: 16px 18px;
    border-bottom: 1px solid #d7d7d7;
  }

  .geometry-section,
  .appearance-section {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px 14px;
  }

  .appearance-section {
    grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
  }

  .inspector-field {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    box-sizing: border-box;
    min-width: 0;
    height: 39px;
    padding: 0 10px;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    color: #7a7a7a;
    font-size: 18px;
    transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
  }

  .inspector-field:focus-within {
    border-color: #1684f8;
    background: #fff;
    box-shadow: 0 0 0 1px rgba(22, 132, 248, 0.13);
  }

  .inspector-field-wide {
    grid-column: 1 / -1;
  }

  .inspector-field input {
    min-width: 0;
    width: 100%;
    padding: 0 0 0 7px;
    border: 0;
    outline: 0;
    background: transparent;
    color: #111;
    font: inherit;
    appearance: textfield;
    -moz-appearance: textfield;
  }

  .scrubbable-number,
  .scrub-label {
    cursor: ew-resize;
  }

  .inspector-field input::-webkit-inner-spin-button,
  .inspector-field input::-webkit-outer-spin-button,
  .object-property-row input[type='number']::-webkit-inner-spin-button,
  .object-property-row input[type='number']::-webkit-outer-spin-button {
    margin: 0;
    -webkit-appearance: none;
  }

  .inspector-field em {
    color: #7a7a7a;
    font-style: normal;
  }

  .object-properties {
    display: grid;
    gap: 9px;
  }

  .typography-section {
    display: grid;
    gap: 9px;
  }

  .typography-color-row,
  .typography-select-row {
    display: grid;
    grid-template-columns: 74px minmax(0, 1fr) 38px;
    align-items: center;
    box-sizing: border-box;
    min-width: 0;
    height: 39px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    font-size: 18px;
  }

  .typography-color-row > span,
  .typography-select-row > span {
    padding-left: 10px;
    color: #7a7a7a;
  }

  .typography-color-row input,
  .typography-select-row select {
    box-sizing: border-box;
    min-width: 0;
    width: 100%;
    height: 100%;
    padding: 0 8px;
    border: 0;
    outline: 0;
    background: transparent;
    color: #111;
    font: inherit;
    text-align: right;
  }

  .typography-select-row {
    grid-template-columns: 74px minmax(0, 1fr);
  }

  .typography-select-row select {
    cursor: pointer;
    text-align-last: right;
    appearance: none;
    -webkit-appearance: none;
  }

  .typography-weight-size-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(0, 0.9fr);
    gap: 9px;
  }

  .compact-weight-row {
    grid-template-columns: 67px minmax(0, 1fr);
  }

  .typography-size-field {
    padding-inline: 9px;
  }

  .typography-size-field input {
    padding-left: 5px;
    text-align: right;
  }

  .typography-spacing-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
  }

  .typography-alignment-row {
    display: grid;
    grid-template-columns: 82px minmax(0, 1fr);
    align-items: center;
    min-width: 0;
    color: #7a7a7a;
    font-size: 16px;
  }

  .typography-segments,
  .typography-style-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    height: 39px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
  }

  .typography-segments button,
  .typography-style-row button {
    position: relative;
    display: grid;
    place-items: center;
    min-width: 0;
    padding: 0;
    border: 0;
    border-left: 1px solid #d7d7d7;
    background: transparent;
    color: #656565;
    font: inherit;
    font-size: 17px;
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .typography-segments button:first-child,
  .typography-style-row button:first-child {
    border-left: 0;
  }

  .typography-segments button:hover,
  .typography-style-row button:hover {
    color: #111;
    background: #ededed;
  }

  .typography-segments button.active,
  .typography-style-row button.active {
    z-index: 1;
    color: #fff;
    background: #111;
  }

  .typography-segments img {
    display: block;
    width: 21px;
    height: 21px;
    object-fit: contain;
    pointer-events: none;
    transition: filter 150ms ease;
  }

  .typography-segments button.active img {
    filter: brightness(0) invert(1);
  }

  .typography-style-row {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-top: 2px;
  }

  .object-property-row {
    display: grid;
    grid-template-columns: 37px auto minmax(0, 1fr) 38px;
    align-items: center;
    box-sizing: border-box;
    min-height: 39px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    color: #111;
    font-size: 18px;
    transition: opacity 160ms ease, border-color 160ms ease, background-color 160ms ease;
  }

  .object-property-row:focus-within {
    border-color: #bfc8d2;
    background: #f7f7f7;
  }

  .object-property-row.property-disabled > :not(.property-visibility):not(.property-remove) {
    opacity: 0.42;
  }

  .property-visibility,
  .property-remove {
    display: grid;
    place-items: center;
    align-self: stretch;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .property-visibility {
    position: relative;
    border-right: 1px solid #d7d7d7;
    opacity: 0.82;
    transition: opacity 170ms ease, transform 190ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .property-visibility img {
    width: 24px;
    height: 24px;
    transition: transform 190ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .property-visibility:active {
    transform: scale(0.91);
  }

  .property-remove {
    color: #7a7a7a;
    font-size: 23px;
    line-height: 1;
    transition: color 150ms ease;
  }

  .property-remove:hover {
    color: #111;
  }

  .property-name {
    padding-left: 10px;
    color: #7a7a7a;
    white-space: nowrap;
  }

  .property-hex,
  .property-number {
    box-sizing: border-box;
    min-width: 0;
    width: 100%;
    padding: 0 5px 0 8px;
    border: 0;
    outline: 0;
    background: transparent;
    color: #111;
    font: inherit;
    text-align: right;
  }

  .property-color {
    display: block;
    box-sizing: border-box;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid rgba(0, 0, 0, 0.16);
    border-radius: 8px;
    background: var(--property-color);
    cursor: pointer;
    transition: box-shadow 150ms ease, transform 150ms ease;
  }

  .property-color:hover,
  .property-color.active {
    box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px #1684f8;
  }

  .stroke-property-row {
    grid-template-columns: 37px 79px 48px minmax(0, 1fr) 38px;
  }

  .stroke-property-row .property-number {
    align-self: stretch;
    padding: 0 4px;
    border-left: 1px solid #d7d7d7;
    border-right: 1px solid #d7d7d7;
    text-align: center;
  }

  .figma-color-picker {
    position: absolute;
    z-index: 41;
    top: 250px;
    right: 348px;
    display: grid;
    gap: 11px;
    box-sizing: border-box;
    width: 260px;
    padding: 13px;
    border: 1.5px solid #c5c5c5;
    border-radius: 13px;
    background: #fafafa;
    box-shadow: 0 9px 24px rgba(0, 0, 0, 0.07);
  }

  .color-saturation {
    position: relative;
    height: 172px;
    overflow: hidden;
    border: 1px solid #cacaca;
    border-radius: 8px;
    background:
      linear-gradient(to top, #000, transparent),
      linear-gradient(to right, #fff, var(--picker-hue));
    cursor: crosshair;
    touch-action: none;
  }

  .color-saturation > span,
  .picker-slider > span {
    position: absolute;
    z-index: 2;
    display: block;
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    border: 3px solid #fff;
    border-radius: 50%;
    background: var(--thumb-color, transparent);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .color-saturation > span {
    top: 0;
    left: 0;
  }

  .picker-slider {
    position: relative;
    height: 18px;
    border-radius: 999px;
    cursor: ew-resize;
    touch-action: none;
  }

  .picker-slider > span {
    top: 50%;
  }

  .hue-slider {
    background: linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  }

  .alpha-slider {
    background:
      linear-gradient(90deg, transparent, var(--picker-color)),
      conic-gradient(#fff 25%, #cfcfcf 0 50%, #fff 0 75%, #cfcfcf 0) 0 0 / 12px 12px;
  }

  .search-panel-content {
    display: grid;
    align-content: center;
    min-height: 0;
    padding: 17px 18px 18px;
    background: #fafafa;
  }

  .watermark-panel-content {
    display: grid;
    grid-template-rows: 40px 44px;
    align-content: center;
    gap: 10px;
    min-height: 0;
    padding: 17px 18px 18px;
    background: #fafafa;
  }

  .watermark-panel-content .protect-submit:disabled {
    cursor: default;
    opacity: 0.42;
  }

  .search-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 36px 36px;
    align-items: center;
    gap: 6px;
  }

  .search-field {
    grid-template-columns: minmax(0, 1fr);
  }

  .search-field input::-webkit-search-cancel-button {
    display: none;
  }

  .search-direction {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 36px;
    height: 40px;
    padding: 0;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    cursor: pointer;
    transition: border-color 160ms ease, background-color 160ms ease, opacity 160ms ease;
  }

  .search-direction:not(:disabled):hover {
    border-color: #bdbdbd;
    background: #ececec;
  }

  .search-direction:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .search-direction img {
    width: 17px;
    height: 18px;
    pointer-events: none;
  }

  .search-previous img {
    transform: rotate(-90deg);
  }

  .search-next img {
    transform: rotate(90deg);
  }

  .protect-panel.has-error {
    height: 428px;
  }

  .protect-panel.encrypted.has-error {
    height: 378px;
  }

  .protect-panel-header {
    display: grid;
    grid-template-columns: 26px 1fr 28px;
    align-items: center;
    box-sizing: border-box;
    min-width: 0;
    padding: 0 12px 0 12px;
    border-bottom: 1px solid #cacaca;
    background: #eeeeee;
    height: 50px;
  }

  .protect-panel-header > img {
    width: 24px;
    height: 24px;
  }

  .selection-properties-panel .protect-panel-header > img {
    width: 21px;
    height: 21px;
  }

  .protect-panel-header h2 {
    margin: 0 0 0 7px;
    overflow: hidden;
    color: #000;
    font-size: 18px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.25px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .protect-panel-close {
    position: relative;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: transparent;
    cursor: pointer;
    transition: transform 160ms ease;
  }

  .protect-panel-close:active {
    transform: scale(0.94);
  }

  .protect-panel-close span {
    position: absolute;
    top: 13px;
    left: 6px;
    width: 16px;
    height: 1.5px;
    border-radius: 999px;
    background: #929292;
    transform: rotate(45deg);
    transition: background-color 160ms ease;
  }

  .protect-panel-close span + span {
    transform: rotate(-45deg);
  }

  .protect-panel-close:hover span {
    background: #000;
  }

  .protect-panel-form {
    display: grid;
    grid-template-rows: 124px 140px 78px;
    min-height: 0;
    transition: grid-template-rows 300ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .protect-panel.encrypted .protect-panel-form {
    grid-template-rows: 74px 140px 78px;
  }

  .protect-panel.has-error .protect-panel-form {
    grid-template-rows: 160px 140px 78px;
  }

  .protect-panel.encrypted.has-error .protect-panel-form {
    grid-template-rows: 110px 140px 78px;
  }

  .protect-fields {
    position: relative;
    display: grid;
    align-content: center;
    box-sizing: border-box;
    min-height: 0;
    padding: 10px 18px 14px;
    overflow: hidden;
    border-bottom: 1px solid #cacaca;
    background: #fafafa;
  }

  .password-fields-enter {
    display: grid;
    gap: 10px;
  }

  .password-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    box-sizing: border-box;
    width: 100%;
    height: 40px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    transition: border-color 170ms ease, box-shadow 170ms ease, background-color 170ms ease;
  }

  .password-field:focus-within {
    border-color: #a9a9a9;
    background: #f3f3f3;
    box-shadow: 0 0 0 3px rgba(0, 117, 255, 0.09);
  }

  .password-field.error {
    border-color: #e15757;
    box-shadow: 0 0 0 3px rgba(225, 87, 87, 0.09);
  }

  .password-field input {
    box-sizing: border-box;
    min-width: 0;
    height: 100%;
    padding: 0 11px;
    border: 0;
    outline: 0;
    background: transparent;
    color: #343434;
    font: inherit;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.25px;
  }

  .password-field input::placeholder {
    color: #7a7a7a;
    opacity: 1;
  }

  .password-visibility {
    position: relative;
    display: grid;
    place-items: center;
    width: 44px;
    height: 100%;
    padding: 0;
    border: 0;
    border-left: 1px solid #d7d7d7;
    background: transparent;
    cursor: pointer;
    transition: background-color 160ms ease;
  }

  .password-visibility:hover {
    background: rgba(0, 0, 0, 0.035);
  }

  .password-visibility:active img {
    transform: translate(-50%, -50%) scale(0.91);
  }

  .password-visibility img {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 24px;
    height: 24px;
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.9);
    transition: opacity 170ms ease, transform 190ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .password-visibility img.visible {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }

  .password-visibility:active img.visible {
    transform: translate(-50%, -50%) scale(0.91);
  }

  .protection-error {
    box-sizing: border-box;
    width: 100%;
    max-height: 0;
    margin: 0;
    overflow: hidden;
    color: #c83e3e;
    font-size: 18px;
    line-height: 1;
    opacity: 0;
    transform: translateY(3px);
    transition: max-height 240ms cubic-bezier(0.22, 1, 0.36, 1), margin-top 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 170ms ease, transform 210ms ease;
  }

  .protection-error.visible {
    max-height: 22px;
    margin-top: 6px;
    opacity: 1;
    transform: translateY(4px);
  }

  .protect-warning {
    box-sizing: border-box;
    min-height: 0;
    padding: 18px 19px 10px;
    overflow: hidden;
    border-bottom: 1px solid #cacaca;
    background: #fafafa;
  }

  .protect-warning h3 {
    margin: 0 0 7px;
    color: #000;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.25px;
  }

  .protect-warning p {
    margin: 0;
    color: #7a7a7a;
    font-size: 18px;
    font-weight: 400;
    line-height: 1.42;
    letter-spacing: -0.25px;
  }

  .protect-warning p span {
    color: #0878f9;
  }

  .protect-actions {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    min-height: 0;
    padding: 17px 18px;
    background: #fafafa;
  }

  .protect-submit {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    box-sizing: border-box;
    width: 100%;
    height: 44px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: #000;
    color: #fff;
    font: inherit;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.3px;
    cursor: pointer;
    transition: background-color 260ms ease, transform 160ms ease, box-shadow 220ms ease;
  }

  .protect-submit:hover {
    box-shadow: 0 5px 16px rgba(0, 0, 0, 0.16);
  }

  .protect-submit:active {
    transform: scale(0.985);
  }

  .protect-submit.encrypted {
    background: #0878f9;
    box-shadow: 0 5px 16px rgba(8, 120, 249, 0.22);
  }

  .protect-submit:disabled {
    cursor: wait;
    opacity: 0.82;
  }

  .protect-submit img {
    width: 24px;
    height: 24px;
    filter: brightness(0) invert(1);
  }

  .protect-panel.sign-panel {
    height: 132px;
    transition: height 300ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms ease;
  }

  .protect-panel.sign-panel.has-signatures {
    height: min(calc(132px + var(--signature-count) * 112px), 300px, calc(100% - 40px));
  }

  .protect-panel.add-signature-panel {
    top: 164px;
    height: 360px;
    transition: top 300ms cubic-bezier(0.22, 1, 0.36, 1), height 260ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms ease;
  }

  .protect-panel.add-signature-panel.draw-mode {
    height: 260px;
  }

  .protect-panel.add-signature-panel.below-signatures {
    top: 332px;
  }

  .sign-panel-header > img {
    width: 24px;
    height: 24px;
  }

  .sign-panel-header h2 {
    margin-bottom: 0;
    padding-bottom: 2px;
    line-height: 1.2;
  }

  .saved-signature-content,
  .add-signature-content {
    display: grid;
    min-height: 0;
    overflow: hidden;
    background: #fafafa;
  }

  .saved-signature-content {
    grid-template-rows: minmax(0, 1fr) 81px;
  }

  .sign-panel:not(.has-signatures) .saved-signature-content {
    grid-template-rows: 81px;
  }

  .saved-signature-list {
    min-height: 0;
    overflow-y: auto;
    border-bottom: 1px solid #cacaca;
    scrollbar-width: none;
  }

  .saved-signature-list::-webkit-scrollbar {
    display: none;
  }

  .saved-signature-row {
    position: relative;
    border-bottom: 1px solid #dedede;
  }

  .saved-signature {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 100%;
    min-height: 112px;
    padding: 18px 30px;
    border: 0;
    background: #fafafa;
    cursor: pointer;
    transition: background-color 180ms ease;
  }

  .saved-signature:hover {
    background: #f5f5f5;
  }

  .saved-signature img {
    display: block;
    max-width: 100%;
    max-height: 76px;
    object-fit: contain;
  }

  .saved-signature-remove {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
  }

  .saved-signature-remove span {
    position: absolute;
    top: 13px;
    left: 6px;
    width: 16px;
    height: 1.5px;
    border-radius: 99px;
    background: #929292;
    transform: rotate(45deg);
    transition: background-color 160ms ease;
  }

  .saved-signature-remove span + span {
    transform: rotate(-45deg);
  }

  .saved-signature-remove:hover span {
    background: #000;
  }

  .saved-signature-actions,
  .signature-actions {
    display: grid;
    align-content: center;
    box-sizing: border-box;
    min-height: 0;
    padding: 17px 18px;
    background: #fafafa;
  }

  .add-signature-content {
    grid-template-rows: 64px 1fr 132px;
  }

  .add-signature-panel.draw-mode .add-signature-content {
    grid-template-rows: 64px 66px 80px;
  }

  .signature-tabs {
    position: relative;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    align-self: center;
    box-sizing: border-box;
    height: 42px;
    margin: 12px 18px 10px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background:
      linear-gradient(#d7d7d7, #d7d7d7) 50% 0 / 1px 100% no-repeat,
      #f3f3f3;
  }

  .signature-tab-indicator {
    position: absolute;
    z-index: 1;
    inset: 0 auto 0 0;
    width: 50%;
    border-radius: 7px;
    background: #000;
    box-shadow: 0 3px 9px rgba(0, 0, 0, 0.12);
    transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .signature-tabs button {
    position: relative;
    z-index: 2;
    min-width: 0;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: #7a7a7a;
    font: inherit;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.25px;
    cursor: pointer;
    transition: color 190ms ease;
  }

  .signature-tabs button.active {
    color: #fff;
  }

  .signature-tab-content {
    box-sizing: border-box;
    min-height: 0;
    padding: 8px 18px 12px;
    overflow: hidden;
    border-bottom: 1px solid #cacaca;
  }

  .signature-tab-copy p {
    margin: 0;
    color: #7a7a7a;
    font-size: 18px;
    font-weight: 400;
    line-height: 1.42;
    letter-spacing: -0.25px;
  }

  .signature-tab-copy .signature-processing-error {
    margin-top: 8px;
    color: #c83e3e;
    font-size: 14px;
    line-height: 1.3;
  }

  .signature-actions {
    grid-template-rows: repeat(2, 44px);
    gap: 10px;
    padding-block: 17px;
  }

  .add-signature-panel.draw-mode .signature-actions {
    grid-template-rows: 44px;
  }

  .signature-action {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    box-sizing: border-box;
    width: 100%;
    height: 44px;
    padding: 0 12px;
    border-radius: 8px;
    font: inherit;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.3px;
    cursor: pointer;
    transition: background-color 220ms ease, border-color 180ms ease, box-shadow 220ms ease, transform 160ms ease;
  }

  .signature-action:active {
    transform: scale(0.985);
  }

  .signature-action.primary {
    border: 0;
    background: #0878f9;
    color: #fff;
    box-shadow: 0 5px 16px rgba(8, 120, 249, 0.18);
  }

  .signature-action.primary:hover {
    background: #006ff0;
    box-shadow: 0 6px 18px rgba(8, 120, 249, 0.27);
  }

  .signature-action.primary img {
    width: 24px;
    height: 24px;
    filter: brightness(0) invert(1);
  }

  .signature-action.secondary {
    border: 1px solid #d7d7d7;
    background: #f3f3f3;
    color: #7a7a7a;
  }

  .signature-action.secondary:hover {
    border-color: #c8c8c8;
    background: #eeeeee;
  }

  .signature-action:disabled {
    cursor: wait;
    opacity: 0.72;
  }

  .signature-plus {
    position: relative;
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
  }

  .signature-plus::before,
  .signature-plus::after {
    position: absolute;
    top: 9px;
    left: 2px;
    width: 16px;
    height: 1.5px;
    border-radius: 999px;
    background: currentColor;
    content: '';
  }

  .signature-plus::after {
    transform: rotate(90deg);
  }

  .signature-upload-input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
  }

  .signature-camera-overlay {
    position: absolute;
    z-index: 80;
    display: grid;
    place-items: start center;
    inset: 0;
    box-sizing: border-box;
    padding: 52px 28px 90px;
    overflow: auto;
    background: rgba(245, 245, 245, 0.78);
    backdrop-filter: blur(6px) saturate(0.9);
    -webkit-backdrop-filter: blur(6px) saturate(0.9);
  }

  .signature-camera-card {
    width: min(760px, 100%);
    overflow: hidden;
    border: 1.5px solid #cacaca;
    border-radius: 13px;
    background: #fafafa;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.1);
    color: #7a7a7a;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .signature-draw-card {
    width: min(720px, 100%);
  }

  .signature-draw-field {
    position: relative;
    aspect-ratio: 2.6 / 1;
    margin: 15px 15px 0;
    overflow: hidden;
    border: 1px solid #bcbcbc;
    border-radius: 8px;
    background: #fff;
  }

  .signature-draw-field canvas {
    position: absolute;
    z-index: 2;
    display: block;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: crosshair;
    touch-action: none;
  }

  .signature-draw-baseline {
    position: absolute;
    z-index: 1;
    right: 9%;
    bottom: 28%;
    left: 9%;
    height: 1px;
    background: #b8b8b8;
    pointer-events: none;
  }

  .signature-draw-controls {
    display: flex;
    gap: 10px;
  }

  .signature-draw-controls .signature-action.secondary {
    min-width: 88px;
  }

  .signature-draw-controls .signature-action.primary {
    min-width: 160px;
  }

  .signature-camera-preview {
    position: relative;
    aspect-ratio: 16 / 9;
    margin: 15px 15px 0;
    overflow: hidden;
    border: 1px solid #bcbcbc;
    border-radius: 8px;
    background: #222;
  }

  .signature-camera-preview video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .signature-camera-guide {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 58%;
    height: 48%;
    border: 1.5px solid rgba(255, 255, 255, 0.94);
    border-radius: 7px;
    box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.1);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .signature-camera-close {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.38);
    border-radius: 9px;
    background: rgba(0, 0, 0, 0.28);
    cursor: pointer;
    backdrop-filter: blur(6px);
  }

  .signature-camera-close span {
    position: absolute;
    top: 14px;
    left: 7px;
    width: 16px;
    height: 1.5px;
    border-radius: 99px;
    background: #fff;
    transform: rotate(45deg);
  }

  .signature-camera-close span + span {
    transform: rotate(-45deg);
  }

  .signature-camera-status {
    position: absolute;
    top: 50%;
    left: 50%;
    max-width: 72%;
    padding: 10px 14px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.58);
    color: #fff;
    font-size: 16px;
    line-height: 1.3;
    text-align: center;
    transform: translate(-50%, -50%);
    backdrop-filter: blur(8px);
  }

  .signature-camera-status.error {
    background: rgba(140, 23, 23, 0.76);
  }

  .signature-camera-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    box-sizing: border-box;
    min-height: 66px;
    padding: 10px 15px 13px;
  }

  .signature-camera-footer > span {
    overflow: hidden;
    font-size: 18px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .signature-camera-footer .signature-action {
    width: auto;
    min-width: 170px;
  }

  .pdf-signature,
  .pdf-imported-image {
    cursor: default;
    pointer-events: all;
  }

  @media (max-width: 760px) {
    .signature-camera-overlay {
      padding: 24px 14px 80px;
    }

    .signature-camera-preview {
      margin: 10px 10px 0;
    }

    .signature-camera-footer {
      align-items: stretch;
      flex-direction: column;
    }

    .signature-camera-footer .signature-action {
      width: 100%;
    }
  }

  .password-unlock-overlay {
    z-index: 1100;
  }

  .unlock-panel,
  .unlock-panel.encrypted {
    position: relative;
    top: auto;
    right: auto;
  }

  @media (max-width: 980px) {
    .protect-panel {
      width: min(330px, calc(100% - 28px));
      right: 14px;
      transform-origin: top right;
    }

    .protect-panel-header h2 {
      font-size: 18px;
    }

    .password-field input,
    .protect-warning p {
      font-size: 18px;
    }

    .protect-submit {
      font-size: 18px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .protect-panel,
    .protect-panel-form,
    .protect-panel-close,
    .password-field,
    .password-visibility,
    .password-visibility img,
    .protection-error,
    .protect-submit {
      transition: none;
    }
  }

  .pdf-viewer {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 36px 48px 80px;
    overflow: auto;
    scrollbar-width: none;
  }

  .pdf-viewer.editor-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  .html-editor-layer {
    position: absolute;
    z-index: 2;
    top: 0;
    left: 0;
    width: 117.6470588%;
    height: 117.6470588%;
    overflow: hidden;
    background: #f5f5f5;
    visibility: hidden;
    pointer-events: none;
  }

  .html-editor-layer.active {
    visibility: visible;
    pointer-events: auto;
  }

  .preparation-overlay {
    position: absolute;
    z-index: 1000;
    display: grid;
    place-items: center;
    inset: 0;
    background: rgba(245, 245, 245, 0.48);
    backdrop-filter: blur(7px) saturate(0.88);
    -webkit-backdrop-filter: blur(7px) saturate(0.88);
    animation: preparation-overlay-in 150ms ease-out both;
  }

  .preparation-dialog {
    position: relative;
    width: 430px;
    height: 68px;
    overflow: hidden;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 13px;
    background: #fff;
    box-shadow: 0 10px 35px rgba(0, 0, 0, 0.08);
    animation: preparation-dialog-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  .preparation-spinner {
    position: absolute;
    top: 22px;
    left: 19px;
    width: 24px;
    height: 24px;
    transform-origin: center;
    animation: spinner-squish 760ms linear infinite;
  }

  .preparation-text {
    position: absolute;
    top: 21px;
    left: 60px;
    width: 350px;
    height: 25px;
    padding-left: 2px;
    background: linear-gradient(90deg, #474747 0%, #9e9e9e 31.877%, #474747 72.516%);
    background-position: 140% 50%;
    background-size: 230% 100%;
    color: transparent;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 20px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.2px;
    white-space: nowrap;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-font-smoothing: antialiased;
    animation: preparation-shimmer 720ms linear infinite;
  }

  @keyframes spinner-squish {
    0% { transform: rotate(0deg) scale(1, 0.82); }
    25% { transform: rotate(90deg) scale(0.82, 1.08); }
    50% { transform: rotate(180deg) scale(1.08, 0.84); }
    75% { transform: rotate(270deg) scale(0.84, 1.06); }
    100% { transform: rotate(360deg) scale(1, 0.82); }
  }

  @keyframes preparation-shimmer {
    from { background-position: 140% 50%; }
    to { background-position: -120% 50%; }
  }

  @keyframes preparation-overlay-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes preparation-dialog-in {
    from { opacity: 0; transform: scale(0.96) translateY(5px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
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

  .pdf-viewer.highlight-mode {
    cursor: text;
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
    transform: translateX(-80px);
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

  .search-highlight-layer {
    z-index: 1;
    mix-blend-mode: multiply;
  }

  .search-highlight-layer rect {
    fill: #ffe43b;
    opacity: 0.72;
  }

  .watermark-layer {
    z-index: 2;
    overflow: hidden;
    mix-blend-mode: multiply;
  }

  .watermark-layer text {
    fill: #505761;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-anchor: middle;
    dominant-baseline: central;
    opacity: 0.17;
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

  .text-highlight-layer {
    z-index: 1;
    mix-blend-mode: multiply;
  }

  .text-highlight-layer .text-highlight {
    fill: #ffe43b;
    opacity: 1;
  }

  .text-highlight-layer .text-decoration {
    fill: none;
    stroke-width: var(--decoration-width, 1.5px);
    stroke-linecap: round;
    opacity: 0.96;
  }

  .pen-layer {
    z-index: 4;
  }

  .redaction-layer {
    z-index: 5;
  }

  .redaction-layer rect.blackout {
    fill: #000;
  }

  .redaction-layer rect.whiteout {
    fill: #fff;
  }

  .native-selection-layer {
    z-index: 10;
    overflow: visible;
  }

  .native-selection-layer rect {
    fill: #1684f8;
    fill-opacity: 0.42;
    stroke: rgba(255, 255, 255, 0.92);
    stroke-width: 0.65px;
    paint-order: stroke fill;
    vector-effect: non-scaling-stroke;
  }

  .shape-layer {
    z-index: 3;
  }

  .crop-overlay-layer {
    z-index: 8;
    overflow: hidden;
  }

  .crop-overlay-layer .crop-shade {
    fill: rgba(13, 18, 27, 0.72);
    stroke: none;
    pointer-events: none;
  }

  .crop-edge {
    fill: none;
    stroke: #0d99ff;
    stroke-width: calc(1.5px * var(--shape-ui-scale));
    stroke-dasharray: calc(3px * var(--shape-ui-scale)) calc(3px * var(--shape-ui-scale));
    pointer-events: none;
  }

  .crop-grid {
    stroke: rgba(255, 255, 255, 0.44);
    stroke-width: calc(0.8px * var(--shape-ui-scale));
    stroke-dasharray: calc(3px * var(--shape-ui-scale)) calc(4px * var(--shape-ui-scale));
    pointer-events: none;
  }

  .crop-hit {
    fill: transparent;
    stroke: none;
    pointer-events: all;
    cursor: move;
  }

  .crop-resize-edge {
    fill: none;
    stroke: transparent;
    pointer-events: stroke;
  }

  .crop-resize-edge[data-shape-handle='0,-1'],
  .crop-resize-edge[data-shape-handle='0,1'] {
    cursor: ns-resize;
  }

  .crop-resize-edge[data-shape-handle='-1,0'],
  .crop-resize-edge[data-shape-handle='1,0'] {
    cursor: ew-resize;
  }

  .crop-resize-handle {
    fill: #fff;
    stroke: #0d99ff;
    pointer-events: all;
  }

  .crop-resize-handle[data-shape-handle='-1,-1'],
  .crop-resize-handle[data-shape-handle='1,1'] {
    cursor: nwse-resize;
  }

  .crop-resize-handle[data-shape-handle='1,-1'],
  .crop-resize-handle[data-shape-handle='-1,1'] {
    cursor: nesw-resize;
  }

  .pdf-form-layer {
    position: absolute;
    z-index: 6;
    inset: 0;
    pointer-events: none;
  }

  .pdf-form-widget {
    position: absolute;
    box-sizing: border-box;
    pointer-events: auto;
  }

  .pdf-input-field,
  .pdf-checkbox-field {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    margin: 0;
    outline: 0;
    border: 1px solid rgba(45, 139, 205, 0.72);
    border-radius: 2px;
    background: rgba(177, 220, 250, 0.48);
    color: #171717;
    transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }

  .pdf-input-field {
    min-width: 0;
    padding: 1px 5px;
    font-family: Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1;
  }

  .pdf-input-field:focus,
  .pdf-checkbox-field:focus {
    border-color: #0878f9;
    background: rgba(185, 226, 255, 0.62);
    box-shadow: 0 0 0 2px rgba(8, 120, 249, 0.18);
  }

  .pdf-checkbox-field {
    position: relative;
    appearance: none;
    -webkit-appearance: none;
    cursor: grab;
  }

  .pdf-checkbox-field:active {
    cursor: grabbing;
  }

  .pdf-checkbox-field:checked {
    border-color: #0878f9;
    background: #0878f9;
  }

  .pdf-checkbox-field:checked::after {
    position: absolute;
    top: 16%;
    left: 31%;
    width: 28%;
    height: 52%;
    border: solid #fff;
    border-width: 0 2px 2px 0;
    content: '';
    transform: rotate(45deg);
  }

  .pdf-form-widget.readonly {
    opacity: 0.78;
  }

  .pdf-text-editor-overlay {
    position: absolute;
    z-index: 6;
    box-sizing: border-box;
    padding: 0 6px;
    overflow: visible;
    color: #171717;
    font-family: Helvetica, Arial, sans-serif;
    font-size: 16px;
    font-weight: 400;
    line-height: 1.2;
    white-space: normal;
  }

  .pdf-text-editor-overlay [data-text-editor] {
    box-sizing: border-box;
    width: 100%;
    min-height: 100%;
    padding: 0;
    border: 0;
    outline: 0;
    overflow: hidden;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: inherit;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .pdf-text-field-display text {
    fill: #171717;
    font-family: Helvetica, Arial, sans-serif;
    font-size: 16px;
    font-weight: 400;
    pointer-events: none;
  }

  .pdf-text-field-display.placeholder text {
    fill: #898989;
  }

  .pdf-text-field-hit {
    fill: transparent;
    pointer-events: all;
    cursor: move;
  }

  .pdf-shape {
    fill: var(--shape-fill, #ff4d55);
    stroke: var(--shape-stroke, #de3542);
    stroke-width: var(--shape-stroke-width, 1.35px);
    stroke-linejoin: round;
    pointer-events: visiblePainted;
  }

  .shape-symbol {
    fill: none;
    stroke: var(--shape-stroke, #ff4d55);
    stroke-width: var(--shape-stroke-width, 1.7px);
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: visibleStroke;
  }

  .shape-linear {
    fill: none;
    stroke: var(--shape-stroke, #ff4d55);
    stroke-width: var(--shape-stroke-width, 1.4px);
    stroke-linecap: round;
    pointer-events: none;
  }

  .shape-arrowhead {
    fill: none;
    stroke: var(--shape-stroke, #ff4d55);
    stroke-width: var(--shape-stroke-width, 1.4px);
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

  .pdf-imported-image-stroke {
    fill: none;
    stroke: var(--shape-stroke, #de3542);
    stroke-width: var(--shape-stroke-width, 1.35px);
    pointer-events: none;
  }

  .shape-background-blur,
  .shape-background-blur > div {
    pointer-events: none;
  }

  .measure-halo,
  .measure-rule,
  .measure-tick {
    fill: none;
    pointer-events: none;
    vector-effect: non-scaling-stroke;
  }

  .measure-halo {
    stroke: rgba(255, 255, 255, 0.92);
    stroke-width: calc(5px * var(--shape-ui-scale));
    stroke-linecap: round;
  }

  .measure-rule,
  .measure-tick {
    stroke: #1769e8;
    stroke-linecap: round;
  }

  .measure-rule {
    stroke-width: calc(2.25px * var(--shape-ui-scale));
  }

  .measure-tick {
    stroke-width: calc(1.35px * var(--shape-ui-scale));
    opacity: 0.9;
  }

  .measure-tick.major {
    stroke-width: calc(2px * var(--shape-ui-scale));
    opacity: 1;
  }

  .measure-endpoint {
    fill: #fff;
    stroke: #1769e8;
    stroke-width: calc(2px * var(--shape-ui-scale));
    pointer-events: none;
  }

  .measure-badge {
    pointer-events: none;
    filter: drop-shadow(0 3px 7px rgba(15, 37, 70, 0.25));
  }

  .measure-badge rect,
  .measure-badge-pointer {
    fill: #102a4c;
    stroke: rgba(255, 255, 255, 0.22);
    stroke-width: calc(1px * var(--shape-ui-scale));
  }

  .measure-badge text {
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-weight: 500;
    text-anchor: middle;
    dominant-baseline: central;
  }

  .measure-primary {
    fill: #fff;
    letter-spacing: -0.01em;
  }

  .measure-secondary {
    fill: #b9c9dc;
    letter-spacing: 0.015em;
  }

  .measure-hit {
    stroke-width: calc(22px * var(--shape-ui-scale));
  }

  .pdf-viewer:not(.shape-mode):not(.drawing-mode):not(.eraser-mode) .pdf-shape {
    cursor: move;
  }

  .shape-selection-layer {
    z-index: 9;
    overflow: visible;
  }

  .shape-hover-layer {
    z-index: 8;
    overflow: visible;
    pointer-events: none;
  }

  .shape-hover-box,
  .shape-hover-line {
    fill: none;
    stroke: #0d99ff;
    stroke-width: calc(1px * var(--shape-ui-scale));
    opacity: 0.95;
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
