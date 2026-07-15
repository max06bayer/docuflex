<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, fly } from 'svelte/transition';
  import EditorToolbar from '$lib/EditorToolbar.svelte';
  import HtmlPdfEditor from '$lib/HtmlPdfEditor.svelte';

  /** @typedef {{ x: number; y: number; pressure: number }} StrokePoint */
  /** @typedef {{ id: number; type: 'marker' | 'pen'; points: StrokePoint[] }} AnnotationStroke */
  /** @typedef {{ id: number; type: 'triangle' | 'rectangle' | 'circle' | 'check' | 'cross' | 'arrow' | 'line' | 'textfield' | 'signature'; x: number; y: number; width: number; height: number; rotation: number; text?: string; imageData?: string }} AnnotationShape */
  /** @typedef {{ id: number; type: 'highlight' | 'underline' | 'crossout' | 'blackout' | 'whiteout'; rects: { x: number; y: number; width: number; height: number; color?: [number, number, number] }[] }} TextHighlight */

  /** @type {File} */
  export let file;
  /** @type {{ enabled: boolean; password: string }} */
  export let protection = { enabled: false, password: '' };
  /** @type {(protection: { enabled: boolean; password: string }) => void} */
  export let onProtectionChange = () => {};
  /** @type {() => void} */
  export let onRequestClose = () => {};
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
  let status = 'Rendering PDF…';
  let loadGeneration = 0;
  /** @type {import('pdfjs-dist/web/pdf_viewer.mjs').TextLayerBuilder[]} */
  let textLayerBuilders = [];
  /** @type {AbortController | null} */
  let textLayerAbortController = null;
  let activeTool = 'select';
  /** @type {any} */
  let htmlEditor;
  let htmlEditorStarted = false;
  let htmlEditorReady = false;
  let htmlViewportMode = false;
  let htmlViewportVisible = false;
  let observedTool = 'select';
  let editorTransition = '';
  let editorTransitionGeneration = 0;
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
  /** @type {'draw' | 'write' | 'image'} */
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

  const BASE_PAGE_SCALE = 1.35;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const CLICK_ZOOM_FACTOR = 1.25;
  const MAX_CANVAS_PIXELS = 24_000_000;
  const ERASER_RADIUS = 17;
  const SHAPE_TOOLS = new Set(['triangle', 'rectangle', 'circle', 'check', 'cross', 'arrow', 'line', 'textfield']);
  const LINE_SHAPE_TOOLS = new Set(['arrow', 'line']);
  const HTML_VIEW_TOOLS = new Set(['edit', 'pan', 'zoom']);
  const TEXT_MARK_TOOLS = new Set(['highlight', 'underline', 'crossout', 'blackout', 'whiteout']);
  const MIN_SHAPE_SIZE = 8;

  $: if (activeTool !== 'eraser') eraserCursorVisible = false;
  $: if (activeTool !== observedTool) {
    const previousTool = observedTool;
    observedTool = activeTool;
    void handleToolTransition(previousTool, activeTool);
  }
  $: htmlViewportVisible = htmlEditorStarted && htmlEditorReady && htmlViewportMode && HTML_VIEW_TOOLS.has(activeTool);
  $: {
    annotations;
    shapes;
    textHighlights;
    pageSizes;
    htmlVisualAnnotations = exportableAnnotations();
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
    if (nextTool === 'protect') protectPanelOpen = true;
    else if (previousTool === 'protect') protectPanelOpen = false;
    if (nextTool === 'sign') {
      signPanelOpen = true;
      addSignaturePanelOpen = false;
    } else if (previousTool === 'sign') {
      signPanelOpen = false;
      addSignaturePanelOpen = false;
    }
    if (nextTool === 'edit') {
      if (htmlEditorStarted && htmlEditorReady) {
        htmlViewportMode = true;
        return;
      }
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
      const sourceBytes = await workingFile.arrayBuffer();
      const hasTextEdits = htmlEditor?.hasPendingTextEdits
        ? await htmlEditor.hasPendingTextEdits()
        : true;
      const editedBytes = htmlEditor?.applyTextEdits
        ? await htmlEditor.applyTextEdits(sourceBytes)
        : sourceBytes;
      if (generation !== editorTransitionGeneration) return;
      workingFile = new File([editedBytes], workingFile.name, {
        type: 'application/pdf',
        lastModified: Date.now()
      });
      htmlViewportMode = false;
      await loadPdf(false);
      if (hasTextEdits && htmlEditor?.commitAppliedTextEdits) {
        await htmlEditor.commitAppliedTextEdits(editedBytes);
      }
    } catch (error) {
      console.error(error);
      status = error instanceof Error ? error.message : 'Could not apply the edited PDF text.';
      htmlViewportMode = false;
      htmlEditorStarted = false;
      htmlEditorReady = false;
    } finally {
      if (generation === editorTransitionGeneration) editorTransition = '';
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
    if (activeTool === 'sign') activeTool = 'select';
  }

  function openAddSignaturePanel() {
    signatureTab = 'image';
    cameraError = '';
    addSignaturePanelOpen = true;
  }

  function closeAddSignaturePanel() {
    addSignaturePanelOpen = false;
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

    /** @param {MouseEvent} event */
    function beginProductionCharacterDrag(event) {
      if (!import.meta.env.PROD || !isTextSelectionTool() || event.button !== 0 || event.detail !== 1) return;
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
      if (!import.meta.env.PROD || !isTextSelectionTool() || event.button !== 0) return;
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

    /** @param {PointerEvent} event */
    function commitTextFieldOnOutsidePointer(event) {
      if (!editingTextShape) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-text-editor]')) return;
      commitActiveTextField();
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
    document.addEventListener('mouseup', commitTextHighlight);
    document.addEventListener('dragstart', suppressProductionBlankDrag);
    document.addEventListener('click', clearPageSelection);
    document.addEventListener('pointerdown', commitTextFieldOnOutsidePointer, true);
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
      document.removeEventListener('mouseup', commitTextHighlight);
      document.removeEventListener('dragstart', suppressProductionBlankDrag);
      document.removeEventListener('click', clearPageSelection);
      document.removeEventListener('pointerdown', commitTextFieldOnOutsidePointer, true);
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
            ...(['underline', 'crossout'].includes(markType) ? { color: selectedTextColor(rect, shell) } : {})
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

  /** @param {number} id @param {boolean} [selectAll] */
  function focusTextEditor(id, selectAll = false) {
    const editor = viewer?.querySelector(`textarea[data-text-editor="${id}"]`);
    if (!(editor instanceof HTMLTextAreaElement)) return;
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(Number(editor.dataset.minHeight) || 0, editor.scrollHeight)}px`;
    editor.focus();
    if (selectAll) editor.select();
    else editor.setSelectionRange(editor.value.length, editor.value.length);
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
    if (!(input instanceof HTMLTextAreaElement)) return;
    input.style.height = 'auto';
    input.style.height = `${Math.max(Number(input.dataset.minHeight) || 0, input.scrollHeight)}px`;
  }

  function commitActiveTextField() {
    if (!editingTextShape) return;
    const { pageIndex, id } = editingTextShape;
    const input = viewer?.querySelector(`textarea[data-text-editor="${id}"]`);
    const shape = findShape(pageIndex, id);
    if (shape && input instanceof HTMLTextAreaElement) replaceShape(pageIndex, { ...shape, text: input.value });
    editingTextShape = null;
  }

  /** @param {FocusEvent} event @param {number} id */
  function retainTextEditorFocus(event, id) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLTextAreaElement)) return;
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

  /** @param {number} pageIndex @param {number[]} ids */
  function setShapeSelection(pageIndex, ids) {
    selectedShapeIds = new Set(ids);
    selectedShape = ids.length ? { pageIndex, id: ids[ids.length - 1] } : null;
    const bounds = selectionBounds(selectedShapesOnPage(pageIndex));
    multiSelectionFrame = ids.length > 1 && bounds ? { pageIndex, ...bounds } : null;
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
    next.x = clamp(next.x, 0, Math.max(0, pageSize.width - next.width));
    next.y = clamp(next.y, 0, Math.max(0, pageSize.height - next.height));
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
    const deltaX = clamp(direction.x * amount, -bounds.x, pageSize.width - bounds.x - bounds.width);
    const deltaY = clamp(direction.y * amount, -bounds.y, pageSize.height - bounds.y - bounds.height);
    replaceShapes(pageIndex, selected.map((shape) => ({ ...shape, x: shape.x + deltaX, y: shape.y + deltaY })));
    if (multiSelectionFrame) {
      multiSelectionFrame = { ...multiSelectionFrame, x: multiSelectionFrame.x + deltaX, y: multiSelectionFrame.y + deltaY };
    }
  }

  /** @param {PointerEvent} event @param {HTMLElement} shell @param {number} pageIndex */
  function beginShapeCreation(event, shell, pageIndex) {
    const start = pointOnPage(event, shell);
    const shape = {
      id: nextAnnotationId++,
      type: /** @type {'triangle' | 'rectangle' | 'circle' | 'check' | 'cross' | 'arrow' | 'line' | 'textfield'} */ (activeTool),
      x: start.x,
      y: start.y,
      width: 0.01,
      height: 0.01,
      rotation: 0,
      text: activeTool === 'textfield' ? '' : undefined
    };
    shapes = { ...shapes, [pageIndex]: [...(shapes[pageIndex] ?? []), shape] };
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
      const deltaX = clamp(point.x - interaction.start.x, -frame.x, pageSize.width - frame.x - frame.width);
      const deltaY = clamp(point.y - interaction.start.y, -frame.y, pageSize.height - frame.y - frame.height);
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
    if (event.button === 0 && shapeHit && activeTool === 'select') {
      const shape = findShape(shapeHit.pageIndex, shapeHit.id);
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
      if (event.shiftKey) {
        const ids = selectedShape?.pageIndex === shapeHit.pageIndex ? new Set(selectedShapeIds) : new Set();
        if (ids.has(shapeHit.id)) ids.delete(shapeHit.id);
        else ids.add(shapeHit.id);
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
    if (event.button === 0 && pageHit && SHAPE_TOOLS.has(activeTool)) {
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
        const preferredWidth = shape.type === 'textfield' ? 180 : shape.type === 'check' || shape.type === 'cross' ? 48 : 120;
        const preferredHeight = shape.type === 'textfield' ? 40 : preferredWidth;
        const defaultWidth = Math.min(preferredWidth, pageSize.width / 3);
        const defaultHeight = Math.min(preferredHeight, pageSize.height / 4);
        replaceShape(drawingShape.pageIndex, {
          ...shape,
          x: clamp(drawingShape.start.x, 0, pageSize.width - defaultWidth),
          y: clamp(drawingShape.start.y, 0, pageSize.height - defaultHeight),
          width: defaultWidth,
          height: defaultHeight
        });
      }
      drawingShape = null;
      shapeGuides = null;
      activeTool = 'select';
      if (shape?.type === 'textfield') {
        editingTextShape = { pageIndex: finishedPageIndex, id: shape.id };
        tick().then(() => focusTextEditor(shape.id));
      }
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

  /** @param {boolean} [resetAnnotations] */
  async function loadPdf(resetAnnotations = true) {
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
    pageCount = 0;
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
        renderPages(pdfViewer, document, generation),
        renderThumbnails(document, generation)
      ]);
      status = '';
      pdfReady = true;
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

    if (htmlViewportActive()) htmlEditor?.scrollToPage?.(pageIndex);
    else viewer?.querySelectorAll('.pdf-page')[pageIndex]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
          radiusY: 0,
          text: shape.text ?? '',
          imageData: shape.imageData ?? ''
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
        color: rect.color ?? [],
        text: ''
      })));
    });
    return [...strokes, ...exportedShapes, ...exportedHighlights];
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
    stopSignatureCamera();
    cancelSharpRenders();
    textLayerBuilders.forEach((builder) => builder.cancel());
    textLayerAbortController?.abort();
    void pdfLoadingTask?.destroy();
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

<section class="pdf-workspace" aria-label={`PDF editor for ${workingFile.name}`} bind:this={workspace}>
  {#if htmlEditorStarted}
    <div class:active={htmlViewportVisible} class="html-editor-layer">
      <HtmlPdfEditor
        bind:this={htmlEditor}
        bind:zoomLevel
        {activeTool}
        {zoomingOut}
        file={workingFile}
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
    onpointerleave={hideEraserCursor}
  >
    <div class="pdf-document" style:--zoom-level={zoomLevel}>
      {#each Array(pageCount) as _, index}
        {@const currentSelectedShapes = selectedShape?.pageIndex === index ? (shapes[index] ?? []).filter((shape) => selectedShapeIds.has(shape.id)) : []}
        {@const singleSelection = currentSelectedShapes.length === 1 ? currentSelectedShapes[0] : null}
        {@const currentSelection = currentSelectedShapes.length > 1 && multiSelectionFrame?.pageIndex === index && selectedShape ? frameAsShape(multiSelectionFrame, selectedShape.id) : singleSelection}
        {@const activeTextEditorShape = editingTextShape?.pageIndex === index ? findShape(index, editingTextShape.id) : null}
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
                  />
                {:else if ['underline', 'crossout'].includes(highlight.type ?? 'highlight')}
                  <line
                    class="text-decoration"
                    x1={rect.x}
                    y1={rect.y + rect.height * ((highlight.type ?? 'highlight') === 'underline' ? 0.9 : 0.52)}
                    x2={rect.x + rect.width}
                    y2={rect.y + rect.height * ((highlight.type ?? 'highlight') === 'underline' ? 0.9 : 0.52)}
                    stroke={textMarkCssColor(rect.color)}
                    style:--decoration-width={`${Math.max(1.25, Math.min(2.2, rect.height * 0.09))}px`}
                  />
                {/if}
              {/each}
            {/each}
          </svg>
          <svg
            class="annotation-layer shape-layer"
            viewBox={`0 0 ${pageSizes[index]?.width ?? 1} ${pageSizes[index]?.height ?? 1}`}
            preserveAspectRatio="none"
            aria-label={`Shapes on page ${index + 1}`}
          >
            {#each (shapes[index] ?? []) as shape (shape.id)}
              {@const wrappedTextLines = shape.type === 'textfield' ? textFieldLines(shape.text ?? '', shape.width) : []}
              <g transform={`rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`}>
                {#if shape.type === 'textfield'}
                  {#if editingTextShape?.pageIndex !== index || editingTextShape.id !== shape.id}
                    {@const displayedLines = shape.text ? wrappedTextLines : ['Type here']}
                    {@const displayedHeight = Math.max(shape.height, Math.max(1, displayedLines.length) * 19.2)}
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
                      {#each displayedLines as line, lineIndex}
                        <text x={shape.x + 6} y={shape.y + 15.2 + lineIndex * 19.2}>{line}</text>
                      {/each}
                    </g>
                  {/if}
                {:else if shape.type === 'signature'}
                  <image
                    class="pdf-signature"
                    data-shape-id={shape.id}
                    data-shape-page={index}
                    href={shape.imageData}
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                    preserveAspectRatio="none"
                  />
                {:else if shape.type === 'rectangle'}
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
              <textarea
                data-text-editor={activeTextEditorShape.id}
                data-min-height={activeTextEditorShape.height}
                aria-label="Edit text field"
                rows="1"
                wrap="soft"
                value={activeTextEditorShape.text ?? ''}
                oninput={updateTextField}
                onkeydown={handleTextFieldKeydown}
                onpointerdown={handleTextEditorPointerDown}
                onmousedown={(event) => event.stopPropagation()}
                onclick={(event) => event.stopPropagation()}
                onblur={(event) => retainTextEditorFocus(event, activeTextEditorShape.id)}
              ></textarea>
            </div>
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
              style={`transform: translateX(${signatureTab === 'draw' ? 0 : signatureTab === 'write' ? 100 : 200}%);`}
            ></span>
            <button class:active={signatureTab === 'draw'} type="button" role="tab" aria-selected={signatureTab === 'draw'} onclick={() => signatureTab = 'draw'}>Draw</button>
            <button class:active={signatureTab === 'write'} type="button" role="tab" aria-selected={signatureTab === 'write'} onclick={() => signatureTab = 'write'}>Write</button>
            <button class:active={signatureTab === 'image'} type="button" role="tab" aria-selected={signatureTab === 'image'} onclick={() => signatureTab = 'image'}>Image</button>
          </div>

          <div class="signature-tab-content">
            {#key signatureTab}
              <div class="signature-tab-copy" in:fly={{ x: 8, duration: 210, easing: cubicOut }} out:fade={{ duration: 100 }}>
                {#if signatureTab === 'image'}
                  <p>Write your signature on paper and take a photo or upload a photo of your signature.</p>
                {:else if signatureTab === 'draw'}
                  <p>Draw your signature using your mouse, trackpad, or touchscreen.</p>
                {:else}
                  <p>Write your name and choose a signature style.</p>
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
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    transition: height 300ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms ease;
    -webkit-font-smoothing: antialiased;
  }

  .protect-panel.encrypted {
    height: 342px;
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

  .protect-panel-header h2 {
    margin: 0 0 1px 7px;
    overflow: hidden;
    color: #000;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
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

  .signature-tabs {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    align-self: center;
    box-sizing: border-box;
    height: 42px;
    margin: 12px 18px 10px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background:
      linear-gradient(#d7d7d7, #d7d7d7) calc(100% / 3) 0 / 1px 100% no-repeat,
      linear-gradient(#d7d7d7, #d7d7d7) calc(200% / 3) 0 / 1px 100% no-repeat,
      #f3f3f3;
  }

  .signature-tab-indicator {
    position: absolute;
    z-index: 1;
    inset: 0 auto 0 0;
    width: calc(100% / 3);
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

  .pdf-signature {
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
    background: #e9e9e9;
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
    top: 23px;
    left: 60px;
    width: 350px;
    height: 20px;
    padding-left: 2px;
    background: linear-gradient(90deg, #474747 0%, #9e9e9e 31.877%, #474747 72.516%);
    background-position: 140% 50%;
    background-size: 230% 100%;
    color: transparent;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 20px;
    font-weight: 400;
    line-height: 1;
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

  .shape-layer {
    z-index: 3;
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

  .pdf-text-editor-overlay textarea {
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
    resize: none;
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
