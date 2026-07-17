<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import HtmlAnnotationOverlay from '$lib/HtmlAnnotationOverlay.svelte';

  /** @type {File} */
  export let file;
  export let activeTool = 'edit';
  export let zoomLevel = 1;
  export let zoomingOut = false;
  export let onEditorReady = () => {};
  /** @type {any[]} */
  export let visualAnnotations = [];
  /** @type {any[]} */
  let foregroundAnnotations = [];

  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {HTMLDivElement | undefined} */
  let viewer;
  /** @type {HTMLIFrameElement | undefined} */
  let htmlFrame;
  /** @type {HTMLDivElement | undefined} */
  let htmlViewport;
  let status = 'Import a PDF to begin.';
  /** @type {import('pdfjs-dist').PDFDocumentProxy | null} */
  let pdfDocument = null;
  /** @type {ArrayBuffer | null} */
  let pdfBytes = null;
  let fileName = 'document.pdf';
  /** @type {{ pageNumber: number; width: number; height: number }[]} */
  let pages = [];
  /** @type {{ id: string; page: number; occurrence?: number; rect: number[]; originalRect?: number[]; pageSize?: number[]; fontSize?: number; fontName?: string; bold?: boolean; moved?: boolean; color?: number[]; oldText: string; oldTextCandidates: string[]; newText: string }[]} */
  let edits = [];
  let isRendering = false;
  let isConvertingHtml = false;
  let editMode = false;
  let htmlMode = false;
  let convertedHtml = '';
  let exportUrl = '';
  let maskFrame = 0;
  let overlayFrame = 0;
  /** @type {{ page: number; left: number; top: number; width: number; height: number }[]} */
  let overlayPageFrames = [];
  /** @type {Map<string, { element: HTMLElement; left: number; top: number; width: number; height: number }>} */
  const textHighlightBindings = new Map();
  /** @type {Map<string, { x: number; y: number; width: number; height: number }>} */
  const resolvedTextHighlightRects = new Map();
  let embeddedFontStyle = '';
  /** @type {Record<string, string>} */
  let embeddedFontFamilies = {};

  $: foregroundAnnotations = visualAnnotations.filter(
    (annotation) => !['highlight', 'underline', 'crossout', 'blackout', 'whiteout', 'marker'].includes(annotation?.type)
  );
  $: if (htmlFrame && visualAnnotations) {
    visualAnnotations;
    scheduleHtmlGeometrySync();
  }
  /** @type {Record<string, string>} */
  let htmlFontNames = {};
  /** @type {Record<string, { text: string; htmlText: string }>} */
  let convertedHtmlOriginalTexts = {};
  let detectedFont = '';
  let activeHtmlTextId = '';
  let activeHtmlTextBoxId = '';
  let htmlBoxSelectionActive = false;
  let htmlBoldActive = false;
  let htmlItalicActive = false;
  let htmlUnderlineActive = false;
  let htmlStrikethroughActive = false;
  let htmlFontFamily = '';
  let htmlFontSize = 16;
  let htmlFontWeight = 400;
  let htmlTextColor = '#171717';
  let htmlLetterSpacing = 0;
  let htmlLineHeight = 19.2;
  let htmlTextAlign = 'left';
  /** @type {Record<string, { value: string; label: string }>} */
  let htmlOriginalFonts = {};
  /** @type {{ hue: number; saturation: number; value: number } | null} */
  let htmlColorPicker = null;
  /** @type {{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null} */
  let htmlPanStart = null;
  let htmlShiftPressed = false;
  /** @type {Range | null} */
  let savedHtmlSelection = null;

  const scale = 1.45;
  const minZoom = 0.5;
  const maxZoom = 4;
  const clickZoomFactor = 1.25;
  // Keep empty scrollable space beyond both page edges. The matching initial
  // scroll offset makes this invisible until the user pans into it.
  const horizontalPanGutter = 420;
  const verticalPanGutter = 520;
  const backendUrl = '/api/pdf/edit';
  const fontUrl = '/api/pdf/fonts';
  const htmlConvertUrl = '/api/pdf/convert';

  $: if (htmlFrame && convertedHtml) {
    applyHtmlViewportStyles();
    updateHtmlToolMode();
  }

  async function initializeFile() {
    if (!file) return;
    cleanupExportUrl();
    pdfDocument?.destroy?.();
    pdfDocument = null;
    pages = [];
    edits = [];
    editMode = false;
    htmlMode = false;
    convertedHtml = '';
    embeddedFontStyle = '';
    embeddedFontFamilies = {};
    htmlFontNames = {};
    convertedHtmlOriginalTexts = {};
    htmlOriginalFonts = {};
    detectedFont = '';
    activeHtmlTextId = '';
    activeHtmlTextBoxId = '';
    htmlBoxSelectionActive = false;
    htmlBoldActive = false;
    htmlItalicActive = false;
    resetHtmlFormattingState();
    savedHtmlSelection = null;
    fileName = file.name || 'document.pdf';
    pdfBytes = await file.arrayBuffer();
    status = `Preparing ${fileName} for text editing…`;
    await Promise.all([loadEmbeddedFonts(pdfBytes), convertToHtmlLayer()]);
  }

  /** @param {Event} event */
  async function handleImport(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0];
    if (!file) return;

    cleanupExportUrl();
    pdfDocument?.destroy?.();
    pdfDocument = null;
    pages = [];
    edits = [];
    editMode = false;
    htmlMode = false;
    convertedHtml = '';
    embeddedFontStyle = '';
    embeddedFontFamilies = {};
    htmlFontNames = {};
    convertedHtmlOriginalTexts = {};
    htmlOriginalFonts = {};
    detectedFont = '';
    activeHtmlTextId = '';
    activeHtmlTextBoxId = '';
    htmlBoxSelectionActive = false;
    htmlBoldActive = false;
    htmlItalicActive = false;
    resetHtmlFormattingState();
    savedHtmlSelection = null;
    fileName = file.name || 'document.pdf';
    pdfBytes = await file.arrayBuffer();
    status = `Loaded ${fileName}. Rendering pages...`;
    await loadPdf(pdfBytes);
    await convertToHtmlLayer();
  }

  /** @param {ArrayBuffer} bytes */
  async function loadPdf(bytes) {
    isRendering = true;

    try {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

      pdfDocument = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
      pages = Array.from({ length: pdfDocument.numPages }, (_, index) => ({
        pageNumber: index + 1,
        width: 0,
        height: 0
      }));

      await loadEmbeddedFonts(bytes);
      await tick();
      await renderPages(pdfjs);
      status = `${pdfDocument.numPages} page${pdfDocument.numPages === 1 ? '' : 's'} ready.`;
    } catch (error) {
      console.error(error);
      status = 'Could not render that PDF.';
    } finally {
      isRendering = false;
    }
  }

  /** @param {typeof import('pdfjs-dist')} pdfjs */
  async function renderPages(pdfjs) {
    const document = pdfDocument;
    if (!document) return;

    const pageShells = viewer?.querySelectorAll('.page-shell') ?? [];

    for (let index = 0; index < pageShells.length; index += 1) {
      const pageNumber = index + 1;
      const shell = pageShells[index];
      if (!(shell instanceof HTMLElement)) continue;

      const canvas = shell.querySelector('canvas');
      const editUnderlay = shell.querySelector('.edit-underlay');
      const textLayer = shell.querySelector('.textLayer');
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const outputScale = window.devicePixelRatio || 1;
      if (
        !(canvas instanceof HTMLCanvasElement) ||
        !(textLayer instanceof HTMLDivElement)
      ) continue;
      const context = canvas.getContext('2d');
      if (!context) continue;

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      shell.style.width = `${viewport.width}px`;
      shell.style.height = `${viewport.height}px`;
      if (editUnderlay instanceof HTMLDivElement) {
        editUnderlay.style.width = `${viewport.width}px`;
        editUnderlay.style.height = `${viewport.height}px`;
      }
      textLayer.style.width = `${viewport.width}px`;
      textLayer.style.height = `${viewport.height}px`;
      textLayer.style.setProperty('--scale-factor', String(scale));
      textLayer.style.setProperty('--user-unit', '1');
      textLayer.style.setProperty('--total-scale-factor', String(scale));

      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
      }).promise;

      textLayer.replaceChildren();

      try {
        const textContent = await collectTextContent(page);
        const layer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport
        });
        await layer.render();
        applyTextItemStyling(textLayer, textContent);
        await waitForFonts();
        fitTextLayerSpacing(textLayer);
      } catch (error) {
        console.warn(`Could not render text layer for page ${pageNumber}.`, error);
      }

      pages[index] = {
        pageNumber,
        width: viewport.width,
        height: viewport.height
      };
      pages = pages;
    }

    prepareEditLayers();
    syncEditMasks();
  }

  /** @param {import('pdfjs-dist').PDFPageProxy} page */
  async function collectTextContent(page) {
    const reader = page.streamTextContent().getReader();
    /** @type {{ items: any[]; styles: Record<string, any>; lang: string | null }} */
    const textContent = {
      items: [],
      styles: Object.create(null),
      lang: null
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (Array.isArray(value.items)) {
        textContent.items.push(...value.items);
      }
      if (value.styles && typeof value.styles === 'object') {
        Object.assign(textContent.styles, value.styles);
      }
      if (value.lang) {
        textContent.lang = value.lang;
      }
    }

    return textContent;
  }

  /** @param {ArrayBuffer} bytes */
  async function loadEmbeddedFonts(bytes) {
    try {
      const response = await fetch(fontUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: await arrayBufferToBase64(bytes) })
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error || 'Could not extract embedded fonts.');
      }
      /** @type {{ pdfJsName?: unknown; family?: unknown; baseName?: unknown }[]} */
      const fonts = Array.isArray(result.fonts) ? result.fonts : [];
      embeddedFontStyle = typeof result.css === 'string' && result.css
        ? `<style data-docuflex-pdf-fonts>${result.css}</style>`
        : '';
      embeddedFontFamilies = Object.fromEntries(
        fonts
          .filter((font) => typeof font?.pdfJsName === 'string' && typeof font?.family === 'string')
          .map((font) => [font.pdfJsName, font.family])
      );
      htmlFontNames = Object.fromEntries(
        fonts.flatMap((font) => {
          if (typeof font?.pdfJsName !== 'string' || typeof font?.baseName !== 'string') return [];
          const match = font.pdfJsName.match(/f(\d+)$/);
          const index = match ? Number(match[1]) : NaN;
          return Number.isFinite(index) ? [[`ff${index.toString(16)}`, font.baseName]] : [];
        })
      );
    } catch (error) {
      console.warn('Could not load embedded PDF fonts; using PDF.js fallbacks.', error);
      embeddedFontStyle = '';
      embeddedFontFamilies = {};
      htmlFontNames = {};
    }
  }

  async function waitForFonts() {
    if (!('fonts' in document)) return;
    try {
      await document.fonts.ready;
    } catch {
      // Font loading failures fall back to the browser fonts declared after the embedded subset.
    }
  }

  function triggerImport() {
    fileInput?.click();
  }

  function modifyText() {
    if (!pages.length) return;
    htmlMode = false;
    editMode = !editMode;
    prepareEditLayers();
    scheduleMaskSync();
    status = editMode
      ? 'Text edit mode on. Click text, type, then export.'
      : `${edits.length} edit${edits.length === 1 ? '' : 's'} staged.`;
  }

  async function convertToHtmlLayer() {
    if (!pdfBytes) {
      status = 'Import a PDF before converting.';
      return;
    }

    isConvertingHtml = true;
    textHighlightBindings.clear();
    resolvedTextHighlightRects.clear();
    editMode = false;
    status = 'Sending PDF to pdf2htmlEX converter...';

    try {
      const response = await fetch(htmlConvertUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: await arrayBufferToBase64(pdfBytes) })
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error || 'pdf2htmlEX conversion failed.');
      }
      if (typeof result.htmlBase64 !== 'string') {
        throw new Error('Converter did not return HTML.');
      }
      convertedHtml = makeConvertedHtmlEditable(base64ToUtf8(result.htmlBase64));
      htmlMode = true;
      status = `Loaded pdf2htmlEX HTML layer (${Math.round((result.bytes ?? convertedHtml.length) / 1024)} KB).`;
    } catch (error) {
      console.error(error);
      status = error instanceof Error ? error.message : 'pdf2htmlEX conversion failed.';
      onEditorReady();
    } finally {
      isConvertingHtml = false;
    }
  }

  function showPdfLayer() {
    htmlMode = false;
    status = pages.length ? `${pages.length} page${pages.length === 1 ? '' : 's'} ready.` : status;
  }

  async function exportPdf() {
    commitFocusedEdit();

    if (!pdfBytes) {
      status = 'Import a PDF before exporting.';
      return;
    }

    if (htmlMode && convertedHtml) {
      await exportHtmlEditedPdf();
      return;
    }

    if (edits.length) {
      await exportEditedPdf();
      return;
    }

    cleanupExportUrl();
    const blob = new Blob([pdfBytes.slice(0)], { type: 'application/pdf' });
    downloadBlob(blob, exportedName(fileName));
    status = `Exported ${exportedName(fileName)}.`;
  }

  async function exportHtmlEditedPdf() {
    if (!pdfBytes) return;
    htmlFrame?.contentDocument?.body?.normalize();
    const htmlEdits = await collectConvertedHtmlEdits();
    if (!htmlEdits.length) {
      status = 'No edited PDF text was detected in the HTML editor.';
      return;
    }

    await exportEditedPdf(htmlEdits);
  }

  function exportEditedHtml() {
    const documentElement = htmlFrame?.contentDocument?.documentElement;
    const html = documentElement
      ? `<!DOCTYPE html>\n${documentElement.outerHTML}`
      : convertedHtml;
    const name = fileName.toLowerCase().endsWith('.pdf')
      ? fileName.replace(/\.pdf$/i, '-edited.html')
      : `${fileName}-edited.html`;
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), name);
    status = `Exported ${name}.`;
  }

  /**
   * @param {{ id: string; page: number; occurrence?: number; rect: number[]; originalRect?: number[]; pageSize?: number[]; fontSize?: number; fontName?: string; bold?: boolean; moved?: boolean; color?: number[]; oldText: string; oldTextCandidates: string[]; newText: string }[]} [editsToApply]
   */
  async function exportEditedPdf(editsToApply = edits) {
    if (!pdfBytes) return;

    isRendering = true;
    const movedCount = editsToApply.filter((edit) => Boolean(edit.moved)).length;
    status = `Sending ${editsToApply.length} edit${editsToApply.length === 1 ? '' : 's'}`
      + (movedCount ? ` (${movedCount} moved)` : '')
      + ' to PDFBox...';

    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64: await arrayBufferToBase64(pdfBytes),
          edits: editsToApply
        })
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error || 'PDFBox export failed.');
      }

      const editedBytes = base64ToArrayBuffer(result.pdfBase64);
      pdfBytes = editedBytes;
      cleanupExportUrl();
      downloadBlob(new Blob([editedBytes], { type: 'application/pdf' }), exportedName(fileName));

      const misses = Array.isArray(result.misses) ? result.misses : [];
      if (misses.length) {
        console.warn('PDFBox could not apply some real text edits:', misses);
        status = `Exported with ${result.applied} real text edit${result.applied === 1 ? '' : 's'}`
          + (movedCount ? `, including ${movedCount} moved` : '')
          + `; ${misses.length} edit${misses.length === 1 ? '' : 's'} could not be matched.`;
      } else {
        status = `Exported ${result.applied} real text edit${result.applied === 1 ? '' : 's'}`
          + (movedCount ? `, including ${movedCount} moved` : '')
          + '.';
      }
    } catch (error) {
      console.error(error);
      status = 'Could not export edits. Start the PDFBox backend with npm run backend:dev.';
    } finally {
      isRendering = false;
    }
  }

  async function collectConvertedHtmlEdits() {
    const frameEdits = await requestConvertedHtmlEditsFromFrame();
    if (frameEdits.length) return frameEdits;

    const doc = htmlFrame?.contentDocument;
    if (!doc) return [];

    /** @type {{ id: string; page: number; occurrence?: number; rect: number[]; originalRect?: number[]; pageSize?: number[]; fontSize?: number; fontName?: string; bold?: boolean; moved?: boolean; color?: number[]; oldText: string; oldTextCandidates: string[]; newText: string }[]} */
    const htmlEdits = [];
    const sourceOriginals = Object.keys(convertedHtmlOriginalTexts).length
      ? convertedHtmlOriginalTexts
      : extractConvertedHtmlOriginalTexts(convertedHtml);
    const editNodes = new Map();
    doc.querySelectorAll('[data-docuflex-edit-id]').forEach((node) => {
      if (node.nodeType !== 1) return;
      const htmlNode = /** @type {HTMLElement} */ (node);
      editNodes.set(htmlNode.dataset.docuflexEditId || `fallback-${editNodes.size}`, htmlNode);
    });
    doc.querySelectorAll('.t').forEach((node, index) => {
      if (node.nodeType !== 1) return;
      const htmlNode = /** @type {HTMLElement} */ (node);
      const id = htmlNode.dataset.docuflexEditId || `html-text-${index}`;
      if (!editNodes.has(id)) editNodes.set(id, htmlNode);
    });

    Array.from(editNodes.values()).forEach((node, index) => {
      rememberConvertedHtmlOriginal(node);
      const id = node.dataset.docuflexEditId || `html-text-${index}`;
      const original = sourceOriginals[id];
      const oldText = normalizeLineText(original?.text ?? node.dataset.docuflexOriginalText ?? '');
      const newText = normalizedConvertedNodeText(node);
      if (!oldText || oldText === newText) return;

      const pageElement = node.closest('[data-page-no]');
      const page = pageElement?.nodeType === 1
        ? Math.max(0, Number((/** @type {HTMLElement} */ (pageElement)).dataset.pageNo ?? '1') - 1)
        : 0;
      htmlEdits.push({
        id: `html-${page}-${index}`,
        page,
        occurrence: convertedHtmlOccurrence(node, oldText),
        rect: convertedHtmlRect(node),
        pageSize: convertedHtmlPageSize(node),
        fontSize: convertedHtmlFontSize(node),
        fontName: convertedHtmlFontName(node),
        bold: isConvertedNodeBold(node),
        color: convertedHtmlColor(node),
        oldText,
        oldTextCandidates: textCandidatesForHtmlNode(node, oldText, original?.htmlText ?? ''),
        newText
      });
    });
    return htmlEdits;
  }

  export async function capturePendingTextEdits() {
    htmlFrame?.contentDocument?.body?.normalize();
    return collectConvertedHtmlEdits();
  }

  /**
   * Applies the currently staged HTML text changes to a PDF and returns its bytes.
   * The parent editor can then apply marker, pen, highlight, and shape annotations.
   * @param {ArrayBuffer | null} [sourceBytes]
   * @param {unknown[] | null} [capturedEdits]
   */
  export async function applyTextEdits(sourceBytes = pdfBytes, capturedEdits = null) {
    if (!sourceBytes) throw new Error('The source PDF is not available.');
    htmlFrame?.contentDocument?.body?.normalize();
    const htmlEdits = Array.isArray(capturedEdits) ? capturedEdits : await collectConvertedHtmlEdits();
    if (!htmlEdits.length) return sourceBytes.slice(0);

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfBase64: await arrayBufferToBase64(sourceBytes),
        edits: htmlEdits
      })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.pdfBase64) {
      throw new Error(result?.error || `PDF text export failed (${response.status}).`);
    }
    const misses = Array.isArray(result.misses) ? result.misses : [];
    if (misses.length) console.warn('PDFBox could not apply some HTML text edits:', misses);
    return base64ToArrayBuffer(result.pdfBase64);
  }

  export async function hasPendingTextEdits() {
    htmlFrame?.contentDocument?.body?.normalize();
    return (await collectConvertedHtmlEdits()).length > 0;
  }

  /** @param {ArrayBuffer} appliedBytes */
  export async function commitAppliedTextEdits(appliedBytes) {
    pdfBytes = appliedBytes.slice(0);
    const frameWindow = htmlFrame?.contentWindow;
    try {
      const rebaseEdits = /** @type {{ __docuflexRebaseEdits?: () => void }} */ (frameWindow)?.__docuflexRebaseEdits;
      rebaseEdits?.();
    } catch {
      // Fall through to the DOM baseline refresh below.
    }

    const doc = htmlFrame?.contentDocument;
    /** @type {Record<string, { text: string; htmlText: string }>} */
    const rebasedOriginals = {};
    doc?.querySelectorAll('[data-docuflex-edit-id]').forEach((node) => {
      if (node.nodeType !== 1) return;
      const htmlNode = /** @type {HTMLElement} */ (node);
      const currentText = normalizeLineText(convertedVisibleText(htmlNode));
      if (!currentText) return;
      const id = htmlNode.dataset.docuflexEditId || `html-text-${Object.keys(rebasedOriginals).length}`;
      const htmlText = htmlNode.textContent ?? currentText;
      htmlNode.dataset.docuflexOriginalText = currentText;
      htmlNode.dataset.docuflexOriginalHtmlText = htmlText;
      rebasedOriginals[id] = { text: currentText, htmlText };
    });
    if (Object.keys(rebasedOriginals).length) convertedHtmlOriginalTexts = rebasedOriginals;
    scheduleHtmlGeometrySync();
  }

  export function resolvedTextHighlights() {
    syncUnderTextAnnotationLayers();
    return visualAnnotations.flatMap((annotation) => {
      if (!['highlight', 'underline', 'crossout', 'blackout', 'whiteout'].includes(annotation?.type)) return [];
      const id = String(annotation.id || '');
      const resolved = resolvedTextHighlightRects.get(id) ?? {
        x: Number(annotation.x || 0),
        y: Number(annotation.y || 0),
        width: Number(annotation.width || 0),
        height: Number(annotation.height || 0)
      };
      return [{ id, page: Number(annotation.page || 0), ...resolved }];
    });
  }

  async function requestConvertedHtmlEditsFromFrame() {
    const frameWindow = htmlFrame?.contentWindow;
    if (!frameWindow) return [];

    try {
      const collectEdits = /** @type {{ __docuflexCollectEdits?: () => unknown }} */ (frameWindow).__docuflexCollectEdits;
      if (typeof collectEdits === 'function') {
        return normalizeFrameEdits(collectEdits());
      }
    } catch {
      // Fall through to postMessage for browsers that isolate srcdoc more aggressively.
    }

    const requestId = `docuflex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handleResponse);
        resolve([]);
      }, 700);

      /** @param {MessageEvent} event */
      function handleResponse(event) {
        const data = event.data;
        if (
          event.source !== frameWindow ||
          !data ||
          data.source !== 'docuflex-html-editor' ||
          data.type !== 'edits-response' ||
          data.requestId !== requestId
        ) return;
        clearTimeout(timeout);
        window.removeEventListener('message', handleResponse);
        resolve(normalizeFrameEdits(data.edits));
      }

      window.addEventListener('message', handleResponse);
      frameWindow.postMessage({
        source: 'docuflex-parent',
        type: 'collect-edits',
        requestId
      }, '*');
    });
  }

  /** @param {unknown} editsFromFrame */
  function normalizeFrameEdits(editsFromFrame) {
    if (!Array.isArray(editsFromFrame)) return [];
    return editsFromFrame.flatMap((item, index) => {
      if (!item || typeof item !== 'object') return [];
      const edit = /** @type {Record<string, unknown>} */ (item);
      if (edit.kind === 'image') {
        const rect = Array.isArray(edit.rect) ? edit.rect.map(Number).filter(Number.isFinite) : [];
        const originalRect = Array.isArray(edit.originalRect) ? edit.originalRect.map(Number).filter(Number.isFinite) : [];
        if (rect.length < 4 || originalRect.length < 4) return [];
        return [{
          kind: 'image',
          id: typeof edit.id === 'string' ? edit.id : `html-image-${index}`,
          page: Number.isFinite(Number(edit.page)) ? Number(edit.page) : 0,
          occurrence: Number.isFinite(Number(edit.occurrence)) ? Number(edit.occurrence) : -1,
          group: Boolean(edit.group),
          rect,
          originalRect
        }];
      }
      const oldText = normalizeLineText(String(edit.oldText ?? ''));
      const preserveLeadingSpacing = Boolean(edit.preserveLeadingSpacing);
      const rawNewText = String(edit.newText ?? '');
      const newText = preserveLeadingSpacing
        ? rawNewText.replace(/\s+/g, ' ').replace(/\s+$/g, '')
        : normalizeLineText(rawNewText);
      const moved = Boolean(edit.moved);
      const overlay = Boolean(edit.overlay);
      if (!oldText || (!moved && !overlay && oldText === newText)) return [];
      const originalHtmlText = String(edit.originalHtmlText ?? '');
      return [{
        kind: 'text',
        id: typeof edit.id === 'string' ? edit.id : `html-frame-${index}`,
        page: Number.isFinite(Number(edit.page)) ? Number(edit.page) : 0,
        occurrence: Number.isFinite(Number(edit.occurrence)) ? Number(edit.occurrence) : -1,
        group: false,
        rect: Array.isArray(edit.rect) ? edit.rect.map(Number).filter(Number.isFinite) : [],
        alignRect: Array.isArray(edit.alignRect) ? edit.alignRect.map(Number).filter(Number.isFinite) : [],
        visualRect: Array.isArray(edit.visualRect) ? edit.visualRect.map(Number).filter(Number.isFinite) : [],
        originalRect: Array.isArray(edit.originalRect) ? edit.originalRect.map(Number).filter(Number.isFinite) : [],
        pageSize: Array.isArray(edit.pageSize) ? edit.pageSize.map(Number).filter(Number.isFinite) : [],
        fontSize: Number.isFinite(Number(edit.fontSize)) ? Number(edit.fontSize) : 0,
        fontName: resolvedFrameFontName(edit),
        bold: Boolean(edit.bold),
        fontChanged: Boolean(edit.fontChanged),
        boldChanged: Boolean(edit.boldChanged),
        italic: Boolean(edit.italic),
        italicChanged: Boolean(edit.italicChanged),
        underline: Boolean(edit.underline),
        strikethrough: Boolean(edit.strikethrough),
        letterSpacing: Number.isFinite(Number(edit.letterSpacing)) ? Number(edit.letterSpacing) : 0,
        moved,
        overlay,
        alignment: typeof edit.alignment === 'string' ? edit.alignment : '',
        color: Array.isArray(edit.color) ? edit.color.map(Number).filter(Number.isFinite) : [],
        oldText,
        oldTextCandidates: [
          oldText,
          originalHtmlText,
          stripPdf2HtmlSpacing(originalHtmlText),
          String(edit.currentHtmlText ?? ''),
          stripPdf2HtmlSpacing(String(edit.currentHtmlText ?? ''))
        ].map(normalizeLineText).filter((value, valueIndex, values) => value.length > 1 && values.indexOf(value) === valueIndex),
        newText
      }];
    });
  }

  /** @param {Record<string, unknown>} edit */
  function resolvedFrameFontName(edit) {
    const explicit = typeof edit.fontName === 'string' ? cleanFontFamilyLabel(edit.fontName) : '';
    if (explicit && !/^ff[0-9a-f]+$/i.test(explicit)) return explicit;
    const mapped = frameFontName(typeof edit.fontClass === 'string' ? edit.fontClass : '');
    if (mapped && !/^ff[0-9a-f]+$/i.test(mapped)) return mapped;
    const family = typeof edit.fontFamily === 'string' ? cleanFontFamilyLabel(edit.fontFamily) : '';
    return family && !/^ff[0-9a-f]+$/i.test(family) ? family : (mapped || explicit);
  }

  /** @param {string} value */
  function cleanFontFamilyLabel(value) {
    return value.split(',')[0]?.replace(/["']/g, '').trim() ?? '';
  }

  /** @param {HTMLElement} node @param {string} oldText @param {string} originalHtmlText */
  function textCandidatesForHtmlNode(node, oldText, originalHtmlText = '') {
    const values = [
      oldText,
      originalHtmlText,
      stripPdf2HtmlSpacing(originalHtmlText),
      node.dataset.docuflexOriginalHtmlText ?? '',
      stripPdf2HtmlSpacing(node.dataset.docuflexOriginalHtmlText ?? ''),
      node.textContent ?? '',
      stripPdf2HtmlSpacing(node.textContent ?? '')
    ];
    return [...new Set(values.map(normalizeLineText).filter((value) => value.length > 1))];
  }

  /** @param {HTMLElement} node */
  function normalizedConvertedNodeText(node) {
    return normalizeLineText(convertedVisibleText(node) || node.innerText || node.textContent || node.dataset.docuflexCurrentText || '');
  }

  /** @param {Element} node */
  function convertedVisibleText(node) {
    const clone = node.cloneNode(true);
    if (!(clone instanceof Element)) return '';
    clone.querySelectorAll('._').forEach((spacer) => spacer.remove());
    return clone.textContent ?? '';
  }

  /** @param {HTMLElement} element */
  function convertedImagePaperColor(element) {
    if (!(element instanceof HTMLImageElement) || !element.complete || !element.naturalWidth || !element.naturalHeight) {
      return '';
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 12;
      canvas.height = 12;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return '';
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let luminance = 0;
      let saturation = 0;
      let paperRed = 0;
      let paperGreen = 0;
      let paperBlue = 0;
      let paperSamples = 0;
      for (let index = 0; index < data.length; index += 4) {
        const red = data[index] / 255;
        const green = data[index + 1] / 255;
        const blue = data[index + 2] / 255;
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const sampleLuminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
        luminance += sampleLuminance;
        saturation += max === 0 ? 0 : (max - min) / max;
        if (sampleLuminance > 0.72) {
          paperRed += data[index];
          paperGreen += data[index + 1];
          paperBlue += data[index + 2];
          paperSamples += 1;
        }
      }
      const samples = data.length / 4;
      if (luminance / samples <= 0.78 || saturation / samples >= 0.16 || paperSamples < 8) return '';
      return `rgb(${Math.round(paperRed / paperSamples)}, ${Math.round(paperGreen / paperSamples)}, ${Math.round(paperBlue / paperSamples)})`;
    } catch {
      return '';
    }
  }

  /** @param {HTMLElement} page @param {HTMLElement} element */
  function convertedImageHasAlignedText(page, element) {
    if (!(element instanceof HTMLImageElement) || !element.naturalWidth || !element.naturalHeight) return false;
    const imageRect = element.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height) return false;

    const textNodes = Array.from(page.querySelectorAll('.t')).filter((node) => {
      if (!(node instanceof Element) || normalizeLineText(convertedVisibleText(node)).length <= 1) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 4 && rect.height > 3;
    }).slice(0, 100);
    if (textNodes.length < 2) return false;

    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 10;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;

    let tested = 0;
    let matched = 0;
    for (const node of textNodes) {
      const rect = node.getBoundingClientRect();
      const left = Math.max(rect.left, imageRect.left);
      const top = Math.max(rect.top, imageRect.top);
      const right = Math.min(rect.right, imageRect.right);
      const bottom = Math.min(rect.bottom, imageRect.bottom);
      if (right <= left || bottom <= top) continue;

      const sourceX = ((left - imageRect.left) / imageRect.width) * element.naturalWidth;
      const sourceY = ((top - imageRect.top) / imageRect.height) * element.naturalHeight;
      const sourceWidth = ((right - left) / imageRect.width) * element.naturalWidth;
      const sourceHeight = ((bottom - top) / imageRect.height) * element.naturalHeight;
      if (sourceWidth < 1 || sourceHeight < 1) continue;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(element, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const darkRows = new Set();
      const darkColumns = new Set();
      let darkPixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        const red = data[index] / 255;
        const green = data[index + 1] / 255;
        const blue = data[index + 2] / 255;
        const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
        if (luminance >= 0.55) continue;
        const pixel = index / 4;
        darkRows.add(Math.floor(pixel / canvas.width));
        darkColumns.add(pixel % canvas.width);
        darkPixels += 1;
      }
      tested += 1;
      const darkRatio = darkPixels / (canvas.width * canvas.height);
      if (darkRatio > 0.012 && darkRows.size >= 2 && darkColumns.size >= 3) {
        matched += 1;
      }
    }

    if (tested < 4) return false;
    return matched / tested >= 0.42 || (matched >= 8 && matched / tested >= 0.32);
  }

  /** @param {Document} doc */
  function hideDuplicateConvertedPageBackdrops(doc) {
    doc.querySelectorAll('.pf').forEach((page) => {
      if (!(page instanceof HTMLElement)) return;
      const pageRect = page.getBoundingClientRect();
      if (!pageRect.width || !pageRect.height) return;

      const textCount = Array.from(page.querySelectorAll('.t')).filter((node) => {
        return node instanceof Element && normalizeLineText(convertedVisibleText(node)).length > 1;
      }).length;
      if (textCount < 2) return;

      page.querySelectorAll('img.bi').forEach((element) => {
        if (!(element instanceof HTMLElement)) return;
        if (element instanceof HTMLImageElement && !element.complete) {
          element.addEventListener('load', () => hideDuplicateConvertedPageBackdrops(doc), { once: true });
          return;
        }
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const coversPage = rect.width / pageRect.width > 0.82 && rect.height / pageRect.height > 0.82;
        if (!coversPage) return;
        const paperColor = convertedImagePaperColor(element);
        if (!paperColor) return;
        if (!convertedImageHasAlignedText(page, element)) return;
        element.classList.add('docuflex-page-raster-backdrop');
        element.setAttribute('aria-hidden', 'true');
      });
    });
  }

  /** @param {HTMLElement} node */
  function convertedHtmlRect(node) {
    const page = node.closest('.pf');
    if (!(page instanceof HTMLElement)) return [];
    const pageRect = page.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return [];
    return [
      (rect.left - pageRect.left) / pageRect.width,
      1 - ((rect.bottom - pageRect.top) / pageRect.height),
      (rect.right - pageRect.left) / pageRect.width,
      1 - ((rect.top - pageRect.top) / pageRect.height)
    ].map(round);
  }

  /** @param {HTMLElement} node */
  function convertedHtmlPageSize(node) {
    const page = node.closest('.pf');
    if (!(page instanceof HTMLElement)) return [];
    const rect = page.getBoundingClientRect();
    return [round(rect.width), round(rect.height)];
  }

  /** @param {HTMLElement} node @param {string} oldText */
  function convertedHtmlOccurrence(node, oldText) {
    const page = node.closest('[data-page-no]') || node.ownerDocument;
    let occurrence = 0;
    for (const item of page.querySelectorAll('.t[data-docuflex-edit-id]')) {
      if (!(item instanceof HTMLElement)) continue;
      const itemText = normalizeLineText(item.dataset.docuflexOriginalText || '');
      if (item === node) return occurrence;
      if (itemText === oldText) occurrence += 1;
    }
    return occurrence;
  }

  /** @param {HTMLElement} node */
  function convertedHtmlFontSize(node) {
    return Number.parseFloat(htmlFrame?.contentWindow?.getComputedStyle(node)?.fontSize ?? '0') || 0;
  }

  /** @param {HTMLElement} node */
  function convertedHtmlFontName(node) {
    return frameFontName(dominantConvertedFontClass(node));
  }

  /** @param {HTMLElement} node */
  function dominantConvertedFontClass(node) {
    const counts = new Map();
    /** @param {string} className @param {string} text */
    const add = (className, text) => {
      if (!className) return;
      const length = normalizeLineText(text ?? '').length;
      if (!length) return;
      counts.set(className, (counts.get(className) ?? 0) + length);
    };
    const styledChildren = Array.from(node.querySelectorAll('[class*="ff"]')).filter((child) => {
      return child instanceof HTMLElement && !child.classList.contains('_');
    });
    if (!styledChildren.length) {
      add(Array.from(node.classList).find((item) => /^ff[0-9a-f]+$/i.test(item)) ?? '', convertedVisibleText(node));
    }
    styledChildren.forEach((child) => {
      if (!(child instanceof HTMLElement) || child.classList.contains('_')) return;
      add(Array.from(child.classList).find((item) => /^ff[0-9a-f]+$/i.test(item)) ?? '', convertedVisibleText(child));
    });
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? '';
  }

  /** @param {string} fontClass */
  function frameFontName(fontClass) {
    const cleanClass = fontClass.toLowerCase();
    return cleanClass ? htmlFontNames[cleanClass] ?? cleanClass : '';
  }

  /** @param {HTMLElement} node */
  function convertedHtmlColor(node) {
    const color = htmlFrame?.contentWindow?.getComputedStyle(node)?.color ?? '';
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) return [];
    return match[1]
      .split(',')
      .slice(0, 3)
      .map((part) => Number.parseFloat(part.trim()) / 255)
      .filter(Number.isFinite);
  }

  /** @param {string} value */
  function stripPdf2HtmlSpacing(value) {
    return value
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/([A-Za-zÄÖÜäöüß])\s+(?=[A-Za-zÄÖÜäöüß])/g, '$1');
  }

  function prepareEditLayers() {
    const pageShells = viewer?.querySelectorAll('.page-shell') ?? [];
    pageShells.forEach((shell, pageIndex) => {
      if (!(shell instanceof HTMLElement)) return;
      const spans = shell.querySelectorAll('.textLayer span');
      spans.forEach((span, spanIndex) => {
        if (!(span instanceof HTMLElement)) return;
        const original = normalizeLineText(span.dataset.originalText ?? span.textContent ?? '');
        span.dataset.page = String(pageIndex);
        span.dataset.editId = `${pageIndex}-span-${spanIndex}`;
        span.dataset.originalText = original;
        span.dataset.oldTextCandidates = JSON.stringify(textCandidatesForSpan(span, original));
        rememberOriginalBounds(span);
        span.contentEditable = editMode ? 'true' : 'false';
        span.spellcheck = false;
        span.classList.toggle('is-staged-edit', edits.some((edit) => edit.id === span.dataset.editId));
      });
    });
  }

  /** @param {HTMLElement} span */
  function rememberOriginalBounds(span) {
    if (span.dataset.maskWidth) return;
    const shell = span.closest('.page-shell');
    if (!(shell instanceof HTMLElement)) return;

    const spanRect = span.getBoundingClientRect();
    const pageRect = shell.getBoundingClientRect();
    const left = spanRect.left - pageRect.left;
    const top = spanRect.top - pageRect.top;
    const width = Math.max(1, spanRect.width);
    const height = Math.max(1, spanRect.height);

    span.dataset.maskLeft = String(round(left));
    span.dataset.maskTop = String(round(top));
    span.dataset.maskWidth = String(round(width));
    span.dataset.maskHeight = String(round(height));
    span.style.minWidth = `${round(width)}px`;
    span.style.minHeight = `${round(height)}px`;
  }

  function scheduleMaskSync() {
    if (maskFrame) cancelAnimationFrame(maskFrame);
    maskFrame = requestAnimationFrame(() => {
      maskFrame = 0;
      syncEditMasks();
    });
  }

  function syncEditMasks() {
    const pageShells = viewer?.querySelectorAll('.page-shell') ?? [];
    pageShells.forEach((shell) => {
      if (!(shell instanceof HTMLElement)) return;
      const underlay = shell.querySelector('.edit-underlay');
      if (!(underlay instanceof HTMLDivElement)) return;
      underlay.replaceChildren();
    });
  }

  /**
   * @param {HTMLElement} textLayer
   * @param {{ items: any[]; styles: Record<string, any> }} textContent
   */
  function applyTextItemStyling(textLayer, textContent) {
    const spans = Array.from(textLayer.querySelectorAll('span')).filter((span) => {
      return span instanceof HTMLElement && (span.textContent ?? '').length > 0;
    });
    const items = textContent.items.filter((item) => 'str' in item && item.str.length > 0);
    const fontWeights = inferFontWeights(items, textContent.styles);

    spans.forEach((span, index) => {
      if (!(span instanceof HTMLElement)) return;
      const item = items[index];
      if (!item || !('str' in item)) return;
      const weight = fontWeights.get(item.fontName);
      const embeddedFamily = embeddedFontFamilies[item.fontName];
      if (embeddedFamily) {
        span.style.fontFamily = `'${embeddedFamily}', Inter, ui-sans-serif, system-ui, sans-serif`;
        span.style.fontWeight = '400';
      } else if (weight) {
        span.style.fontWeight = weight;
      }
      span.dataset.fontName = item.fontName;
      span.dataset.pdfWidth = String(item.width ?? '');
      span.dataset.pdfHeight = String(item.height ?? '');
      span.dataset.pdfTargetWidth = String(Number(item.width ?? 0) * scale);
    });
  }

  /** @param {HTMLElement} textLayer */
  function fitTextLayerSpacing(textLayer) {
    const canvas = globalThis.document?.createElement('canvas');
    const context = canvas?.getContext('2d');
    if (!context) return;

    const spans = textLayer.querySelectorAll('span[data-pdf-target-width]');
    spans.forEach((span) => {
      if (!(span instanceof HTMLElement)) return;
      fitSpanToPdfWidth(span, context);
    });
  }

  /** @param {HTMLElement} span */
  function fitSingleSpanSpacing(span) {
    const canvas = globalThis.document?.createElement('canvas');
    const context = canvas?.getContext('2d');
    if (!context) return;
    fitSpanToPdfWidth(span, context);
  }

  /**
   * @param {HTMLElement} span
   * @param {CanvasRenderingContext2D} context
   */
  function fitSpanToPdfWidth(span, context) {
    const text = span.textContent ?? '';
    const targetWidth = Number(span.dataset.pdfTargetWidth ?? '0');
    if (!text || !Number.isFinite(targetWidth) || targetWidth <= 0) return;

    const computed = getComputedStyle(span);
    context.font = computed.font;
    const naturalWidth = context.measureText(text).width;
    if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) return;

    const slots = Math.max(0, Array.from(text).length - 1);
    const fontSize = Number.parseFloat(computed.fontSize) || 12;
    const widthDelta = targetWidth - naturalWidth;
    const existingScale = Number.parseFloat(span.style.getPropertyValue('--scale-x')) || 1;

    span.dataset.pdfNaturalWidth = String(round(naturalWidth));
    span.dataset.pdfOriginalScaleX = String(round(existingScale));

    if (slots > 0) {
      const letterSpacing = widthDelta / slots;
      const maxPositive = fontSize * 0.45;
      const maxNegative = -fontSize * 0.18;
      if (letterSpacing >= maxNegative && letterSpacing <= maxPositive) {
        span.style.setProperty('--scale-x', '1');
        span.style.letterSpacing = `${round(letterSpacing)}px`;
        span.dataset.pdfLetterSpacing = String(round(letterSpacing));
        return;
      }
    }

    span.style.letterSpacing = '0px';
    span.style.setProperty('--scale-x', String(round(targetWidth / naturalWidth)));
    span.dataset.pdfLetterSpacing = '0';
  }

  /**
   * @param {any[]} items
   * @param {Record<string, any>} styles
   */
  function inferFontWeights(items, styles) {
    const byFont = new Map();
    items.forEach((item) => {
      const bucket = byFont.get(item.fontName) ?? { count: 0, tall: 0, widthPerChar: 0, ascent: styles[item.fontName]?.ascent ?? 0.8 };
      const length = Math.max(1, item.str.trim().length);
      bucket.count += 1;
      bucket.tall += Math.abs(item.transform?.[3] ?? item.height ?? 0);
      bucket.widthPerChar += (item.width ?? 0) / length;
      byFont.set(item.fontName, bucket);
    });

    const weights = new Map();
    byFont.forEach((bucket, fontName) => {
      const averageHeight = bucket.tall / Math.max(1, bucket.count);
      const averageWidth = bucket.widthPerChar / Math.max(1, bucket.count);
      const isLikelyBold = bucket.ascent < 0.8 || averageHeight >= 13 || averageWidth >= 6.8;
      weights.set(fontName, isLikelyBold ? '700' : '400');
    });
    return weights;
  }

  /** @param {HTMLElement} span @param {string} originalText */
  function textCandidatesForSpan(span, originalText) {
    const candidates = [originalText, span.textContent ?? ''];
    return [...new Set(candidates.map(normalizeLineText).filter((value) => value.length > 1))];
  }

  /** @param {string} value */
  function normalizeLineText(value) {
    return value.replace(/\s+/g, ' ').trim();
  }

  /** @param {MouseEvent} event */
  function handleViewerClick(event) {
    if (!editMode) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest('.textLayer')) return;
    const span = target.closest('span');
    if (!(span instanceof HTMLElement)) return;

    span.focus();
  }

  /** @param {FocusEvent} event */
  function handleViewerFocusOut(event) {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('.textLayer span')) {
      commitTextSpanEdit(target);
      scheduleMaskSync();
    }
  }

  /** @param {Event} event */
  function handleViewerInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('.textLayer span')) return;
    fitSingleSpanSpacing(target);
    target.classList.toggle(
      'is-live-edit',
      normalizeLineText(target.textContent ?? '') !== (target.dataset.originalText ?? '')
    );
    scheduleMaskSync();
  }

  /** @param {KeyboardEvent} event */
  function handleViewerKeyDown(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('.textLayer span')) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      target.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      target.textContent = target.dataset.originalText ?? '';
      removeEdit(target.dataset.editId ?? '');
      scheduleMaskSync();
      target.blur();
    }
  }

  function commitFocusedEdit() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches('.textLayer span')) {
      commitTextSpanEdit(active);
    }
  }

  /** @param {HTMLElement} span */
  function commitTextSpanEdit(span) {
    const id = span.dataset.editId ?? '';
    const page = Number(span.dataset.page ?? '-1');
    const oldText = span.dataset.originalText ?? '';
    const oldTextCandidates = parseTextCandidates(span.dataset.oldTextCandidates ?? '[]');
    const newText = normalizeLineText(span.textContent ?? '');
    span.textContent = newText;
    fitSingleSpanSpacing(span);

    if (!id || page < 0 || !oldText || newText === oldText) {
      removeEdit(id);
      span.classList.remove('is-staged-edit', 'is-live-edit');
      status = editMode ? `${edits.length} edit${edits.length === 1 ? '' : 's'} staged.` : status;
      return;
    }

    const nextEdit = {
      id,
      page,
      rect: getPdfRect(span),
      oldText,
      oldTextCandidates,
      newText
    };
    edits = [...edits.filter((edit) => edit.id !== id), nextEdit];
    span.classList.add('is-staged-edit');
    span.classList.remove('is-live-edit');
    status = `${edits.length} edit${edits.length === 1 ? '' : 's'} staged.`;
  }

  /** @param {HTMLElement} element */
  function getPdfRect(element) {
    const shell = element.closest('.page-shell');
    if (!(shell instanceof HTMLElement)) return [];

    const spanRect = element.getBoundingClientRect();
    const pageRect = shell.getBoundingClientRect();
    const pageNumber = Number(element.dataset.page ?? '0') + 1;
    const page = pages.find((item) => item.pageNumber === pageNumber);
    const pageHeight = page?.height ?? pageRect.height;

    const left = (spanRect.left - pageRect.left) / scale;
    const top = (spanRect.top - pageRect.top) / scale;
    const right = (spanRect.right - pageRect.left) / scale;
    const bottom = (spanRect.bottom - pageRect.top) / scale;

    return [
      round(left),
      round((pageHeight / scale) - bottom),
      round(right),
      round((pageHeight / scale) - top)
    ];
  }

  /** @param {string} id */
  function removeEdit(id) {
    edits = edits.filter((edit) => edit.id !== id);
    viewer?.querySelector(`[data-edit-id="${CSS.escape(id)}"]`)?.classList.remove('is-staged-edit');
  }

  /** @param {string} value */
  function parseTextCandidates(value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  /** @param {number} value */
  function round(value) {
    return Math.round(value * 100) / 100;
  }

  /** @param {ArrayBuffer} buffer */
  function arrayBufferToBase64(buffer) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.readAsDataURL(new Blob([buffer]));
    });
  }

  /** @param {string} base64 */
  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /** @param {string} base64 */
  function base64ToUtf8(base64) {
    return new TextDecoder().decode(base64ToArrayBuffer(base64));
  }

  /** @param {string} html */
  function makeConvertedHtmlEditable(html) {
    const stamped = stampConvertedHtmlForEditing(html);
    html = stamped.html;
    convertedHtmlOriginalTexts = stamped.originals;
    const setupScript = `<scr` + `ipt>
  const docuflexNormalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const docuflexTextNode = (target) => {
    if (!(target instanceof Element)) return null;
    const direct = target.closest('.t');
    if (direct) return direct;
    const marked = target.closest('[data-docuflex-edit-id]');
    if (marked) return marked.matches('.t') ? marked : marked.querySelector('.t');
    const clip = target.closest('.c');
    return clip ? clip.querySelector('.t') : null;
  };
  const docuflexPage = (node) => {
    const page = node.closest('[data-page-no]');
    return Math.max(0, Number(page?.dataset?.pageNo || '1') - 1);
  };
  const docuflexRect = (node) => {
    const page = node.closest('.pf');
    if (!page) return [];
    const pageRect = page.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return [];
    return [
      (rect.left - pageRect.left) / pageRect.width,
      1 - ((rect.bottom - pageRect.top) / pageRect.height),
      (rect.right - pageRect.left) / pageRect.width,
      1 - ((rect.top - pageRect.top) / pageRect.height)
    ];
  };
  const docuflexElementRect = (element) => {
    const page = element?.closest?.('.pf');
    if (!(element instanceof HTMLElement) || !(page instanceof HTMLElement)) return [];
    const pageRect = page.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height || !rect.width || !rect.height) return [];
    return [
      (rect.left - pageRect.left) / pageRect.width,
      1 - ((rect.bottom - pageRect.top) / pageRect.height),
      (rect.right - pageRect.left) / pageRect.width,
      1 - ((rect.top - pageRect.top) / pageRect.height)
    ];
  };
  const docuflexMovedTextBoxRect = (box, node) => {
    if (!(box instanceof HTMLElement) || !(node instanceof HTMLElement)) return [];
    const page = node.closest('.pf');
    if (!(page instanceof HTMLElement)) return [];
    const pageRect = page.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return [];
    const originalRect = docuflexRect(node);
    if (originalRect.length < 4) return [];

    const left = Number.parseFloat(box.style.left || '0') || 0;
    const top = Number.parseFloat(box.style.top || '0') || 0;
    const originalLeft = Number.parseFloat(box.dataset.docuflexOriginalLeft || String(left)) || 0;
    const originalTop = Number.parseFloat(box.dataset.docuflexOriginalTop || String(top)) || 0;
    const dx = (left - originalLeft) / pageRect.width;
    const dy = (top - originalTop) / pageRect.height;
    return [
      originalRect[0] + dx,
      originalRect[1] - dy,
      originalRect[2] + dx,
      originalRect[3] - dy
    ];
  };
  const docuflexDominantFontClass = (node) => {
    const counts = new Map();
    const add = (className, text) => {
      if (!className) return;
      const length = docuflexNormalizeText(text || '').length;
      if (!length) return;
      counts.set(className, (counts.get(className) || 0) + length);
    };
    const styledChildren = Array.from(node.querySelectorAll('[class*="ff"]')).filter((child) => {
      return !child.classList.contains('_');
    });
    if (!styledChildren.length) {
      add(Array.from(node.classList).find((item) => /^ff[0-9a-f]+$/i.test(item)) || '', node.textContent || '');
    }
    styledChildren.forEach((child) => {
      if (child.classList.contains('_')) return;
      add(Array.from(child.classList).find((item) => /^ff[0-9a-f]+$/i.test(item)) || '', child.textContent || '');
    });
    return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || '';
  };
  const docuflexExplicitWeight = (node) => {
    const own = node.style?.fontWeight || node.dataset?.docuflexWeight || '';
    const ownNumber = Number.parseFloat(own);
    if (Number.isFinite(ownNumber)) return ownNumber;
    const weightedChild = node.querySelector('[data-docuflex-weight], [style*="font-weight"]');
    const childWeight = weightedChild?.style?.fontWeight || weightedChild?.dataset?.docuflexWeight || '';
    const childNumber = Number.parseFloat(childWeight);
    return Number.isFinite(childNumber) ? childNumber : NaN;
  };
  const docuflexFontInfo = (node) => {
    const style = getComputedStyle(node);
    const colorMatch = String(style.color || '').match(/rgba?\\(([^)]+)\\)/);
    const color = colorMatch
      ? colorMatch[1].split(',').slice(0, 3).map((part) => Number.parseFloat(part.trim()) / 255)
      : [0, 0, 0];
    const explicitWeight = docuflexExplicitWeight(node);
    const computedWeight = Number.parseFloat(style.fontWeight || '400');
    const familyLooksBold = /bold|black|heavy|semibold|demibold|medium/i.test(style.fontFamily);
    return {
      id: node.dataset.docuflexEditId || '',
      fontClass: docuflexDominantFontClass(node),
      fontFamily: style.fontFamily || '',
      fontSize: style.fontSize || '',
      fontWeight: style.fontWeight || '',
      fontStyle: style.fontStyle || '',
      letterSpacing: style.letterSpacing || '',
      lineHeight: style.lineHeight || '',
      textAlign: style.textAlign || 'left',
      underline: /underline/i.test(style.textDecorationLine || style.textDecoration || ''),
      strikethrough: /line-through/i.test(style.textDecorationLine || style.textDecoration || ''),
      color,
      bold: Number.isFinite(explicitWeight) ? explicitWeight >= 600 : computedWeight >= 600 || familyLooksBold,
      italic: /italic|oblique/i.test(style.fontFamily) || /italic|oblique/i.test(style.fontStyle)
    };
  };
  const docuflexSelectTextBox = (box) => {
    if (!(box instanceof HTMLElement)) return;
    document.querySelectorAll('.docuflex-textbox.docuflex-active').forEach((candidate) => {
      if (candidate !== box) candidate.classList.remove('docuflex-active', 'docuflex-editor-open');
    });
    box.classList.add('docuflex-active');
    const line = docuflexTextBoxLines(box)[0];
    if (line) {
      const row = box.querySelector('.docuflex-textbox-rich-line');
      const font = docuflexFontInfo(row instanceof HTMLElement ? row : line);
      font.id = line.dataset.docuflexEditId || '';
      font.textBoxId = box.dataset.docuflexTextBoxId || '';
      font.boxSelection = true;
      parent.postMessage({
        source: 'docuflex-html-editor',
        type: 'activate',
        font
      }, '*');
    }
  };
  const docuflexActivate = (target) => {
    const targetBox = docuflexTextBoxNode(target);
    if (targetBox && !target?.closest?.('.docuflex-textbox-hit-area, .docuflex-selection-handle, .docuflex-selection-edge')) {
      return docuflexOpenTextBoxEditor(targetBox, 'preserve');
    }
    const node = docuflexTextNode(target);
    if (!node) return null;
    if (node.dataset.docuflexGrouped === 'true') {
      const box = docuflexTextBoxForLine(node);
      if (box) return docuflexOpenTextBoxEditor(box, 'preserve');
    }
    const promotedBox = docuflexPromoteLineToTextBox(node);
    if (promotedBox) {
      docuflexSelectTextBox(promotedBox);
      return null;
    }
    docuflexPrepareForEditing(node);
    node.contentEditable = 'true';
    node.spellcheck = false;
    node.setAttribute('role', 'textbox');
    node.tabIndex = 0;
    parent.postMessage({
      source: 'docuflex-html-editor',
      type: 'activate',
      font: docuflexFontInfo(node)
    }, '*');
    return node;
  };
  const docuflexVisibleText = (node) => {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('._').forEach((spacer) => spacer.remove());
    return docuflexNormalizeText(clone.textContent || '');
  };
  const docuflexPrepareForEditing = (node) => {
    if (!node || node.dataset.docuflexPrepared === 'true') return;
    node.querySelectorAll('._').forEach((spacer) => {
      spacer.contentEditable = 'false';
      spacer.setAttribute('aria-hidden', 'true');
    });
    const fontSize = Number.parseFloat(getComputedStyle(node).fontSize || '0') || 0;
    node.classList.toggle('docuflex-large-heading-edit', fontSize >= 150);
    node.dataset.docuflexPrepared = 'true';
  };
  const docuflexParseJson = (value, fallback) => {
    try {
      const parsed = JSON.parse(value || '');
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  };
  const docuflexTextBoxNode = (target) => {
    if (!(target instanceof Element)) return null;
    return target.closest('.docuflex-textbox');
  };
  const docuflexTextBoxLines = (box) => {
    const ids = docuflexParseJson(box.dataset.docuflexLineIds, []);
    return ids.map((id) => {
      const line = document.querySelector('[data-docuflex-edit-id="' + CSS.escape(String(id)) + '"]');
      return line instanceof HTMLElement ? line : null;
    }).filter(Boolean);
  };
  const docuflexTextBoxForLine = (line) => {
    const id = line?.dataset?.docuflexEditId || '';
    if (!id) return null;
    return Array.from(document.querySelectorAll('.docuflex-textbox')).find((box) => {
      return docuflexParseJson(box.dataset.docuflexLineIds, []).includes(id);
    }) || null;
  };
  const docuflexTextBoxEditorText = (box) => {
    const editor = box?.querySelector?.('.docuflex-textbox-editor');
    if (!(editor instanceof HTMLElement)) return '';
    const richLines = Array.from(editor.querySelectorAll('.docuflex-textbox-rich-line'));
    const text = richLines.length
      ? richLines.map((line) => line.textContent || '').join(' ')
      : editor.innerText || editor.textContent || '';
    return String(text).replace(/\u00a0/g, ' ');
  };
  const docuflexSetTextBoxLinesHidden = (box, hidden) => {
    docuflexTextBoxLines(box).forEach((line) => {
      line.classList.toggle('docuflex-group-hidden', hidden);
    });
  };
  const docuflexTextBoxVisualEditing = (box) => {
    return box?.classList?.contains('docuflex-live-edit') || box?.dataset?.docuflexVisualEditing === 'true';
  };
  const docuflexTextBoxLineLayout = (box) => docuflexParseJson(box?.dataset?.docuflexLineLayout, []);
  const docuflexTextBoxOriginalLines = (box) => {
    return docuflexParseJson(box.dataset.docuflexOriginalLines, []);
  };
  const docuflexTextBoxDirty = (box) => {
    const original = docuflexTextBoxOriginalLines(box).map((line) => docuflexNormalizeText(line.text || '')).join(' ');
    const current = docuflexNormalizeText(docuflexTextBoxEditorText(box));
    return Boolean(current) && current !== original;
  };
  const docuflexTextBoxMoved = (box) => {
    if (!(box instanceof HTMLElement)) return false;
    const left = Number.parseFloat(box.style.left || '0') || 0;
    const top = Number.parseFloat(box.style.top || '0') || 0;
    const originalLeft = Number.parseFloat(box.dataset.docuflexOriginalLeft || String(left)) || 0;
    const originalTop = Number.parseFloat(box.dataset.docuflexOriginalTop || String(top)) || 0;
    return Math.abs(left - originalLeft) > 0.5 || Math.abs(top - originalTop) > 0.5 || box.dataset.docuflexMoved === 'true';
  };
  const docuflexSafeTextClass = (className) => /^(ff|fc|sc)[0-9a-z_]+$/i.test(className);
  const docuflexApplyTextClasses = (source, target) => {
    Array.from(source?.classList || []).filter(docuflexSafeTextClass).forEach((className) => {
      target.classList.add(className);
    });
  };
  const docuflexTransformScale = (node) => {
    const transform = getComputedStyle(node).transform || '';
    const matrix = transform.match(/^matrix\\(([^)]+)\\)$/);
    if (!matrix) return { x: 1, y: 1 };
    const values = matrix[1].split(',').map((value) => Number.parseFloat(value.trim()));
    if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return { x: 1, y: 1 };
    return {
      x: Math.hypot(values[0], values[1]) || 1,
      y: Math.hypot(values[2], values[3]) || 1
    };
  };
  const docuflexScaledCssLength = (value, scale) => {
    const text = String(value || '');
    const number = Number.parseFloat(text);
    if (!Number.isFinite(number)) return text || 'normal';
    const unit = text.match(/[a-z%]+$/i)?.[0] || 'px';
    return (number * scale) + unit;
  };
  const docuflexCleanRichClone = (node) => {
    node.querySelectorAll('._').forEach((spacer) => spacer.remove());
    node.querySelectorAll('[contenteditable], [tabindex], [role]').forEach((item) => {
      item.removeAttribute('contenteditable');
      item.removeAttribute('tabindex');
      item.removeAttribute('role');
    });
    node.querySelectorAll('*').forEach((item) => {
      Array.from(item.classList || []).forEach((className) => {
        if (/^(t|m|x|y|h|fs|ls|ws)[0-9a-z_]+$/i.test(className)) item.classList.remove(className);
      });
    });
    return node;
  };
  const docuflexPopulateTextBoxEditor = (box, lines) => {
    const editor = box?.querySelector?.('.docuflex-textbox-editor');
    if (!(editor instanceof HTMLElement)) return;
    editor.replaceChildren();
    const layout = docuflexTextBoxLineLayout(box);
    let previousTop = 0;
    let previousAdvance = 0;
    lines.forEach((line, index) => {
      if (!(line instanceof HTMLElement)) return;
      const row = document.createElement('div');
      row.className = 'docuflex-textbox-rich-line';
      docuflexApplyTextClasses(line, row);
      const style = getComputedStyle(line);
      const rect = line.getBoundingClientRect();
      const scale = docuflexTransformScale(line);
      const sourceFontSize = Number.parseFloat(style.fontSize || '0') || 0;
      const visualFontSize = sourceFontSize > 1 ? sourceFontSize * scale.y : rect.height * 0.96;
      const current = layout[index] || {};
      const top = Number.isFinite(current.top) ? current.top : 0;
      const visualLineHeight = Math.max(1, current.height || rect.height) + 'px';
      const rowAdvance = Math.max(1, current.height || rect.height);
      const marginTop = index === 0 ? 0 : Math.max(0, top - previousTop - previousAdvance);
      previousTop = top;
      previousAdvance = rowAdvance;
      row.dataset.docuflexMarginTop = String(marginTop);
      row.style.fontFamily = style.fontFamily;
      row.style.fontWeight = style.fontWeight;
      row.style.fontStyle = style.fontStyle;
      row.style.color = style.color;
      row.style.letterSpacing = docuflexScaledCssLength(style.letterSpacing, scale.x);
      row.style.wordSpacing = docuflexScaledCssLength(style.wordSpacing, scale.x);
      row.style.fontSize = Math.max(1, visualFontSize) + 'px';
      row.style.marginLeft = Math.max(0, Number.isFinite(current.left) ? current.left : 0) + 'px';
      if (Number.isFinite(current.width) && current.width > 0) row.style.width = current.width + 'px';
      row.style.marginTop = marginTop + 'px';
      row.style.minHeight = visualLineHeight;
      row.style.height = visualLineHeight;
      row.style.lineHeight = visualLineHeight;
      const clone = docuflexCleanRichClone(line.cloneNode(true));
      row.innerHTML = clone.innerHTML || docuflexVisibleText(line);
      if (/^\\s*[•\\-*]\\s+/.test(row.textContent || '')) row.dataset.docuflexBullet = 'true';
      editor.append(row);
    });
  };
  const docuflexTextBoxStyleFromLine = (box, line, lineGap) => {
    const editor = box.querySelector('.docuflex-textbox-editor');
    if (!(editor instanceof HTMLElement) || !(line instanceof HTMLElement)) return;
    const style = getComputedStyle(line);
    const rect = line.getBoundingClientRect();
    const scale = docuflexTransformScale(line);
    const sourceFontSize = Number.parseFloat(style.fontSize || '0') || 0;
    const visualFontSize = sourceFontSize > 1 ? sourceFontSize * scale.y : rect.height * 0.96;
    editor.style.fontFamily = style.fontFamily;
    editor.style.fontSize = Math.max(1, visualFontSize) + 'px';
    editor.style.fontWeight = style.fontWeight;
    editor.style.fontStyle = style.fontStyle;
    editor.style.color = style.color;
    editor.style.letterSpacing = docuflexScaledCssLength(style.letterSpacing, scale.x);
    editor.style.wordSpacing = docuflexScaledCssLength(style.wordSpacing, scale.x);
    editor.style.lineHeight = Math.max(rect.height, lineGap || rect.height * 1.2) + 'px';
  };
  const docuflexOpenTextBoxEditor = (box, focusTarget) => {
    const editor = box?.querySelector?.('.docuflex-textbox-editor');
    if (!(box instanceof HTMLElement) || !(editor instanceof HTMLElement)) return null;
    const lines = docuflexTextBoxLines(box);
    if (!lines.length) return null;
    if (!box.classList.contains('docuflex-editor-open') && !box.classList.contains('docuflex-textbox-preview')) {
      docuflexPopulateTextBoxEditor(box, lines);
    }
    box.classList.add('docuflex-active', 'docuflex-editor-open');
    docuflexSetTextBoxLinesHidden(box, box.classList.contains('docuflex-textbox-preview') || docuflexTextBoxVisualEditing(box));
    docuflexAlignTextBoxEditor(box);
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.focus({ preventScroll: true });
    if (focusTarget === 'end') {
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    const styleSource = editor.querySelector('.docuflex-textbox-rich-line');
    const font = docuflexFontInfo(styleSource instanceof HTMLElement ? styleSource : lines[0]);
    font.id = lines[0].dataset.docuflexEditId || '';
    font.textBoxId = box.dataset.docuflexTextBoxId || '';
    font.boxSelection = false;
    parent.postMessage({
      source: 'docuflex-html-editor',
      type: 'activate',
      font
    }, '*');
    return editor;
  };
  const docuflexCloseTextBoxEditor = (box) => {
    if (!(box instanceof HTMLElement)) return;
    box.classList.remove('docuflex-active');
    const rows = Array.from(box.querySelectorAll('.docuflex-textbox-rich-line'));
    if (!docuflexTextBoxDirty(box) && !docuflexFormattedTextBoxRows(rows)) {
      box.classList.remove('docuflex-editor-open', 'docuflex-live-edit');
      delete box.dataset.docuflexVisualEditing;
      docuflexSetTextBoxLinesHidden(box, box.classList.contains('docuflex-textbox-preview'));
    }
  };
  const docuflexApplyTextBoxLiveRows = (box) => {
    box.querySelectorAll('.docuflex-textbox-rich-line').forEach((row) => {
      if (!(row instanceof HTMLElement)) return;
      row.style.height = 'auto';
      row.style.width = 'auto';
      row.style.overflow = 'visible';
    });
  };
  const docuflexResetTextBoxInternalOffsets = (box) => {
    const editor = box?.querySelector?.('.docuflex-textbox-editor');
    if (editor instanceof HTMLElement) editor.style.transform = '';
    box?.querySelectorAll?.('.docuflex-textbox-rich-line').forEach((row) => {
      if (row instanceof HTMLElement) row.style.transform = '';
    });
  };
  const docuflexBeginTextBoxVisualEditing = (box, alignToOriginal = true) => {
    if (!(box instanceof HTMLElement)) return;
    const wasVisualEditing = docuflexTextBoxVisualEditing(box);
    box.dataset.docuflexVisualEditing = 'true';
    box.classList.add('docuflex-live-edit');
    docuflexApplyTextBoxLiveRows(box);
    docuflexClampTextBoxToPage(box);
    docuflexGrowTextBoxToEditor(box);
    if (docuflexTextBoxMoved(box)) {
      docuflexResetTextBoxInternalOffsets(box);
    } else if (alignToOriginal && !wasVisualEditing) {
      docuflexAlignTextBoxEditor(box, true);
    }
    docuflexSetTextBoxLinesHidden(box, true);
  };
  const docuflexClampTextBoxToPage = (box) => {
    if (!(box instanceof HTMLElement)) return;
    const page = box.closest('.pf');
    if (!(page instanceof HTMLElement)) return;
    const pageWidth = page.getBoundingClientRect().width;
    if (!pageWidth) return;
    const rightLimit = pageWidth * 0.97;
    const width = Number.parseFloat(box.style.width || '0') || box.getBoundingClientRect().width || 24;
    const left = Number.parseFloat(box.style.left || '0') || 0;
    const clampedLeft = Math.max(0, Math.min(left, Math.max(0, rightLimit - Math.min(width, rightLimit))));
    if (Math.abs(clampedLeft - left) > 0.05) box.style.left = clampedLeft + 'px';
    const maxWidth = Math.max(24, rightLimit - clampedLeft);
    if (width > maxWidth) box.style.width = maxWidth + 'px';
  };
  const docuflexGrowTextBoxToEditor = (box) => {
    const editor = box?.querySelector?.('.docuflex-textbox-editor');
    if (!(box instanceof HTMLElement) || !(editor instanceof HTMLElement)) return;
    const currentHeight = Number.parseFloat(box.style.minHeight || '0') || box.getBoundingClientRect().height || 0;
    const neededHeight = Math.ceil(editor.scrollHeight);
    if (neededHeight > currentHeight) box.style.minHeight = neededHeight + 'px';
  };
  const docuflexFitTextBoxToOriginalRows = (box) => {
    const editor = box?.querySelector?.('.docuflex-textbox-editor');
    if (!(box instanceof HTMLElement) || !(editor instanceof HTMLElement)) return;
    const rows = Array.from(editor.querySelectorAll('.docuflex-textbox-rich-line'));
    if (!rows.length) return;
    const editorStyle = getComputedStyle(editor);
    const horizontalPadding = (Number.parseFloat(editorStyle.paddingLeft || '0') || 0)
      + (Number.parseFloat(editorStyle.paddingRight || '0') || 0);
    let widestRow = 0;
    rows.forEach((row) => {
      if (!(row instanceof HTMLElement)) return;
      const previousWhiteSpace = row.style.whiteSpace;
      const previousWidth = row.style.width;
      const previousMaxWidth = row.style.maxWidth;
      row.style.whiteSpace = 'nowrap';
      row.style.width = 'max-content';
      row.style.maxWidth = 'none';
      const marginLeft = Number.parseFloat(getComputedStyle(row).marginLeft || '0') || 0;
      widestRow = Math.max(widestRow, marginLeft + row.scrollWidth);
      row.style.whiteSpace = previousWhiteSpace;
      row.style.width = previousWidth;
      row.style.maxWidth = previousMaxWidth;
    });
    const currentWidth = Number.parseFloat(box.style.width || '0') || box.offsetWidth || 24;
    const fontSize = Number.parseFloat(editorStyle.fontSize || '0') || 16;
    const neededWidth = Math.ceil(widestRow + horizontalPadding + Math.max(8, fontSize * 0.2));
    if (neededWidth <= currentWidth) return;
    const page = box.closest('.pf');
    if (!(page instanceof HTMLElement)) return;
    const pageWidth = page.getBoundingClientRect().width || 0;
    const rightLimit = pageWidth > 0 ? pageWidth * 0.97 : 0;
    const left = Number.parseFloat(box.style.left || '0') || 0;
    const maxWidth = rightLimit > 0 ? Math.max(24, rightLimit - left) : neededWidth;
    box.style.width = Math.min(neededWidth, maxWidth) + 'px';
  };
  const docuflexAlignTextBoxEditor = (box, force = false) => {
    const editor = box?.querySelector?.('.docuflex-textbox-editor');
    if (!(box instanceof HTMLElement) || !(editor instanceof HTMLElement)) return;
    const rows = Array.from(editor.querySelectorAll('.docuflex-textbox-rich-line'));
    if (docuflexTextBoxMoved(box)) {
      docuflexResetTextBoxInternalOffsets(box);
      return;
    }
    if (!force && docuflexTextBoxVisualEditing(box)) return;
    editor.style.transform = '';
    const lines = docuflexTextBoxLines(box);
    rows.forEach((row, index) => {
      if (!(row instanceof HTMLElement)) return;
      row.style.transform = '';
      const line = lines[index];
      if (!(line instanceof HTMLElement)) return;
      const rowRect = row.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      if (!rowRect.height || !lineRect.height) return;
      const deltaY = lineRect.top - rowRect.top;
      if (Math.abs(deltaY) > 0.05) row.style.transform = 'translateY(' + deltaY + 'px)';
    });
  };
  const docuflexMeasureTextBoxLine = (box, text) => {
    const editor = box.querySelector('.docuflex-textbox-editor');
    if (!(editor instanceof HTMLElement)) return text.length * 8;
    const canvas = docuflexMeasureTextBoxLine.canvas || (docuflexMeasureTextBoxLine.canvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    const style = getComputedStyle(editor);
    if (!context) return text.length * 8;
    context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].filter(Boolean).join(' ');
    const letterSpacing = Number.parseFloat(style.letterSpacing || '0') || 0;
    const wordSpacing = Number.parseFloat(style.wordSpacing || '0') || 0;
    const slots = Math.max(0, Array.from(text).length - 1);
    const spaces = (text.match(/ /g) || []).length;
    return context.measureText(text).width + letterSpacing * slots + wordSpacing * spaces;
  };
  const docuflexWrappedTextBoxLines = (box) => {
    const original = docuflexTextBoxOriginalLines(box);
    const editor = box.querySelector('.docuflex-textbox-editor');
    if (!(editor instanceof HTMLElement)) return [];
    const style = getComputedStyle(editor);
    const horizontalPadding = (Number.parseFloat(style.paddingLeft || '0') || 0) + (Number.parseFloat(style.paddingRight || '0') || 0);
    const width = Math.max(20, editor.getBoundingClientRect().width - horizontalPadding);
    const words = docuflexNormalizeText(docuflexTextBoxEditorText(box)).split(' ').filter(Boolean);
    const lines = [];
    let current = '';
    words.forEach((word) => {
      const candidate = current ? current + ' ' + word : word;
      if (current && docuflexMeasureTextBoxLine(box, candidate) > width) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    if (current) lines.push(current);
    while (lines.length < original.length) lines.push('');
    return lines;
  };
  const docuflexNormalizeAlignment = (value) => {
    const text = String(value || '').toLowerCase();
    if (text.includes('center')) return 'center';
    if (text.includes('right') || text.includes('end')) return 'right';
    if (text.includes('left') || text.includes('start')) return 'left';
    return '';
  };
  const docuflexTextBoxRowAlignment = (row) => {
    if (!(row instanceof HTMLElement)) return '';
    const explicit = docuflexNormalizeAlignment(row.dataset.docuflexAlign || row.style.textAlign || '');
    if (explicit) return explicit;
    const parent = row.closest('.docuflex-textbox-editor');
    const inherited = parent instanceof HTMLElement
      ? docuflexNormalizeAlignment(parent.dataset.docuflexAlign || parent.style.textAlign || '')
      : '';
    if (inherited) return inherited;
    const computed = docuflexNormalizeAlignment(getComputedStyle(row).textAlign);
    return computed === 'center' || computed === 'right' ? computed : '';
  };
  const docuflexFormattedTextBoxRows = (rows) => rows.some((row) => {
    if (!(row instanceof HTMLElement)) return false;
    const explicitlyAligned = Boolean(row.dataset.docuflexAlign || row.style.textAlign);
    return row.dataset.docuflexStyleDirty === 'true'
      || explicitlyAligned
      || Boolean(docuflexTextBoxRowAlignment(row))
      || row.dataset.docuflexBullet === 'true'
      || row.dataset.docuflexBullet === 'false';
  });
  const docuflexTextBoxRowTexts = (rows, original) => {
    const values = rows.map((row) => row instanceof HTMLElement ? docuflexNormalizeText(row.textContent || '') : '');
    while (values.length < original.length) values.push('');
    return values;
  };
  const docuflexTextBoxAlignRect = (box, node) => {
    if (!(box instanceof HTMLElement) || !(node instanceof HTMLElement)) return [];
    const page = node.closest('.pf');
    if (!(page instanceof HTMLElement)) return [];
    const pageRect = page.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height || !boxRect.width || !boxRect.height) return [];
    return [
      (boxRect.left - pageRect.left) / pageRect.width,
      0,
      (boxRect.right - pageRect.left) / pageRect.width,
      0
    ];
  };
  const docuflexVisualTextRect = (row, node) => {
    if (!(row instanceof HTMLElement) || !(node instanceof HTMLElement)) return [];
    const page = node.closest('.pf');
    if (!(page instanceof HTMLElement)) return [];
    const pageRect = page.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return [];
    const range = document.createRange();
    range.selectNodeContents(row);
    const rangeRect = range.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rect = rangeRect.width > 0 && rangeRect.height > 0 ? rangeRect : rowRect;
    if (!rect.width || !rect.height) return [];
    return [
      (rect.left - pageRect.left) / pageRect.width,
      0,
      (rect.right - pageRect.left) / pageRect.width,
      0
    ];
  };
  const docuflexTextBoxLineEdit = (box, line, newText, index, moved, row, formattingDirty = false) => {
    const node = document.querySelector('[data-docuflex-edit-id="' + CSS.escape(String(line.id || '')) + '"]');
    if (!(node instanceof HTMLElement)) return null;
    const oldText = docuflexNormalizeText(line.text || '');
    const replacement = docuflexNormalizeText(newText || '');
    const alignment = docuflexTextBoxRowAlignment(row);
    // A resized or moved textbox still needs the overlay path once its
    // typography changes. The movement-only backend deliberately preserves
    // original styling, which previously caused every later panel change to
    // appear to stop working after using the blue-box controls.
    const overlay = formattingDirty || (!moved && (alignment === 'center' || alignment === 'right'));
    if (!oldText || (!moved && !overlay && oldText === replacement)) return null;
    const movedRect = moved ? docuflexMovedTextBoxRect(box, node) : [];
    const baseRect = movedRect.length
      ? movedRect
      : docuflexRect(node);
    const exportRect = baseRect;
    const alignRect = overlay ? docuflexTextBoxAlignRect(box, node) : [];
    const visualRect = overlay ? docuflexVisualTextRect(row, node) : [];
    const originalRect = docuflexRect(node);
    const exportFontNode = (moved || overlay || formattingDirty) && row instanceof HTMLElement ? row : node;
    const exportFont = docuflexFontInfo(exportFontNode);
    const originalFont = docuflexFontInfo(node);
    const normalizedFamily = (value) => String(value || '').replace(/["']/g, '').replace(/\s+/g, '').toLowerCase();
    return {
      id: 'textbox-' + (box.dataset.docuflexTextBoxId || 'box') + '-' + index,
      page: docuflexPage(node),
      occurrence: docuflexOccurrence(node, oldText),
      rect: exportRect,
      alignRect,
      visualRect,
      originalRect,
      pageSize: (() => {
        const page = node.closest('.pf');
        if (!(page instanceof HTMLElement)) return [];
        return [page.offsetWidth || page.clientWidth, page.offsetHeight || page.clientHeight];
      })(),
      fontSize: Number.parseFloat(getComputedStyle(exportFontNode).fontSize || '0') || 0,
      fontClass: docuflexFontInfo(node).fontClass,
      fontName: formattingDirty ? exportFont.fontFamily : '',
      fontFamily: exportFont.fontFamily,
      bold: exportFont.bold,
      fontChanged: formattingDirty && normalizedFamily(exportFont.fontFamily) !== normalizedFamily(originalFont.fontFamily),
      boldChanged: formattingDirty && exportFont.bold !== originalFont.bold,
      italic: Boolean(exportFont.italic),
      italicChanged: formattingDirty && Boolean(exportFont.italic) !== Boolean(originalFont.italic),
      underline: Boolean(exportFont.underline),
      strikethrough: Boolean(exportFont.strikethrough),
      letterSpacing: Number.parseFloat(exportFont.letterSpacing || '0') || 0,
      color: exportFont.color,
      oldText,
      originalHtmlText: line.htmlText || oldText,
      currentHtmlText: replacement,
      newText: replacement,
      overlay,
      alignment,
      moved
    };
  };
  const docuflexCollectTextBoxEdits = () => Array.from(document.querySelectorAll('.docuflex-textbox')).flatMap((box) => {
    const moved = docuflexTextBoxMoved(box);
    const original = docuflexTextBoxOriginalLines(box);
    const dirty = docuflexTextBoxDirty(box);
    const rows = Array.from(box.querySelectorAll('.docuflex-textbox-rich-line'));
    const savedStyles = docuflexParseJson(box.dataset.docuflexStyleSnapshot, []);
    rows.forEach((row, index) => {
      if (!(row instanceof HTMLElement)) return;
      const saved = savedStyles[index];
      if (!saved || typeof saved !== 'object') return;
      Object.entries(saved).forEach(([property, value]) => {
        if (typeof value === 'string') row.style.setProperty(property, value);
      });
      row.dataset.docuflexStyleDirty = 'true';
    });
    // Plain typing also puts the box into visual-edit mode, so only the
    // dedicated formatting markers may select the overlay export path.
    const formattingDirty = savedStyles.length > 0
      || rows.some((row) => row instanceof HTMLElement && row.dataset.docuflexStyleDirty === 'true')
      || box.dataset.docuflexFormattingDirty === 'true';
    const formattedRows = docuflexFormattedTextBoxRows(rows);
    if (!moved && !dirty && !formattingDirty && !box.classList.contains('docuflex-editor-open') && !formattedRows) return [];
    const wrapped = dirty || formattedRows
      ? (formattedRows ? docuflexTextBoxRowTexts(rows, original) : docuflexWrappedTextBoxLines(box))
      : original.map((line) => docuflexNormalizeText(line.text || ''));
    const edits = [];
    original.forEach((line, index) => {
      let replacement = wrapped[index] || '';
      if (index === original.length - 1 && wrapped.length > original.length) {
        replacement = [replacement, ...wrapped.slice(original.length)].filter(Boolean).join(' ');
      }
      const row = rows[index] instanceof HTMLElement ? rows[index] : null;
      const edit = docuflexTextBoxLineEdit(box, line, replacement, index, moved, row, formattingDirty);
      if (edit) edits.push(edit);
    });
    return edits;
  });
  const docuflexLineInfo = (node) => {
    const page = node.closest('.pf');
    if (!(page instanceof HTMLElement)) return null;
    const pageRect = page.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const contentRect = range.getBoundingClientRect();
    const text = docuflexVisibleText(node);
    const visualWidth = Math.max(rect.width || 0, contentRect.width || 0);
    const visualHeight = Math.max(rect.height || 0, contentRect.height || 0);
    if (!pageRect.width || !pageRect.height || !visualWidth || !visualHeight || !text.length) return null;
    const style = getComputedStyle(node);
    const bounds = [rect, contentRect].filter((candidate) => candidate.width > 0 && candidate.height > 0);
    const left = Math.min(...bounds.map((candidate) => candidate.left)) - pageRect.left;
    const top = Math.min(...bounds.map((candidate) => candidate.top)) - pageRect.top;
    const right = Math.max(...bounds.map((candidate) => candidate.right)) - pageRect.left;
    const bottom = Math.max(...bounds.map((candidate) => candidate.bottom)) - pageRect.top;
    return {
      node,
      page,
      text,
      htmlText: node.dataset.docuflexOriginalHtmlText || node.textContent || text,
      id: node.dataset.docuflexEditId || '',
      left,
      top,
      right,
      bottom,
      width: visualWidth,
      height: visualHeight,
      fontSize: visualHeight,
      className: docuflexDominantFontClass(node),
      family: style.fontFamily || '',
      weight: style.fontWeight || '',
      color: style.color || ''
    };
  };
  const docuflexSameTextFlow = (previous, next) => {
    if (!previous || !next || previous.page !== next.page) return false;
    const sameClass = previous.className === next.className || previous.family === next.family;
    const sizeRatio = Math.abs(previous.height - next.height) / Math.max(previous.height, next.height, 1);
    const sameColumn = Math.abs(next.left - previous.left) <= Math.max(22, Math.max(previous.height, next.height) * 1.4);
    const sameVisualStyle = sameClass
      && previous.color === next.color
      && String(previous.weight || '') === String(next.weight || '');
    if (sizeRatio > (sameColumn && sameVisualStyle ? 0.46 : 0.32)) return false;
    const gap = next.top - previous.top;
    const verticalWhitespace = next.top - previous.bottom;
    const expected = Math.max(previous.height, next.height);
    const pageHeight = previous.page.getBoundingClientRect().height || 0;
    const headerBoundary = pageHeight > 0
      && previous.top < pageHeight * 0.16
      && next.top > pageHeight * 0.22
      && verticalWhitespace > expected * 1.35;
    if (headerBoundary) return false;
    if (verticalWhitespace > expected * 1.7 && !sameColumn) return false;
    if (gap < expected * 0.35 || gap > expected * (sameColumn && sameVisualStyle ? 2.75 : 2.15)) return false;
    const leftDelta = Math.abs(next.left - previous.left);
    const indentDelta = next.left - previous.left;
    if (leftDelta > Math.max(36, expected * 1.7) && !(indentDelta > 0 && indentDelta < expected * 2.6)) return false;
    const overlap = Math.min(previous.right, next.right) - Math.max(previous.left, next.left);
    const overlapRatio = overlap / Math.min(previous.width, next.width);
    const stronglyAlignedParagraph = sameColumn
      && sameVisualStyle
      && previous.width > expected * 7
      && next.width > expected * 5
      && verticalWhitespace <= expected * 1.35;
    const wrappedTableLine = sameColumn
      && sameVisualStyle
      && Math.min(previous.text.length, next.text.length) >= 12
      && Math.max(previous.width, next.width) > expected * 8;
    if (overlapRatio < (wrappedTableLine || stronglyAlignedParagraph ? 0.02 : 0.14)) return false;
    if (!sameClass && leftDelta > Math.max(8, expected * 0.5) && !stronglyAlignedParagraph) return false;
    if (/^\\s*[\\d#]+\\s*$/.test(previous.text) || /^\\s*[\\d#]+\\s*$/.test(next.text)) return false;
    return true;
  };
  const docuflexSingleLineBoxCandidate = (line) => {
    if (!line || !line.node || line.node.dataset.docuflexGrouped === 'true') return false;
    const text = docuflexNormalizeText(line.text || '');
    if (text.length < 2) return false;
    if (/^\\s*[\\d#]+\\s*$/.test(text)) return false;
    if (line.width < Math.max(18, line.height * 1.8)) return false;
    return true;
  };
  const docuflexLooseTextFlow = (previous, next) => {
    if (!previous || !next || previous.page !== next.page) return false;
    const expected = Math.max(previous.height, next.height, 1);
    const sizeRatio = Math.abs(previous.height - next.height) / expected;
    if (sizeRatio > 0.42) return false;
    const gap = next.top - previous.top;
    if (gap < expected * 0.45 || gap > expected * 2.05) return false;
    const verticalWhitespace = next.top - previous.bottom;
    if (verticalWhitespace > expected * 1.35) return false;
    const leftDelta = Math.abs(next.left - previous.left);
    if (leftDelta > Math.max(34, expected * 1.45)) return false;
    const previousLooksHeading = previous.width < expected * 7 && previous.text.length < 32;
    const nextLooksHeading = next.width < expected * 7 && next.text.length < 32;
    if (previousLooksHeading || nextLooksHeading) return false;
    return true;
  };
  const docuflexPromoteLineToTextBox = (node) => {
    if (!(node instanceof HTMLElement) || node.dataset.docuflexGrouped === 'true') return null;
    const page = node.closest('.pf');
    if (!(page instanceof HTMLElement)) return null;
    const lines = Array.from(page.querySelectorAll('.t[data-docuflex-edit-id]'))
      .filter((item) => item instanceof HTMLElement && item.dataset.docuflexGrouped !== 'true')
      .map((item) => item instanceof HTMLElement ? docuflexLineInfo(item) : null)
      .filter(Boolean)
      .sort((left, right) => left.top - right.top || left.left - right.left);
    const index = lines.findIndex((line) => line.node === node);
    if (index < 0) {
      const pageRect = page.getBoundingClientRect();
      const fallbackElement = node.closest('.c') instanceof HTMLElement ? node.closest('.c') : node;
      const fallbackRect = fallbackElement.getBoundingClientRect();
      const text = docuflexVisibleText(node);
      if (!pageRect.width || !pageRect.height || !fallbackRect.width || !fallbackRect.height || !text) return null;
      const style = getComputedStyle(node);
      return docuflexCreateTextBox([{
        node,
        page,
        text,
        htmlText: node.dataset.docuflexOriginalHtmlText || node.textContent || text,
        id: node.dataset.docuflexEditId || '',
        left: fallbackRect.left - pageRect.left,
        top: fallbackRect.top - pageRect.top,
        right: fallbackRect.right - pageRect.left,
        bottom: fallbackRect.bottom - pageRect.top,
        width: fallbackRect.width,
        height: fallbackRect.height,
        fontSize: fallbackRect.height,
        className: docuflexDominantFontClass(node),
        family: style.fontFamily || '',
        weight: style.fontWeight || '',
        color: style.color || ''
      }], document.querySelectorAll('.docuflex-textbox').length);
    }
    const boxIndex = document.querySelectorAll('.docuflex-textbox').length;
    return docuflexCreateTextBox([lines[index]], boxIndex);
  };
  const docuflexBuildFlowGroups = (lines) => {
    const unused = new Set(lines);
    const groups = [];
    const sorted = [...lines].sort((left, right) => left.top - right.top || left.left - right.left);
    const candidateScore = (previous, next) => {
      const gap = next.top - previous.top;
      const leftDelta = Math.abs(next.left - previous.left);
      const overlap = Math.min(previous.right, next.right) - Math.max(previous.left, next.left);
      const overlapRatio = overlap / Math.max(1, Math.min(previous.width, next.width));
      return gap * 5 + leftDelta * 2 - overlapRatio * 20;
    };
    sorted.forEach((start) => {
      if (!unused.has(start)) return;
      unused.delete(start);
      const group = [start];
      let current = start;
      while (true) {
        const next = [...unused]
          .filter((line) => line.top > current.top && docuflexSameTextFlow(current, line))
          .sort((left, right) => candidateScore(current, left) - candidateScore(current, right))[0];
        if (!next) break;
        unused.delete(next);
        group.push(next);
        current = next;
      }
      if (group.length >= 2 && group.reduce((sum, item) => sum + item.text.length, 0) >= 24) {
        groups.push(...docuflexSplitFlowGroup(group));
      }
    });
    return groups;
  };
  const docuflexSplitFlowGroup = (group) => {
    const chunks = [];
    let current = [];
    let currentChars = 0;
    const flush = () => {
      if (current.length >= 2 && currentChars >= 24) chunks.push(current);
      current = [];
      currentChars = 0;
    };
    group.forEach((line, index) => {
      const previous = current[current.length - 1];
      const expected = previous ? Math.max(previous.height, line.height, 1) : 1;
      const gap = previous ? line.top - previous.top : 0;
      const startsListLike = /^\\s*(?:[-•*]|\\d+[.)]|[a-z][.)])\\s+/i.test(line.text || '');
      const continuationLine = previous
        && !startsListLike
        && Math.abs(line.left - previous.left) <= Math.max(24, expected * 1.25)
        && gap <= expected * 1.55;
      const bigGap = previous && gap > expected * 1.75;
      const tooManyLines = current.length >= 7;
      const tooManyChars = currentChars + line.text.length > 900;
      if (current.length >= 2 && (startsListLike || bigGap || ((!continuationLine) && (tooManyLines || tooManyChars)))) {
        flush();
      }
      current.push(line);
      currentChars += line.text.length;
      if (index === group.length - 1) flush();
    });
    return chunks;
  };
  const docuflexCreateTextBox = (lines, index) => {
    const page = lines[0]?.page;
    if (!(page instanceof HTMLElement) || lines.length < 1) return null;
    const pageHeight = page.getBoundingClientRect().height || 0;
    if (pageHeight > 0) {
      const first = lines[0];
      const last = lines[lines.length - 1];
      const headerToBody = first.top < pageHeight * 0.16 && last.top > pageHeight * 0.22;
      if (headerToBody) return null;
    }
    const left = Math.min(...lines.map((line) => line.left));
    const top = Math.min(...lines.map((line) => line.top));
    const right = Math.max(...lines.map((line) => line.right));
    const bottom = Math.max(...lines.map((line) => line.bottom));
    const lineGap = lines.length > 1
      ? (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1)
      : lines[0].height * 1.2;
    const box = document.createElement('div');
    box.className = 'docuflex-textbox';
    box.dataset.docuflexTextBoxId = 'box-' + index;
    box.dataset.docuflexLineIds = JSON.stringify(lines.map((line) => line.id));
    box.dataset.docuflexLineGap = Math.max(lines[0].height, lineGap || lines[0].height * 1.2) + 'px';
    box.dataset.docuflexLineLayout = JSON.stringify(lines.map((line) => ({
      top: line.top - top,
      left: line.left - left,
      width: line.width,
      height: line.height
    })));
    box.dataset.docuflexOriginalLines = JSON.stringify(lines.map((line) => ({
      id: line.id,
      text: line.text,
      htmlText: line.htmlText
    })));
    const boxPad = Math.max(4, lines[0].height * 0.18);
    const padTop = boxPad * 0.7;
    const padRight = boxPad;
    const padBottom = boxPad * 0.7;
    const padLeft = boxPad;
    // Keep the editable flow at the same width as the original PDF lines.
    // A large multi-line allowance changed wrapping as soon as the user typed.
    const contentSlack = Math.max(boxPad * 1.2, Math.min(28, (right - left) * 0.04));
    const pageWidth = page.getBoundingClientRect().width || 0;
    const rightLimit = pageWidth > 0 ? pageWidth * 0.97 : 0;
    const boxLeft = Math.max(0, left - padLeft);
    const requestedWidth = Math.max(24, right - left + padLeft + padRight + contentSlack);
    const maxWidth = rightLimit > 0 ? Math.max(24, rightLimit - boxLeft) : requestedWidth;
    box.style.left = boxLeft + 'px';
    box.style.top = Math.max(0, top - padTop) + 'px';
    box.style.width = Math.min(requestedWidth, maxWidth) + 'px';
    box.style.minHeight = Math.max(12, bottom - top + padTop + padBottom) + 'px';
    box.dataset.docuflexOriginalLeft = String(boxLeft);
    box.dataset.docuflexOriginalTop = String(Math.max(0, top - padTop));
    const handle = document.createElement('span');
    handle.className = 'docuflex-textbox-hit-area';
    handle.contentEditable = 'false';
    handle.textContent = '';
    const resize = document.createElement('span');
    resize.className = 'docuflex-selection-handle docuflex-selection-handle-se';
    resize.dataset.docuflexResize = 'se';
    resize.contentEditable = 'false';
    resize.textContent = '';
    const selectionControls = document.createElement('span');
    selectionControls.className = 'docuflex-selection-controls';
    selectionControls.contentEditable = 'false';
    ['nw', 'ne', 'sw'].forEach((position) => {
      const control = document.createElement('span');
      control.className = 'docuflex-selection-handle docuflex-selection-handle-' + position;
      control.dataset.docuflexResize = position;
      control.contentEditable = 'false';
      selectionControls.append(control);
    });
    ['n', 'e', 's', 'w'].forEach((position) => {
      const edge = document.createElement('span');
      edge.className = 'docuflex-selection-edge docuflex-selection-edge-' + position;
      edge.dataset.docuflexResize = position;
      edge.contentEditable = 'false';
      selectionControls.append(edge);
    });
    const editor = document.createElement('div');
    editor.className = 'docuflex-textbox-editor';
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.setAttribute('role', 'textbox');
    editor.style.padding = padTop + 'px ' + padRight + 'px ' + padBottom + 'px ' + padLeft + 'px';
    editor.textContent = lines.map((line) => line.text).join(' ');
    box.append(editor, handle, selectionControls, resize);
    page.append(box);
    docuflexTextBoxStyleFromLine(box, lines[0].node, lineGap);
    lines.forEach((line) => {
      line.node.dataset.docuflexGrouped = 'true';
      docuflexPrepareForEditing(line.node);
      line.node.contentEditable = 'true';
      line.node.spellcheck = false;
      line.node.setAttribute('role', 'textbox');
      line.node.classList.add('docuflex-grouped-line');
    });
    docuflexPopulateTextBoxEditor(box, lines.map((line) => line.node));
    docuflexApplyTextBoxLiveRows(box);
    docuflexFitTextBoxToOriginalRows(box);
    box.classList.add('docuflex-textbox-preview');
    docuflexAlignTextBoxEditor(box, true);
    docuflexSetTextBoxLinesHidden(box, true);
    requestAnimationFrame(() => {
      docuflexFitTextBoxToOriginalRows(box);
      docuflexAlignTextBoxEditor(box, true);
    });
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      docuflexSelectTextBox(box);
      drag = {
        x: event.clientX,
        y: event.clientY,
        left: Number.parseFloat(box.style.left || '0') || 0,
        top: Number.parseFloat(box.style.top || '0') || 0,
        scaleX: page.offsetWidth ? page.getBoundingClientRect().width / page.offsetWidth : 1,
        scaleY: page.offsetHeight ? page.getBoundingClientRect().height / page.offsetHeight : 1
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = (event.clientX - drag.x) / (drag.scaleX || 1);
      const dy = (event.clientY - drag.y) / (drag.scaleY || 1);
      box.style.left = Math.max(0, drag.left + dx) + 'px';
      box.style.top = Math.max(0, drag.top + dy) + 'px';
      docuflexClampTextBoxToPage(box);
      box.dataset.docuflexMoved = 'true';
      docuflexBeginTextBoxVisualEditing(box, false);
      parent.postMessage({ source: 'docuflex-html-editor', type: 'geometry' }, '*');
      event.preventDefault();
    });
    handle.addEventListener('pointerup', (event) => {
      drag = null;
      handle.releasePointerCapture(event.pointerId);
      parent.postMessage({ source: 'docuflex-html-editor', type: 'geometry' }, '*');
    });
    handle.addEventListener('click', (event) => {
      docuflexSelectTextBox(box);
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener('dblclick', (event) => {
      drag = null;
      docuflexOpenTextBoxEditor(box, 'preserve');
      event.preventDefault();
      event.stopPropagation();
    });
    Array.from(box.querySelectorAll('.docuflex-selection-handle, .docuflex-selection-edge')).forEach((resizeHandle) => {
      if (!(resizeHandle instanceof HTMLElement)) return;
      let resizeDrag = null;
      resizeHandle.addEventListener('pointerdown', (event) => {
        docuflexSelectTextBox(box);
        resizeDrag = {
          x: event.clientX,
          y: event.clientY,
          left: Number.parseFloat(box.style.left || '0') || 0,
          top: Number.parseFloat(box.style.top || '0') || 0,
          width: Number.parseFloat(box.style.width || '0') || box.offsetWidth || 24,
          height: Number.parseFloat(box.style.minHeight || '0') || box.offsetHeight || 12,
          scaleX: page.offsetWidth ? page.getBoundingClientRect().width / page.offsetWidth : 1,
          scaleY: page.offsetHeight ? page.getBoundingClientRect().height / page.offsetHeight : 1,
          direction: resizeHandle.dataset.docuflexResize || 'se'
        };
        resizeHandle.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      });
      resizeHandle.addEventListener('pointermove', (event) => {
        if (!resizeDrag) return;
        const dx = (event.clientX - resizeDrag.x) / (resizeDrag.scaleX || 1);
        const dy = (event.clientY - resizeDrag.y) / (resizeDrag.scaleY || 1);
        const west = resizeDrag.direction.includes('w');
        const north = resizeDrag.direction.includes('n');
        const horizontal = resizeDrag.direction.includes('e') || west;
        const vertical = resizeDrag.direction.includes('s') || north;
        const nextWidth = horizontal
          ? Math.max(24, resizeDrag.width + (west ? -dx : dx))
          : resizeDrag.width;
        const nextHeight = vertical
          ? Math.max(12, resizeDrag.height + (north ? -dy : dy))
          : resizeDrag.height;
        if (west) box.style.left = Math.max(0, resizeDrag.left + resizeDrag.width - nextWidth) + 'px';
        if (north) box.style.top = Math.max(0, resizeDrag.top + resizeDrag.height - nextHeight) + 'px';
        box.style.width = nextWidth + 'px';
        box.style.minHeight = nextHeight + 'px';
        docuflexClampTextBoxToPage(box);
        box.dataset.docuflexMoved = 'true';
        docuflexBeginTextBoxVisualEditing(box);
        docuflexGrowTextBoxToEditor(box);
        parent.postMessage({ source: 'docuflex-html-editor', type: 'geometry' }, '*');
        event.preventDefault();
      });
      resizeHandle.addEventListener('pointerup', (event) => {
        resizeDrag = null;
        resizeHandle.releasePointerCapture(event.pointerId);
        parent.postMessage({ source: 'docuflex-html-editor', type: 'geometry' }, '*');
      });
    });
    lines.forEach((line) => {
      line.node.addEventListener('focus', () => {
        docuflexOpenTextBoxEditor(box, 'preserve');
      });
      line.node.addEventListener('blur', () => {
        setTimeout(() => {
          if (!box.contains(document.activeElement)) docuflexCloseTextBoxEditor(box);
        }, 0);
      });
      line.node.addEventListener('input', () => {
        docuflexBeginTextBoxVisualEditing(box);
        docuflexScheduleDirty(line.node);
      });
    });
    editor.addEventListener('blur', () => {
      setTimeout(() => {
        if (!box.contains(document.activeElement)) docuflexCloseTextBoxEditor(box);
      }, 0);
    });
    editor.addEventListener('focus', () => {
      docuflexOpenTextBoxEditor(box, 'preserve');
    });
    editor.addEventListener('beforeinput', () => {
      docuflexBeginTextBoxVisualEditing(box);
    });
    editor.addEventListener('input', () => {
      docuflexBeginTextBoxVisualEditing(box);
      docuflexGrowTextBoxToEditor(box);
      docuflexScheduleDirty(lines[0].node);
    });
    return box;
  };
  const docuflexBuildTextBoxes = (targetPage = null) => {
    let boxIndex = document.querySelectorAll('.docuflex-textbox').length;
    const pages = targetPage instanceof HTMLElement ? [targetPage] : Array.from(document.querySelectorAll('.pf'));
    pages.forEach((page) => {
      const lines = Array.from(page.querySelectorAll('.t[data-docuflex-edit-id]'))
        .filter((node) => node instanceof HTMLElement && node.dataset.docuflexGrouped !== 'true')
        .map((node) => node instanceof HTMLElement ? docuflexLineInfo(node) : null)
        .filter(Boolean)
        .sort((left, right) => left.top - right.top || left.left - right.left);
      const groups = docuflexBuildFlowGroups(lines);
      const groupedLines = new Set();
      groups.forEach((group) => {
        const box = docuflexCreateTextBox(group, boxIndex++);
        if (box) group.forEach((line) => groupedLines.add(line));
      });
      lines
        .filter((line) => !groupedLines.has(line))
        .forEach((line) => docuflexCreateTextBox([line], boxIndex++));
    });
  };
  let docuflexTextBoxBuildTimer = 0;
  const docuflexScheduleTextBoxBuild = (targetPage = null, delay = 80) => {
    if (docuflexTextBoxBuildTimer) clearTimeout(docuflexTextBoxBuildTimer);
    docuflexTextBoxBuildTimer = setTimeout(() => {
      docuflexTextBoxBuildTimer = 0;
      docuflexBuildTextBoxes(targetPage);
    }, delay);
  };
  const docuflexRunTextBoxBuildPasses = () => {
    requestAnimationFrame(docuflexBuildTextBoxes);
    [120, 350, 800, 1400, 2400, 4200].forEach((delay) => {
      setTimeout(docuflexBuildTextBoxes, delay);
    });
    document.fonts?.ready?.then?.(() => docuflexBuildTextBoxes()).catch?.(() => {});
  };
  const docuflexImageBoxNode = (target) => {
    if (!(target instanceof Element)) return null;
    return target.closest('.docuflex-image-box');
  };
  const docuflexSelectImageBox = (box) => {
    if (!(box instanceof HTMLElement)) return;
    document.querySelectorAll('.docuflex-textbox.docuflex-active').forEach((candidate) => {
      candidate.classList.remove('docuflex-active', 'docuflex-editor-open');
    });
    document.querySelectorAll('.docuflex-image-box.docuflex-active').forEach((candidate) => {
      if (candidate !== box) candidate.classList.remove('docuflex-active');
    });
    box.classList.add('docuflex-active');
    parent.postMessage({ source: 'docuflex-html-editor', type: 'deactivate' }, '*');
  };
  const docuflexClampImageBoxToPage = (box) => {
    const page = box?.closest?.('.pf');
    if (!(box instanceof HTMLElement) || !(page instanceof HTMLElement)) return;
    const width = Number.parseFloat(box.style.width || '0') || box.offsetWidth || 1;
    const height = Number.parseFloat(box.style.height || '0') || box.offsetHeight || 1;
    const left = Number.parseFloat(box.style.left || '0') || 0;
    const top = Number.parseFloat(box.style.top || '0') || 0;
    const pageWidth = page.offsetWidth || page.clientWidth || width;
    const pageHeight = page.offsetHeight || page.clientHeight || height;
    box.style.left = Math.min(Math.max(0, left), Math.max(0, pageWidth - width)) + 'px';
    box.style.top = Math.min(Math.max(0, top), Math.max(0, pageHeight - height)) + 'px';
  };
  const docuflexApplyImageBoxGeometry = (box) => {
    if (!(box instanceof HTMLElement)) return;
    const imageId = box.dataset.docuflexImageId || '';
    const image = imageId ? document.querySelector('[data-docuflex-image-id="' + CSS.escape(imageId) + '"]') : null;
    if (!(image instanceof HTMLElement)) return;
    const left = Number.parseFloat(box.style.left || '0') || 0;
    const top = Number.parseFloat(box.style.top || '0') || 0;
    const width = Number.parseFloat(box.style.width || '0') || box.offsetWidth || 1;
    const height = Number.parseFloat(box.style.height || '0') || box.offsetHeight || 1;
    const originalLeft = Number.parseFloat(box.dataset.docuflexOriginalLeft || '0') || 0;
    const originalTop = Number.parseFloat(box.dataset.docuflexOriginalTop || '0') || 0;
    const originalWidth = Math.max(1, Number.parseFloat(box.dataset.docuflexOriginalWidth || '1') || 1);
    const originalHeight = Math.max(1, Number.parseFloat(box.dataset.docuflexOriginalHeight || '1') || 1);
    image.style.transformOrigin = 'top left';
    image.style.translate = (left - originalLeft) + 'px ' + (top - originalTop) + 'px';
    image.style.scale = (width / originalWidth) + ' ' + (height / originalHeight);
    box.dataset.docuflexMoved = 'true';
    parent.postMessage({ source: 'docuflex-html-editor', type: 'geometry' }, '*');
    docuflexScheduleDirty(null);
  };
  const docuflexImageBoxRect = (box, original = false) => {
    const page = box?.closest?.('.pf');
    if (!(box instanceof HTMLElement) || !(page instanceof HTMLElement)) return [];
    const pageWidth = page.offsetWidth || page.clientWidth || 0;
    const pageHeight = page.offsetHeight || page.clientHeight || 0;
    if (!pageWidth || !pageHeight) return [];
    const left = Number.parseFloat(original ? box.dataset.docuflexOriginalLeft || '0' : box.style.left || '0') || 0;
    const top = Number.parseFloat(original ? box.dataset.docuflexOriginalTop || '0' : box.style.top || '0') || 0;
    const width = Number.parseFloat(original ? box.dataset.docuflexOriginalWidth || '0' : box.style.width || '0') || 0;
    const height = Number.parseFloat(original ? box.dataset.docuflexOriginalHeight || '0' : box.style.height || '0') || 0;
    return [
      left / pageWidth,
      1 - ((top + height) / pageHeight),
      (left + width) / pageWidth,
      1 - (top / pageHeight)
    ];
  };
  const docuflexCollectImageEdits = () => Array.from(document.querySelectorAll('.docuflex-image-box[data-docuflex-moved="true"]')).flatMap((box) => {
    if (!(box instanceof HTMLElement)) return [];
    const rect = docuflexImageBoxRect(box);
    const originalRect = docuflexImageBoxRect(box, true);
    if (rect.length < 4 || originalRect.length < 4) return [];
    return [{
      kind: 'image',
      id: box.dataset.docuflexImageId || '',
      page: Number.parseInt(box.dataset.docuflexPage || '0', 10) || 0,
      occurrence: Number.parseInt(box.dataset.docuflexOccurrence || '-1', 10),
      group: box.dataset.docuflexImageGroup === 'true',
      rect,
      originalRect
    }];
  });
  const docuflexCreateImageBox = (image, index) => {
    if (!(image instanceof HTMLImageElement) || image.classList.contains('docuflex-page-raster-backdrop')) return null;
    if (image.dataset.docuflexImageId) {
      return document.querySelector('.docuflex-image-box[data-docuflex-image-id="' + CSS.escape(image.dataset.docuflexImageId) + '"]');
    }
    const page = image.closest('.pf');
    if (!(page instanceof HTMLElement)) return null;
    const pageRect = page.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const scaleX = page.offsetWidth ? pageRect.width / page.offsetWidth : 1;
    const scaleY = page.offsetHeight ? pageRect.height / page.offsetHeight : 1;
    if (!pageRect.width || !pageRect.height || imageRect.width < 6 || imageRect.height < 6) return null;
    const left = (imageRect.left - pageRect.left) / (scaleX || 1);
    const top = (imageRect.top - pageRect.top) / (scaleY || 1);
    const width = imageRect.width / (scaleX || 1);
    const height = imageRect.height / (scaleY || 1);
    const imageId = 'image-' + index;
    image.dataset.docuflexImageId = imageId;
    const box = document.createElement('div');
    box.className = 'docuflex-image-box';
    box.dataset.docuflexImageId = imageId;
    box.dataset.docuflexOriginalLeft = String(left);
    box.dataset.docuflexOriginalTop = String(top);
    box.dataset.docuflexOriginalWidth = String(width);
    box.dataset.docuflexOriginalHeight = String(height);
    box.dataset.docuflexPage = String(docuflexPage(image));
    const pageImages = Array.from(page.querySelectorAll('img.bi:not(.docuflex-page-raster-backdrop)'));
    box.dataset.docuflexOccurrence = String(pageImages.indexOf(image));
    // pdf2htmlEX commonly flattens every PDF image on a page into one composite
    // bitmap. Persist that one visible box as a transform of the page's image
    // group rather than incorrectly matching it to just one PDF image object.
    box.dataset.docuflexImageGroup = String(pageImages.length === 1);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = width + 'px';
    box.style.height = height + 'px';

    const hitArea = document.createElement('span');
    hitArea.className = 'docuflex-image-hit-area';
    hitArea.contentEditable = 'false';
    const controls = document.createElement('span');
    controls.className = 'docuflex-selection-controls';
    controls.contentEditable = 'false';
    ['nw', 'ne', 'se', 'sw'].forEach((position) => {
      const handle = document.createElement('span');
      handle.className = 'docuflex-selection-handle docuflex-selection-handle-' + position;
      handle.dataset.docuflexResize = position;
      handle.contentEditable = 'false';
      controls.append(handle);
    });
    ['n', 'e', 's', 'w'].forEach((position) => {
      const edge = document.createElement('span');
      edge.className = 'docuflex-selection-edge docuflex-selection-edge-' + position;
      edge.dataset.docuflexResize = position;
      edge.contentEditable = 'false';
      controls.append(edge);
    });
    box.append(hitArea, controls);
    page.append(box);

    let drag = null;
    hitArea.addEventListener('pointerdown', (event) => {
      docuflexSelectImageBox(box);
      drag = {
        x: event.clientX,
        y: event.clientY,
        left: Number.parseFloat(box.style.left || '0') || 0,
        top: Number.parseFloat(box.style.top || '0') || 0,
        scaleX: page.offsetWidth ? page.getBoundingClientRect().width / page.offsetWidth : 1,
        scaleY: page.offsetHeight ? page.getBoundingClientRect().height / page.offsetHeight : 1
      };
      hitArea.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    hitArea.addEventListener('pointermove', (event) => {
      if (!drag) return;
      box.style.left = drag.left + ((event.clientX - drag.x) / (drag.scaleX || 1)) + 'px';
      box.style.top = drag.top + ((event.clientY - drag.y) / (drag.scaleY || 1)) + 'px';
      docuflexClampImageBoxToPage(box);
      docuflexApplyImageBoxGeometry(box);
      event.preventDefault();
    });
    hitArea.addEventListener('pointerup', (event) => {
      drag = null;
      if (hitArea.hasPointerCapture(event.pointerId)) hitArea.releasePointerCapture(event.pointerId);
      docuflexApplyImageBoxGeometry(box);
    });
    hitArea.addEventListener('click', (event) => {
      docuflexSelectImageBox(box);
      event.preventDefault();
      event.stopPropagation();
    });

    box.querySelectorAll('.docuflex-selection-handle, .docuflex-selection-edge').forEach((resizeHandle) => {
      if (!(resizeHandle instanceof HTMLElement)) return;
      let resizeDrag = null;
      resizeHandle.addEventListener('pointerdown', (event) => {
        docuflexSelectImageBox(box);
        resizeDrag = {
          x: event.clientX,
          y: event.clientY,
          left: Number.parseFloat(box.style.left || '0') || 0,
          top: Number.parseFloat(box.style.top || '0') || 0,
          width: Number.parseFloat(box.style.width || '0') || box.offsetWidth || 12,
          height: Number.parseFloat(box.style.height || '0') || box.offsetHeight || 12,
          scaleX: page.offsetWidth ? page.getBoundingClientRect().width / page.offsetWidth : 1,
          scaleY: page.offsetHeight ? page.getBoundingClientRect().height / page.offsetHeight : 1,
          direction: resizeHandle.dataset.docuflexResize || 'se'
        };
        resizeHandle.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      });
      resizeHandle.addEventListener('pointermove', (event) => {
        if (!resizeDrag) return;
        const dx = (event.clientX - resizeDrag.x) / (resizeDrag.scaleX || 1);
        const dy = (event.clientY - resizeDrag.y) / (resizeDrag.scaleY || 1);
        const west = resizeDrag.direction.includes('w');
        const north = resizeDrag.direction.includes('n');
        const horizontal = resizeDrag.direction.includes('e') || west;
        const vertical = resizeDrag.direction.includes('s') || north;
        const ratio = Math.max(1, Number.parseFloat(box.dataset.docuflexOriginalWidth || String(resizeDrag.width)) || resizeDrag.width)
          / Math.max(1, Number.parseFloat(box.dataset.docuflexOriginalHeight || String(resizeDrag.height)) || resizeDrag.height);
        let nextWidth = horizontal ? Math.max(12, resizeDrag.width + (west ? -dx : dx)) : resizeDrag.width;
        let nextHeight = vertical ? Math.max(12, resizeDrag.height + (north ? -dy : dy)) : resizeDrag.height;
        if (event.shiftKey) {
          if (horizontal && vertical) {
            if (Math.abs(nextWidth / resizeDrag.width - 1) >= Math.abs(nextHeight / resizeDrag.height - 1)) {
              nextHeight = Math.max(12, nextWidth / ratio);
            } else {
              nextWidth = Math.max(12, nextHeight * ratio);
            }
          } else if (horizontal) {
            nextHeight = Math.max(12, nextWidth / ratio);
          } else if (vertical) {
            nextWidth = Math.max(12, nextHeight * ratio);
          }
        }
        const fixedRight = resizeDrag.left + resizeDrag.width;
        const fixedBottom = resizeDrag.top + resizeDrag.height;
        const pageWidth = page.offsetWidth || page.clientWidth || fixedRight;
        const pageHeight = page.offsetHeight || page.clientHeight || fixedBottom;
        const maxWidth = west ? fixedRight : pageWidth - resizeDrag.left;
        const maxHeight = north ? fixedBottom : pageHeight - resizeDrag.top;
        if (event.shiftKey) {
          const constrainedScale = Math.min(
            1,
            maxWidth / Math.max(1, nextWidth),
            maxHeight / Math.max(1, nextHeight)
          );
          nextWidth = Math.max(12, nextWidth * constrainedScale);
          nextHeight = Math.max(12, nextHeight * constrainedScale);
        } else {
          nextWidth = Math.max(12, Math.min(nextWidth, maxWidth));
          nextHeight = Math.max(12, Math.min(nextHeight, maxHeight));
        }
        let nextLeft = west ? fixedRight - nextWidth : resizeDrag.left;
        let nextTop = north ? fixedBottom - nextHeight : resizeDrag.top;
        if (event.shiftKey && horizontal && !vertical) nextTop = resizeDrag.top + (resizeDrag.height - nextHeight) / 2;
        if (event.shiftKey && vertical && !horizontal) nextLeft = resizeDrag.left + (resizeDrag.width - nextWidth) / 2;
        nextLeft = Math.max(0, Math.min(nextLeft, pageWidth - nextWidth));
        nextTop = Math.max(0, Math.min(nextTop, pageHeight - nextHeight));
        box.style.left = nextLeft + 'px';
        box.style.top = nextTop + 'px';
        box.style.width = nextWidth + 'px';
        box.style.height = nextHeight + 'px';
        docuflexApplyImageBoxGeometry(box);
        event.preventDefault();
      });
      resizeHandle.addEventListener('pointerup', (event) => {
        resizeDrag = null;
        if (resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId);
        docuflexApplyImageBoxGeometry(box);
      });
    });
    return box;
  };
  const docuflexBuildImageBoxes = () => {
    document.querySelectorAll('.docuflex-image-box').forEach((box) => {
      if (!(box instanceof HTMLElement)) return;
      const id = box.dataset.docuflexImageId || '';
      const image = id ? document.querySelector('[data-docuflex-image-id="' + CSS.escape(id) + '"]') : null;
      if (!(image instanceof HTMLImageElement) || image.classList.contains('docuflex-page-raster-backdrop')) box.remove();
    });
    let index = document.querySelectorAll('.docuflex-image-box').length;
    document.querySelectorAll('.pf img.bi:not(.docuflex-page-raster-backdrop)').forEach((image) => {
      if (!(image instanceof HTMLImageElement)) return;
      if (!image.complete) {
        image.addEventListener('load', () => docuflexCreateImageBox(image, index++), { once: true });
        return;
      }
      docuflexCreateImageBox(image, index++);
    });
  };
  const docuflexImagePaperColor = (element) => {
    if (!(element instanceof HTMLImageElement) || !element.complete || !element.naturalWidth || !element.naturalHeight) return '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 12;
      canvas.height = 12;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return '';
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let luminance = 0;
      let saturation = 0;
      let paperRed = 0;
      let paperGreen = 0;
      let paperBlue = 0;
      let paperSamples = 0;
      for (let index = 0; index < data.length; index += 4) {
        const red = data[index] / 255;
        const green = data[index + 1] / 255;
        const blue = data[index + 2] / 255;
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const sampleLuminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
        luminance += sampleLuminance;
        saturation += max === 0 ? 0 : (max - min) / max;
        if (sampleLuminance > 0.72) {
          paperRed += data[index];
          paperGreen += data[index + 1];
          paperBlue += data[index + 2];
          paperSamples += 1;
        }
      }
      const samples = data.length / 4;
      if (luminance / samples <= 0.78 || saturation / samples >= 0.16 || paperSamples < 8) return '';
      return 'rgb('
        + Math.round(paperRed / paperSamples) + ', '
        + Math.round(paperGreen / paperSamples) + ', '
        + Math.round(paperBlue / paperSamples) + ')';
    } catch {
      return '';
    }
  };
  const docuflexImageHasAlignedText = (page, element) => {
    if (!(element instanceof HTMLImageElement) || !element.naturalWidth || !element.naturalHeight) return false;
    const imageRect = element.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height) return false;
    const textNodes = Array.from(page.querySelectorAll('.t')).filter((node) => {
      if (docuflexVisibleText(node).length <= 1) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 4 && rect.height > 3;
    }).slice(0, 100);
    if (textNodes.length < 2) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 10;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    let tested = 0;
    let matched = 0;
    for (const node of textNodes) {
      const rect = node.getBoundingClientRect();
      const left = Math.max(rect.left, imageRect.left);
      const top = Math.max(rect.top, imageRect.top);
      const right = Math.min(rect.right, imageRect.right);
      const bottom = Math.min(rect.bottom, imageRect.bottom);
      if (right <= left || bottom <= top) continue;
      const sourceX = ((left - imageRect.left) / imageRect.width) * element.naturalWidth;
      const sourceY = ((top - imageRect.top) / imageRect.height) * element.naturalHeight;
      const sourceWidth = ((right - left) / imageRect.width) * element.naturalWidth;
      const sourceHeight = ((bottom - top) / imageRect.height) * element.naturalHeight;
      if (sourceWidth < 1 || sourceHeight < 1) continue;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(element, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const darkRows = new Set();
      const darkColumns = new Set();
      let darkPixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        const red = data[index] / 255;
        const green = data[index + 1] / 255;
        const blue = data[index + 2] / 255;
        const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
        if (luminance >= 0.55) continue;
        const pixel = index / 4;
        darkRows.add(Math.floor(pixel / canvas.width));
        darkColumns.add(pixel % canvas.width);
        darkPixels += 1;
      }
      tested += 1;
      const darkRatio = darkPixels / (canvas.width * canvas.height);
      if (darkRatio > 0.012 && darkRows.size >= 2 && darkColumns.size >= 3) {
        matched += 1;
      }
    }
    if (tested < 4) return false;
    return matched / tested >= 0.42 || (matched >= 8 && matched / tested >= 0.32);
  };
  const docuflexHideDuplicatePageBackdrops = () => {
    document.querySelectorAll('.pf').forEach((page) => {
      const pageRect = page.getBoundingClientRect();
      if (!pageRect.width || !pageRect.height) return;
      const textCount = Array.from(page.querySelectorAll('.t')).filter((node) => docuflexVisibleText(node).length > 1).length;
      if (textCount < 2) return;
      page.querySelectorAll('img.bi').forEach((element) => {
        if (element instanceof HTMLImageElement && !element.complete) {
          element.addEventListener('load', docuflexHideDuplicatePageBackdrops, { once: true });
          return;
        }
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const coversPage = rect.width / pageRect.width > 0.82 && rect.height / pageRect.height > 0.82;
        if (!coversPage) return;
        const paperColor = docuflexImagePaperColor(element);
        if (!paperColor) return;
        if (!docuflexImageHasAlignedText(page, element)) return;
        element.classList.add('docuflex-page-raster-backdrop');
        element.setAttribute('aria-hidden', 'true');
      });
    });
  };
  const docuflexOccurrence = (node, oldText) => {
    const page = node.closest('[data-page-no]') || document;
    let occurrence = 0;
    for (const item of page.querySelectorAll('.t[data-docuflex-edit-id]')) {
      const itemText = docuflexNormalizeText(item.dataset.docuflexOriginalText || '');
      if (item === node) return occurrence;
      if (itemText === oldText) occurrence += 1;
    }
    return occurrence;
  };
  const docuflexCollectEdits = () => {
    const textBoxEdits = docuflexCollectTextBoxEdits();
    const lineEdits = Array.from(document.querySelectorAll('.t[data-docuflex-edit-id]')).flatMap((node, index) => {
    const groupBox = node.dataset.docuflexGrouped === 'true' ? docuflexTextBoxForLine(node) : null;
    if (groupBox && (
      groupBox.classList.contains('docuflex-editor-open')
      || groupBox.classList.contains('docuflex-live-edit')
      || groupBox.dataset.docuflexFormattingDirty === 'true'
      || groupBox.dataset.docuflexVisualEditing === 'true'
      || docuflexTextBoxDirty(groupBox)
      || docuflexTextBoxMoved(groupBox)
    )) return [];
    const oldText = docuflexNormalizeText(node.dataset.docuflexOriginalText || '');
    const newText = docuflexVisibleText(node) || docuflexNormalizeText(node.innerText || node.textContent || '');
    if (!oldText || oldText === newText) return [];
    return [{
      id: node.dataset.docuflexEditId || ('html-text-' + index),
      page: docuflexPage(node),
      occurrence: docuflexOccurrence(node, oldText),
      rect: docuflexRect(node),
      pageSize: (() => {
        const page = node.closest('.pf');
        if (!(page instanceof HTMLElement)) return [];
        return [page.offsetWidth || page.clientWidth, page.offsetHeight || page.clientHeight];
      })(),
      fontSize: Number.parseFloat(getComputedStyle(node).fontSize || '0') || 0,
      fontClass: docuflexFontInfo(node).fontClass,
      fontFamily: docuflexFontInfo(node).fontFamily,
      bold: docuflexFontInfo(node).bold,
      color: docuflexFontInfo(node).color,
      oldText,
      originalHtmlText: node.dataset.docuflexOriginalHtmlText || '',
      currentHtmlText: docuflexVisibleText(node) || node.textContent || '',
      newText
    }];
    });
    return [...textBoxEdits, ...lineEdits, ...docuflexCollectImageEdits()];
  };
  const docuflexRebaseEdits = () => {
    const rebasedLines = new Map();
    document.querySelectorAll('.docuflex-textbox').forEach((box) => {
      if (!(box instanceof HTMLElement)) return;
      const original = docuflexTextBoxOriginalLines(box);
      const rows = Array.from(box.querySelectorAll('.docuflex-textbox-rich-line'));
      const formattedRows = docuflexFormattedTextBoxRows(rows);
      const dirty = docuflexTextBoxDirty(box);
      const wrapped = dirty || formattedRows
        ? (formattedRows ? docuflexTextBoxRowTexts(rows, original) : docuflexWrappedTextBoxLines(box))
        : original.map((line) => docuflexNormalizeText(line.text || ''));
      const nextOriginal = original.map((line, index) => {
        let replacement = wrapped[index] || '';
        if (index === original.length - 1 && wrapped.length > original.length) {
          replacement = [replacement, ...wrapped.slice(original.length)].filter(Boolean).join(' ');
        }
        const nextLine = { ...line, text: replacement, htmlText: replacement };
        rebasedLines.set(String(line.id || ''), { replacement, row: rows[index] });
        return nextLine;
      });
      box.dataset.docuflexOriginalLines = JSON.stringify(nextOriginal);
      box.dataset.docuflexOriginalLeft = box.style.left || '0';
      box.dataset.docuflexOriginalTop = box.style.top || '0';
      delete box.dataset.docuflexMoved;
      delete box.dataset.docuflexFormattingDirty;
      box.classList.remove('docuflex-live-edit');
    });

    document.querySelectorAll('.t[data-docuflex-edit-id]').forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const id = node.dataset.docuflexEditId || '';
      const rebased = rebasedLines.get(id);
      if (rebased) {
        const row = rebased.row;
        if (row instanceof HTMLElement) {
          const clone = docuflexCleanRichClone(row.cloneNode(true));
          node.innerHTML = clone.innerHTML || rebased.replacement;
        } else {
          node.textContent = rebased.replacement;
        }
      }
      const current = rebased?.replacement || docuflexVisibleText(node) || docuflexNormalizeText(node.textContent || '');
      if (!current) return;
      node.dataset.docuflexOriginalText = current;
      node.dataset.docuflexOriginalHtmlText = node.textContent || current;
      node.classList.remove('docuflex-live-edit');
    });
    docuflexScheduleDirty(null);
  };
  let docuflexDirtyTimer = 0;
  let docuflexBackdropTimer = 0;
  const docuflexScheduleDirty = (fontSource) => {
    const font = fontSource instanceof HTMLElement ? docuflexFontInfo(fontSource) : fontSource;
    if (docuflexDirtyTimer) clearTimeout(docuflexDirtyTimer);
    docuflexDirtyTimer = setTimeout(() => {
      docuflexDirtyTimer = 0;
      parent.postMessage({
        source: 'docuflex-html-editor',
        type: 'dirty',
        dirtyCount: docuflexCollectEdits().length,
        font
      }, '*');
    }, 180);
  };
  const docuflexScheduleBackdropCheck = () => {
    if (docuflexBackdropTimer) return;
    docuflexBackdropTimer = setTimeout(() => {
      docuflexBackdropTimer = 0;
      docuflexHideDuplicatePageBackdrops();
      docuflexBuildImageBoxes();
    }, 300);
  };
  window.__docuflexCollectEdits = docuflexCollectEdits;
  window.__docuflexRebaseEdits = docuflexRebaseEdits;
  window.__docuflexNotifyTextBoxFormatting = (boxId) => {
    const box = Array.from(document.querySelectorAll('.docuflex-textbox')).find((candidate) => {
      return candidate instanceof HTMLElement && candidate.dataset.docuflexTextBoxId === String(boxId || '');
    });
    if (!(box instanceof HTMLElement)) return false;
    const row = box.querySelector('.docuflex-textbox-rich-line');
    const line = docuflexTextBoxLines(box)[0];
    docuflexScheduleDirty(row instanceof HTMLElement ? row : line);
    return true;
  };
  window.__docuflexFormat = (command) => {
    document.execCommand(command, false);
    parent.postMessage({
      source: 'docuflex-html-editor',
      type: 'activate',
      font: docuflexFontInfo(document.activeElement?.closest?.('.t') || document.querySelector('.t'))
    }, '*');
  };
  window.__docuflexSetBold = (bold) => {
    const weight = bold ? '700' : '400';
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const selectionElement = range
      ? (range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement)
      : null;
    const node = docuflexTextNode(selectionElement || document.activeElement) || document.querySelector('.t');
    if (!node) return;
    if (range && node.contains(range.commonAncestorContainer)) {
      if (range.collapsed) {
        document.execCommand('bold', false);
      } else {
        const selected = range.extractContents();
        const wrapper = document.createElement('span');
        wrapper.style.fontWeight = weight;
        wrapper.dataset.docuflexWeight = weight;
        wrapper.append(selected);
        range.insertNode(wrapper);
        selection.removeAllRanges();
        const after = document.createRange();
        after.selectNodeContents(wrapper);
        selection.addRange(after);
      }
    } else {
      node.style.fontWeight = weight;
      node.dataset.docuflexWeight = weight;
      node.querySelectorAll('[data-docuflex-weight]').forEach((child) => {
        child.style.fontWeight = weight;
        child.dataset.docuflexWeight = weight;
      });
      node.classList.toggle('docuflex-bold-edit', Number(weight) >= 600);
    }
    node.classList.add('docuflex-live-edit');
    docuflexScheduleDirty(node);
  };
  addEventListener('DOMContentLoaded', () => {
    document.body.contentEditable = 'false';
    docuflexHideDuplicatePageBackdrops();
    requestAnimationFrame(() => {
      docuflexHideDuplicatePageBackdrops();
      docuflexBuildImageBoxes();
    });
    document.querySelectorAll('.t').forEach((node) => {
      if (!node.dataset.docuflexOriginalText) {
        node.dataset.docuflexOriginalText = docuflexVisibleText(node) || docuflexNormalizeText(node.textContent);
        node.dataset.docuflexOriginalHtmlText = node.textContent || '';
      }
      node.contentEditable = 'true';
      node.spellcheck = false;
      node.setAttribute('role', 'textbox');
      node.tabIndex = 0;
      node.addEventListener('input', () => {
        node.classList.add('docuflex-live-edit');
      });
    });
    docuflexRunTextBoxBuildPasses();
    const textboxObserver = new MutationObserver((mutations) => {
      const pages = new Set();
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const page = node.matches('.pf') ? node : node.closest('.pf');
          if (page instanceof HTMLElement && (node.matches('.t[data-docuflex-edit-id]') || node.querySelector('.t[data-docuflex-edit-id]'))) {
            pages.add(page);
          }
        });
      });
      pages.forEach((page) => requestAnimationFrame(() => docuflexBuildTextBoxes(page)));
    });
    textboxObserver.observe(document.body, { childList: true, subtree: true });
    addEventListener('load', () => {
      docuflexHideDuplicatePageBackdrops();
      docuflexBuildTextBoxes();
      docuflexBuildImageBoxes();
    }, { once: true });
    addEventListener('scroll', () => docuflexScheduleTextBoxBuild(null, 120), { passive: true });
    addEventListener('resize', () => docuflexScheduleTextBoxBuild(null, 160), { passive: true });
    document.addEventListener('pointerdown', (event) => {
      if (!docuflexImageBoxNode(event.target)) {
        document.querySelectorAll('.docuflex-image-box.docuflex-active').forEach((box) => {
          box.classList.remove('docuflex-active');
        });
      }
      if (!docuflexTextBoxNode(event.target)) {
        document.querySelectorAll('.docuflex-textbox.docuflex-active').forEach((box) => {
          box.classList.remove('docuflex-active', 'docuflex-editor-open');
        });
        parent.postMessage({ source: 'docuflex-html-editor', type: 'deactivate' }, '*');
      }
      const node = docuflexActivate(event.target);
      if (node) node.focus({ preventScroll: true });
    }, true);
    document.addEventListener('input', (event) => {
      const node = docuflexActivate(event.target);
      if (!node) return;
      node.classList.add('docuflex-live-edit');
      docuflexScheduleBackdropCheck();
      docuflexScheduleDirty(node);
    }, true);
    addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== 'docuflex-parent' || data.type !== 'collect-edits') return;
      parent.postMessage({
        source: 'docuflex-html-editor',
        type: 'edits-response',
        requestId: data.requestId,
        edits: docuflexCollectEdits()
      }, '*');
    });
  });
</scr` + `ipt>`;
    const injection = `
<style>
  @font-face {
    font-family: 'Inter';
    src: url('/fonts/inter-variable-normal.woff2') format('woff2');
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
  }
  @font-face {
    font-family: 'Inter';
    src: url('/fonts/inter-variable-italic.woff2') format('woff2');
    font-style: italic;
    font-weight: 100 900;
    font-display: swap;
  }
  @font-face {
    font-family: 'Geist';
    src: url('/fonts/geist-variable-normal.woff2') format('woff2');
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
  }
  @font-face {
    font-family: 'Geist';
    src: url('/fonts/geist-variable-italic.woff2') format('woff2');
    font-style: italic;
    font-weight: 100 900;
    font-display: swap;
  }
  html {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: auto;
    background: #f5f5f5;
    scrollbar-width: none;
  }
  html::-webkit-scrollbar { display: none; }
  body {
    box-sizing: border-box;
    width: 100%;
    min-height: 100%;
    height: auto;
    margin: 0;
    padding:
      var(--docuflex-viewer-padding-top, 26.667px)
      var(--docuflex-viewer-padding-right, 35.556px)
      var(--docuflex-viewer-padding-bottom, 59.259px);
    overflow: visible;
    background: #f5f5f5;
  }
  #sidebar, #outline, .loading-indicator {
    display: none !important;
  }
  #page-container {
    position: relative !important;
    top: auto !important;
    right: auto !important;
    bottom: auto !important;
    left: -50px !important;
    width: 100% !important;
    min-width: 100%;
    margin: 0;
    box-sizing: content-box;
    padding: 0 var(--docuflex-horizontal-pan-gutter, 0px);
    display: flex !important;
    flex-direction: column;
    align-items: center;
    align-items: safe center;
    overflow: visible !important;
    background: transparent !important;
    background-image: none !important;
  }
  .pf {
    flex: 0 0 auto;
    margin: 0 0 var(--docuflex-page-margin, 22.222px) !important;
    box-shadow: 0 5px 22px rgba(0, 0, 0, 0.13);
  }
  html.docuflex-pan-tool, html.docuflex-pan-tool * {
    cursor: grab !important;
    user-select: none !important;
  }
  html.docuflex-panning, html.docuflex-panning * { cursor: grabbing !important; }
  html.docuflex-zoom-tool, html.docuflex-zoom-tool * {
    cursor: zoom-in !important;
    user-select: none !important;
  }
  html.docuflex-zoom-tool.docuflex-zoom-out,
  html.docuflex-zoom-tool.docuflex-zoom-out * { cursor: zoom-out !important; }
  .pc { pointer-events: none !important; }
  .bi, .bf, .d, .pi { pointer-events: none !important; z-index: 0 !important; }
  .docuflex-page-raster-backdrop { display: none !important; }
  .c { pointer-events: none !important; z-index: 2 !important; }
  .t {
    z-index: 4 !important;
    pointer-events: auto !important;
    cursor: text;
    outline: 1px solid rgba(22, 132, 248, 0.22);
    outline-offset: 1px;
  }
  .t:hover { outline-color: rgba(22, 132, 248, 0.48); }
  .t:focus, .t.docuflex-live-edit {
    outline: 1.5px solid #1684f8;
    box-shadow: none;
  }
  .t:focus, .t.docuflex-live-edit {
    font-synthesis-weight: auto;
  }
  .t.docuflex-large-heading-edit {
    word-spacing: 0.28em !important;
  }
  .t.docuflex-grouped-line {
    outline: none !important;
    pointer-events: auto !important;
  }
  .t.docuflex-group-hidden,
  .t.docuflex-group-hidden * {
    visibility: hidden !important;
  }
  .docuflex-textbox,
  .docuflex-image-box {
    position: absolute;
    z-index: 6 !important;
    box-sizing: border-box;
    min-width: 24px;
    min-height: 12px;
    pointer-events: none !important;
    outline: 1px solid rgba(22, 132, 248, 0.2);
    outline-offset: 1px;
    background: transparent;
  }
  .docuflex-image-box {
    z-index: 3 !important;
    min-width: 12px;
    min-height: 12px;
  }
  .docuflex-textbox:hover,
  .docuflex-image-box:hover {
    outline-color: rgba(22, 132, 248, 0.48);
  }
  .docuflex-textbox.docuflex-active,
  .docuflex-textbox.docuflex-live-edit,
  .docuflex-image-box.docuflex-active {
    outline: 2px solid #0d99ff;
    outline-offset: 0;
    box-shadow: none;
  }
  .docuflex-textbox-editor {
    position: absolute;
    inset: 0;
    display: none;
    box-sizing: border-box;
    min-height: inherit;
    white-space: pre-wrap;
    overflow-wrap: normal;
    word-break: normal;
    outline: none;
    caret-color: #0d5aa7;
    pointer-events: auto !important;
    z-index: 1;
  }
  .docuflex-textbox-rich-line {
    display: block;
    margin: 0;
    padding: 0;
    min-height: 1em;
    white-space: pre;
    overflow-wrap: normal;
    word-break: normal;
  }
  .docuflex-textbox-rich-line * {
    line-height: inherit;
  }
  .docuflex-textbox.docuflex-editor-open .docuflex-textbox-editor,
  .docuflex-textbox.docuflex-textbox-preview .docuflex-textbox-editor {
    display: block;
  }
  .docuflex-textbox.docuflex-editor-open:not(.docuflex-live-edit):not(.docuflex-textbox-preview) .docuflex-textbox-editor,
  .docuflex-textbox.docuflex-editor-open:not(.docuflex-live-edit):not(.docuflex-textbox-preview) .docuflex-textbox-editor * {
    color: transparent !important;
    -webkit-text-fill-color: transparent !important;
    text-shadow: none !important;
  }
  .docuflex-textbox-hit-area {
    position: absolute;
    z-index: 3;
    inset: 0;
    cursor: move;
    pointer-events: auto !important;
    background: transparent;
  }
  .docuflex-image-hit-area {
    position: absolute;
    z-index: 3;
    inset: 0;
    cursor: move;
    pointer-events: auto !important;
    background: transparent;
  }
  .docuflex-textbox.docuflex-editor-open .docuflex-textbox-hit-area {
    pointer-events: none !important;
  }
  .docuflex-selection-controls {
    position: absolute;
    z-index: 4;
    inset: 0;
    display: none;
    pointer-events: none !important;
  }
  .docuflex-textbox.docuflex-active .docuflex-selection-controls,
  .docuflex-image-box.docuflex-active .docuflex-selection-controls {
    display: block;
  }
  .docuflex-selection-handle {
    position: absolute;
    z-index: 5;
    display: none;
    box-sizing: border-box;
    width: 8px;
    height: 8px;
    border: 2px solid #0d99ff;
    border-radius: 0;
    background: #fff;
    transform: translate(-50%, -50%);
    pointer-events: none !important;
  }
  .docuflex-textbox.docuflex-active > .docuflex-selection-handle,
  .docuflex-textbox.docuflex-active .docuflex-selection-handle,
  .docuflex-image-box.docuflex-active .docuflex-selection-handle {
    display: block;
    pointer-events: auto !important;
  }
  .docuflex-selection-edge {
    position: absolute;
    z-index: 4;
    display: none;
    background: transparent;
    pointer-events: none !important;
  }
  .docuflex-textbox.docuflex-active .docuflex-selection-edge,
  .docuflex-image-box.docuflex-active .docuflex-selection-edge {
    display: block;
    pointer-events: auto !important;
  }
  .docuflex-selection-edge-n,
  .docuflex-selection-edge-s { left: 0; right: 0; height: 14px; cursor: ns-resize; }
  .docuflex-selection-edge-n { top: -7px; }
  .docuflex-selection-edge-s { bottom: -7px; }
  .docuflex-selection-edge-e,
  .docuflex-selection-edge-w { top: 0; bottom: 0; width: 14px; cursor: ew-resize; }
  .docuflex-selection-edge-e { right: -7px; }
  .docuflex-selection-edge-w { left: -7px; }
  .docuflex-selection-handle-nw { left: 0; top: 0; }
  .docuflex-selection-handle-n { left: 50%; top: 0; }
  .docuflex-selection-handle-ne { left: 100%; top: 0; }
  .docuflex-selection-handle-e { left: 100%; top: 50%; }
  .docuflex-selection-handle-se {
    right: 0;
    bottom: 0;
    transform: translate(50%, 50%);
    cursor: nwse-resize;
  }
  .docuflex-selection-handle-s { left: 50%; top: 100%; }
  .docuflex-selection-handle-sw { left: 0; top: 100%; }
  .docuflex-selection-handle-w { left: 0; top: 50%; }
  .docuflex-selection-handle-nw,
  .docuflex-selection-handle-se { cursor: nwse-resize; }
  .docuflex-selection-handle-ne,
  .docuflex-selection-handle-sw { cursor: nesw-resize; }
  .t[contenteditable="true"] { caret-color: #0d5aa7; }
  .t * { cursor: text; }
  .t ._ {
    caret-color: transparent;
    user-select: none;
  }
  .t.docuflex-bold-edit:focus, .t.docuflex-bold-edit.docuflex-live-edit {
    font-weight: 700 !important;
  }
</style>
${setupScript}`;
    return html.includes('</body>')
      ? html.replace('</body>', `${injection}</body>`)
      : `${html}${injection}`;
  }

  /** @param {string} html */
  function stampConvertedHtmlForEditing(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const originals = extractConvertedHtmlOriginalTexts(html);
    sanitizeConvertedDocument(doc);

    doc.querySelectorAll('.t').forEach((node, index) => {
      if (!(node instanceof HTMLElement)) return;
      const id = `html-text-${index}`;
      const original = originals[id] ?? {
        text: normalizeLineText(convertedVisibleText(node)),
        htmlText: convertedVisibleText(node)
      };
      node.dataset.docuflexEditId = id;
      node.dataset.docuflexOriginalText = original.text;
      node.dataset.docuflexOriginalHtmlText = original.htmlText;
    });

    return {
      html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`,
      originals
    };
  }

  /** @param {Document} doc */
  function sanitizeConvertedDocument(doc) {
    doc.querySelectorAll('script, iframe, frame, object, embed, applet, base, form, input, button, textarea, select, meta[http-equiv]').forEach((node) => node.remove());
    doc.querySelectorAll('*').forEach((node) => {
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || ['srcdoc', 'action', 'formaction'].includes(name)) {
          node.removeAttribute(attribute.name);
          continue;
        }
        if (!['href', 'src', 'poster', 'xlink:href'].includes(name)) continue;
        const value = attribute.value.trim();
        if (/^(?:javascript|vbscript|file):/i.test(value) || /^data:(?!image\/|font\/|application\/(?:font|x-font))/i.test(value)) {
          node.removeAttribute(attribute.name);
          continue;
        }
        if (['src', 'poster', 'xlink:href'].includes(name) && value && !/^(?:data:image\/|data:font\/|data:application\/(?:font|x-font)|blob:|#)/i.test(value)) {
          node.removeAttribute(attribute.name);
        }
      }
    });
    const policy = doc.createElement('meta');
    policy.setAttribute('http-equiv', 'Content-Security-Policy');
    policy.setAttribute(
      'content',
      "default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; "
        + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'"
    );
    doc.head.prepend(policy);
  }

  /** @param {string} html */
  function extractConvertedHtmlOriginalTexts(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    /** @type {Record<string, { text: string; htmlText: string }>} */
    const originals = {};

    doc.querySelectorAll('.t').forEach((node, index) => {
      const id = node instanceof HTMLElement && node.dataset.docuflexEditId
        ? node.dataset.docuflexEditId
        : `html-text-${index}`;
      const htmlText = convertedVisibleText(node);
      originals[id] = {
        text: normalizeLineText(htmlText),
        htmlText
      };
    });
    return originals;
  }

  function htmlScroller() {
    return htmlFrame?.contentDocument?.scrollingElement ?? htmlFrame?.contentDocument?.documentElement ?? null;
  }

  function applyHtmlViewportStyles() {
    const doc = htmlFrame?.contentDocument;
    if (!doc || !htmlFrame) return;
    const frameScale = scale * zoomLevel;
    // The viewport and its padding must never change with zoom. Scale only the
    // converted PDF pages so centering is based on one stable scroll viewport.
    htmlFrame.style.zoom = '';
    htmlFrame.style.left = '50%';
    htmlFrame.style.width = '100%';
    htmlFrame.style.height = '100%';
    htmlFrame.style.transform = 'translateX(-50%)';
    htmlFrame.style.transformOrigin = 'top center';
    doc.body.style.zoom = '';
    doc.body.style.width = '100%';
    doc.documentElement.style.setProperty('--docuflex-viewer-padding-top', '36px');
    doc.documentElement.style.setProperty('--docuflex-viewer-padding-right', '48px');
    doc.documentElement.style.setProperty('--docuflex-viewer-padding-bottom', '80px');
    doc.documentElement.style.setProperty('--docuflex-page-margin', `${30 / scale}px`);
    doc.documentElement.style.setProperty('--docuflex-horizontal-pan-gutter', `${horizontalPanGutter}px`);
    doc.querySelectorAll('.pf').forEach((page) => {
      if (page.nodeType === 1) /** @type {HTMLElement} */ (page).style.zoom = String(frameScale);
    });
    scheduleHtmlGeometrySync();
  }

  function scheduleHtmlGeometrySync() {
    if (overlayFrame) cancelAnimationFrame(overlayFrame);
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = 0;
      ensureHtmlScrollExtent();
      syncUnderTextAnnotationLayers();
      syncOverlayPageFrames();
    });
  }

  function syncUnderTextAnnotationLayers() {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    const svgNamespace = 'http://www.w3.org/2000/svg';
    /** @type {Map<number, any[]>} */
    const annotationsByPage = new Map();
    visualAnnotations.forEach((annotation) => {
      if (!['highlight', 'underline', 'crossout', 'blackout', 'whiteout', 'marker'].includes(annotation?.type)) return;
      const page = Number(annotation.page);
      const pageAnnotations = annotationsByPage.get(page) ?? [];
      pageAnnotations.push(annotation);
      annotationsByPage.set(page, pageAnnotations);
    });

    doc.querySelectorAll('.pf').forEach((page, index) => {
      if (page.nodeType !== 1) return;
      const htmlPage = /** @type {HTMLElement} */ (page);
      const pageNumber = Math.max(0, Number(htmlPage.dataset.pageNo || index + 1) - 1);
      const pageAnnotations = annotationsByPage.get(pageNumber) ?? [];
      const pageContent = htmlPage.querySelector('.pc');
      if (!pageContent || pageContent.nodeType !== 1) return;
      const htmlPageContent = /** @type {HTMLElement} */ (pageContent);
      htmlPageContent.querySelector(':scope > .docuflex-text-highlight-layer')?.remove();
      let layer = htmlPageContent.querySelector(':scope > .docuflex-under-text-annotation-layer');
      let redactionLayer = htmlPageContent.querySelector(':scope > .docuflex-over-text-redaction-layer');

      if (pageAnnotations.length === 0) {
        layer?.remove();
        redactionLayer?.remove();
        return;
      }

      if (!layer || layer.nodeType !== 1) {
        layer = doc.createElementNS(svgNamespace, 'svg');
        layer.setAttribute('class', 'docuflex-under-text-annotation-layer');
        layer.setAttribute('aria-hidden', 'true');
        layer.setAttribute('viewBox', '0 0 1 1');
        layer.setAttribute('preserveAspectRatio', 'none');
        const firstTextNode = [...htmlPageContent.children].find((child) => child.classList.contains('t')) ?? null;
        htmlPageContent.insertBefore(layer, firstTextNode);
      }

      const svgLayer = /** @type {SVGSVGElement} */ (layer);
      svgLayer.style.position = 'absolute';
      svgLayer.style.inset = '0';
      svgLayer.style.width = '100%';
      svgLayer.style.height = '100%';
      svgLayer.style.overflow = 'hidden';
      svgLayer.style.pointerEvents = 'none';
      svgLayer.style.mixBlendMode = 'multiply';
      const pageRedactions = pageAnnotations.filter((annotation) => annotation.type === 'blackout' || annotation.type === 'whiteout');
      if (pageRedactions.length > 0 && (!redactionLayer || redactionLayer.nodeType !== 1)) {
        redactionLayer = doc.createElementNS(svgNamespace, 'svg');
        redactionLayer.setAttribute('class', 'docuflex-over-text-redaction-layer');
        redactionLayer.setAttribute('aria-hidden', 'true');
        redactionLayer.setAttribute('viewBox', '0 0 1 1');
        redactionLayer.setAttribute('preserveAspectRatio', 'none');
        htmlPageContent.appendChild(redactionLayer);
      } else if (pageRedactions.length === 0) {
        redactionLayer?.remove();
        redactionLayer = null;
      }
      const redactionSvgLayer = redactionLayer?.nodeType === 1
        ? /** @type {SVGSVGElement} */ (redactionLayer)
        : null;
      if (redactionSvgLayer) {
        redactionSvgLayer.style.position = 'absolute';
        redactionSvgLayer.style.inset = '0';
        redactionSvgLayer.style.width = '100%';
        redactionSvgLayer.style.height = '100%';
        redactionSvgLayer.style.overflow = 'hidden';
        redactionSvgLayer.style.pointerEvents = 'none';
        redactionSvgLayer.style.zIndex = '2147483000';
      }
      const existingNodes = [
        ...svgLayer.querySelectorAll(':scope > g[data-docuflex-annotation-id]'),
        ...(redactionSvgLayer?.querySelectorAll(':scope > g[data-docuflex-annotation-id]') ?? [])
      ];
      const existingGroups = new Map(existingNodes
        .map((node) => [node.getAttribute('data-docuflex-annotation-id') ?? '', node]));
      const activeGroupIds = new Set();

      pageAnnotations.forEach((annotation, annotationIndex) => {
        const annotationId = String(annotation.id || `${annotation.type}-${annotationIndex}`);
        const isRedaction = annotation.type === 'blackout' || annotation.type === 'whiteout';
        const targetLayer = isRedaction ? redactionSvgLayer : svgLayer;
        if (!targetLayer) return;
        activeGroupIds.add(annotationId);
        let group = existingGroups.get(annotationId);
        if (!group || group.parentNode !== targetLayer || group.getAttribute('data-docuflex-annotation-type') !== annotation.type) {
          group?.remove();
          group = doc.createElementNS(svgNamespace, 'g');
          group.setAttribute('data-docuflex-annotation-id', annotationId);
          group.setAttribute('data-docuflex-annotation-type', annotation.type);
          targetLayer.appendChild(group);
        }

        if (['highlight', 'underline', 'crossout', 'blackout', 'whiteout'].includes(annotation.type)) {
          const boundRect = boundTextHighlightRect(annotation, htmlPage);
          resolvedTextHighlightRects.set(String(annotation.id || ''), boundRect);
          if (annotation.type === 'highlight' || isRedaction) {
            let rect = group.querySelector(':scope > rect');
            if (!rect) {
              group.replaceChildren();
              rect = doc.createElementNS(svgNamespace, 'rect');
              group.appendChild(rect);
            }
            rect.setAttribute('x', `${boundRect.x}`);
            rect.setAttribute('y', `${boundRect.y}`);
            rect.setAttribute('width', `${boundRect.width}`);
            rect.setAttribute('height', `${boundRect.height}`);
            rect.setAttribute('rx', annotation.type === 'highlight' ? '0.002' : '0');
            rect.setAttribute('fill', annotation.type === 'highlight' ? '#ffe43b' : annotation.type === 'blackout' ? '#000' : '#fff');
          } else {
            const lineY = boundRect.y + boundRect.height * (annotation.type === 'underline' ? 0.9 : 0.52);
            const color = Array.isArray(annotation.color) && annotation.color.length >= 3
              ? annotation.color.slice(0, 3).map((/** @type {any} */ component) => Math.max(0, Math.min(1, Number(component) || 0)))
              : [0, 0, 0];
            let line = group.querySelector(':scope > line');
            if (!line) {
              group.replaceChildren();
              line = doc.createElementNS(svgNamespace, 'line');
              group.appendChild(line);
            }
            line.setAttribute('x1', `${boundRect.x}`);
            line.setAttribute('y1', `${lineY}`);
            line.setAttribute('x2', `${boundRect.x + boundRect.width}`);
            line.setAttribute('y2', `${lineY}`);
            line.setAttribute('stroke', `rgb(${color.map((/** @type {number} */ component) => Math.round(component * 255)).join(' ')})`);
            line.setAttribute('stroke-width', `${Math.max(0.0012, Math.min(0.0025, boundRect.height * 0.09))}`);
            line.setAttribute('stroke-linecap', 'round');
            line.setAttribute('opacity', '0.96');
          }
          return;
        }

        const points = /** @type {{ x: number; y: number }[]} */ (
          Array.isArray(annotation.points) ? annotation.points : []
        );
        if (points.length === 0) return;
        const pathData = points.map((point, pointIndex) =>
          `${pointIndex ? 'L' : 'M'} ${Number(point.x || 0)} ${Number(point.y || 0)}`
        ).join(' ');
        const strokeStyle = Array.isArray(annotation.color) ? annotation.color : [];
        const red = Math.round(Math.max(0, Math.min(1, Number(strokeStyle[0] ?? 1))) * 255);
        const green = Math.round(Math.max(0, Math.min(1, Number(strokeStyle[1] ?? 0.894))) * 255);
        const blue = Math.round(Math.max(0, Math.min(1, Number(strokeStyle[2] ?? 0.231))) * 255);
        const strokeColor = `rgb(${red} ${green} ${blue})`;
        const strokeOpacity = Math.max(0.01, Math.min(1, Number(strokeStyle[3] ?? 0.34)));
        const strokeWidth = Math.max(0.5, Number(strokeStyle[4] ?? 16));
        const falloff = Math.max(0, Math.min(1, Number(strokeStyle[5] ?? 0.35)));
        const normalizedWidth = 0.0175 * strokeWidth / 16;
        let paths = group.querySelectorAll(':scope > path');
        if (paths.length !== 2) {
          group.replaceChildren();
          group.append(doc.createElementNS(svgNamespace, 'path'), doc.createElementNS(svgNamespace, 'path'));
          paths = group.querySelectorAll(':scope > path');
        }
        const edge = paths[0];
        edge.setAttribute('d', pathData);
        edge.setAttribute('fill', 'none');
        edge.setAttribute('stroke', strokeColor);
        edge.setAttribute('stroke-width', `${normalizedWidth * (1 + falloff * 0.4)}`);
        edge.setAttribute('stroke-linecap', 'round');
        edge.setAttribute('stroke-linejoin', 'round');
        edge.setAttribute('opacity', `${strokeOpacity * falloff * 0.72}`);
        const ink = paths[1];
        ink.setAttribute('d', pathData);
        ink.setAttribute('fill', 'none');
        ink.setAttribute('stroke', strokeColor);
        ink.setAttribute('stroke-width', `${normalizedWidth}`);
        ink.setAttribute('stroke-linecap', 'round');
        ink.setAttribute('stroke-linejoin', 'round');
        ink.setAttribute('opacity', `${strokeOpacity}`);
      });
      existingGroups.forEach((group, annotationId) => {
        if (!activeGroupIds.has(annotationId)) group.remove();
      });
    });
  }

  /** @param {any} annotation @param {HTMLElement} page */
  function boundTextHighlightRect(annotation, page) {
    const original = {
      x: Number(annotation.x || 0),
      y: Number(annotation.y || 0),
      width: Number(annotation.width || 0),
      height: Number(annotation.height || 0)
    };
    const key = String(annotation.id || `${annotation.page}:${original.x}:${original.y}:${original.width}:${original.height}`);
    const pageRect = page.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return original;
    let binding = textHighlightBindings.get(key);
    if (binding) {
      const owner = owningEditableTextBox(page, binding.element);
      if (owner && owner !== binding.element) {
        const oldRect = binding.element.getBoundingClientRect();
        const target = {
          left: oldRect.left + binding.left * oldRect.width,
          top: oldRect.top + binding.top * oldRect.height,
          width: binding.width * oldRect.width,
          height: binding.height * oldRect.height
        };
        const ownerRect = owner.getBoundingClientRect();
        if (ownerRect.width && ownerRect.height) {
          binding = {
            element: owner,
            left: (target.left - ownerRect.left) / ownerRect.width,
            top: (target.top - ownerRect.top) / ownerRect.height,
            width: target.width / ownerRect.width,
            height: target.height / ownerRect.height
          };
          textHighlightBindings.set(key, binding);
        }
      }
      const style = htmlFrame?.contentWindow?.getComputedStyle(binding.element);
      if (!binding.element.isConnected || style?.display === 'none' || style?.visibility === 'hidden' || binding.element.classList.contains('docuflex-group-hidden')) {
        textHighlightBindings.delete(key);
        binding = undefined;
      }
    }

    if (!binding) {
      const target = {
        left: pageRect.left + original.x * pageRect.width,
        top: pageRect.top + original.y * pageRect.height,
        right: pageRect.left + (original.x + original.width) * pageRect.width,
        bottom: pageRect.top + (original.y + original.height) * pageRect.height
      };
      const targetCenterX = (target.left + target.right) / 2;
      const targetCenterY = (target.top + target.bottom) / 2;
      /** @type {{ element: HTMLElement; rect: DOMRect; score: number } | null} */
      let best = null;
      page.querySelectorAll('.docuflex-textbox, .t').forEach((candidate) => {
        if (candidate.nodeType !== 1) return;
        const element = /** @type {HTMLElement} */ (candidate);
        const style = htmlFrame?.contentWindow?.getComputedStyle(element);
        if (style?.display === 'none' || style?.visibility === 'hidden' || element.classList.contains('docuflex-group-hidden')) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const overlapWidth = Math.max(0, Math.min(target.right, rect.right) - Math.max(target.left, rect.left));
        const overlapHeight = Math.max(0, Math.min(target.bottom, rect.bottom) - Math.max(target.top, rect.top));
        const overlap = overlapWidth * overlapHeight;
        const distance = Math.hypot(targetCenterX - (rect.left + rect.width / 2), targetCenterY - (rect.top + rect.height / 2));
        const score = overlap * 1000 - distance;
        if (!best || score > best.score) best = { element, rect, score };
      });
      if (best) {
        const bestMatch = /** @type {{ element: HTMLElement; rect: DOMRect; score: number }} */ (best);
        const owner = owningEditableTextBox(page, bestMatch.element);
        const ownerRect = owner?.getBoundingClientRect();
        const boundElement = owner && ownerRect?.width && ownerRect.height ? owner : bestMatch.element;
        const boundElementRect = /** @type {DOMRect} */ (boundElement === owner ? ownerRect : bestMatch.rect);
        binding = {
          element: boundElement,
          left: (target.left - boundElementRect.left) / boundElementRect.width,
          top: (target.top - boundElementRect.top) / boundElementRect.height,
          width: (target.right - target.left) / boundElementRect.width,
          height: (target.bottom - target.top) / boundElementRect.height
        };
        textHighlightBindings.set(key, binding);
      }
    }

    if (!binding) return original;
    const textRect = binding.element.getBoundingClientRect();
    return {
      x: (textRect.left + binding.left * textRect.width - pageRect.left) / pageRect.width,
      y: (textRect.top + binding.top * textRect.height - pageRect.top) / pageRect.height,
      width: (binding.width * textRect.width) / pageRect.width,
      height: (binding.height * textRect.height) / pageRect.height
    };
  }

  /** @param {HTMLElement} page @param {HTMLElement} element */
  function owningEditableTextBox(page, element) {
    if (element.classList.contains('docuflex-textbox')) return element;
    const editId = element.dataset.docuflexEditId;
    if (!editId) return null;
    for (const candidate of page.querySelectorAll('.docuflex-textbox')) {
      if (candidate.nodeType !== 1) continue;
      const box = /** @type {HTMLElement} */ (candidate);
      try {
        const lineIds = JSON.parse(box.dataset.docuflexLineIds || '[]');
        if (Array.isArray(lineIds) && lineIds.map(String).includes(editId)) return box;
      } catch {
        // Ignore a malformed generated textbox and keep the line-level binding.
      }
    }
    return null;
  }

  function ensureHtmlScrollExtent() {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    const pageContainer = doc.querySelector('#page-container');
    if (!pageContainer || pageContainer.nodeType !== 1) return;
    const htmlPageContainer = /** @type {HTMLElement} */ (pageContainer);
    htmlPageContainer.style.minHeight = '';

    // WebKit does not reliably include trailing flex padding in scrollWidth
    // when a zoomed child is wider than its container. Pin an invisible extent
    // after the actual rightmost rendered page edge so both pan limits match.
    const containerRect = htmlPageContainer.getBoundingClientRect();
    const rightmostPageEdge = [...htmlPageContainer.querySelectorAll('.pf')].reduce((right, page) => {
      if (page.nodeType !== 1) return right;
      return Math.max(right, /** @type {HTMLElement} */ (page).getBoundingClientRect().right);
    }, containerRect.left);
    let horizontalExtent = doc.getElementById('docuflex-html-horizontal-extent');
    if (!horizontalExtent) {
      horizontalExtent = doc.createElement('span');
      horizontalExtent.id = 'docuflex-html-horizontal-extent';
      htmlPageContainer.append(horizontalExtent);
    }
    horizontalExtent.style.cssText = [
      'position:absolute',
      'top:0',
      `left:${Math.ceil(rightmostPageEdge - containerRect.left + horizontalPanGutter)}px`,
      'width:1px',
      'height:1px',
      'pointer-events:none',
      'visibility:hidden'
    ].join(';');

    const bottommostPageEdge = [...htmlPageContainer.querySelectorAll('.pf')].reduce((bottom, page) => {
      if (page.nodeType !== 1) return bottom;
      return Math.max(bottom, /** @type {HTMLElement} */ (page).getBoundingClientRect().bottom);
    }, containerRect.top);
    let verticalExtent = doc.getElementById('docuflex-html-scroll-tail');
    if (!verticalExtent) {
      verticalExtent = doc.createElement('span');
      verticalExtent.id = 'docuflex-html-scroll-tail';
      htmlPageContainer.append(verticalExtent);
    }
    verticalExtent.style.cssText = [
      'position:absolute',
      `top:${Math.ceil(bottommostPageEdge - containerRect.top + verticalPanGutter)}px`,
      'left:0',
      'width:1px',
      'height:1px',
      'pointer-events:none',
      'visibility:hidden'
    ].join(';');
  }

  function syncOverlayPageFrames() {
    const doc = htmlFrame?.contentDocument;
    if (!doc || !htmlFrame || !htmlViewport) {
      overlayPageFrames = [];
      return;
    }
    overlayPageFrames = [...doc.querySelectorAll('.pf')].flatMap((page, index) => {
      if (page.nodeType !== 1) return [];
      const htmlPage = /** @type {HTMLElement} */ (page);
      const rect = htmlPage.getBoundingClientRect();
      const pageNumber = Number(htmlPage.dataset.pageNo || index + 1);
      return [{
        page: Math.max(0, pageNumber - 1),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }];
    });
  }

  function updateHtmlToolMode() {
    const root = htmlFrame?.contentDocument?.documentElement;
    if (!root) return;
    root.classList.toggle('docuflex-pan-tool', activeTool === 'pan');
    root.classList.toggle('docuflex-zoom-tool', activeTool === 'zoom');
    root.classList.toggle('docuflex-zoom-out', activeTool === 'zoom' && (zoomingOut || htmlShiftPressed));
    root.classList.toggle('docuflex-panning', Boolean(htmlPanStart));
  }

  /** @param {number} requestedZoom @param {number} clientX @param {number} clientY */
  function zoomHtmlAt(requestedZoom, clientX, clientY) {
    const scroller = htmlScroller();
    const frameDocument = htmlFrame?.contentDocument;
    const frameWindow = htmlFrame?.contentWindow;
    const pageElements = frameDocument ? [...frameDocument.querySelectorAll('.pf')] : [];
    if (!scroller || !frameWindow || !pageElements.length) return;
    const nextZoom = Math.min(maxZoom, Math.max(minZoom, requestedZoom));
    if (Math.abs(nextZoom - zoomLevel) < 0.001) return;

    let anchorPage = pageElements[0];
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const page of pageElements) {
      const rect = page.getBoundingClientRect();
      const distance = clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom ? clientY - rect.bottom : 0;
      if (distance < closestDistance) {
        anchorPage = page;
        closestDistance = distance;
      }
    }
    if (!anchorPage) return;

    const before = anchorPage.getBoundingClientRect();
    const anchorRatioX = before.width ? (clientX - before.left) / before.width : 0.5;
    const anchorRatioY = before.height ? (clientY - before.top) / before.height : 0.5;
    zoomLevel = nextZoom;
    applyHtmlViewportStyles();
    const after = anchorPage.getBoundingClientRect();
    const availableWidth = Math.max(0, frameWindow.innerWidth - 96);

    if (after.width <= availableWidth + 0.5) {
      // A fitting page must remain perfectly centered; cursor anchoring only
      // begins after horizontal overflow exists.
      scroller.scrollLeft = horizontalPanGutter;
    } else {
      scroller.scrollLeft += after.left + anchorRatioX * after.width - clientX;
    }
    scroller.scrollTop += after.top + anchorRatioY * after.height - clientY;
  }

  /** @param {WheelEvent} event */
  function handleHtmlWheel(event) {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 100 : 1;
    // Native pinch deltas inside the converted-document iframe are smaller
    // than the same gesture on the main viewer, so compensate at this boundary.
    const sensitivity = event.metaKey ? 0.002 : 0.015;
    zoomHtmlAt(zoomLevel * Math.exp(-event.deltaY * deltaScale * sensitivity), event.clientX, event.clientY);
  }

  /** @param {PointerEvent} event */
  function handleHtmlPointerDown(event) {
    const shouldPan = event.button === 1 || (event.button === 0 && activeTool === 'pan');
    if (event.button === 0 && activeTool === 'zoom') {
      event.preventDefault();
      event.stopImmediatePropagation();
      zoomHtmlAt(zoomLevel * (event.shiftKey ? 1 / clickZoomFactor : clickZoomFactor), event.clientX, event.clientY);
      return;
    }
    if (!shouldPan) return;
    const scroller = htmlScroller();
    if (!scroller) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    htmlPanStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop
    };
    updateHtmlToolMode();
  }

  /** @param {PointerEvent} event */
  function handleHtmlPointerMove(event) {
    if (!htmlPanStart || event.pointerId !== htmlPanStart.pointerId) return;
    const scroller = htmlScroller();
    if (!scroller) return;
    event.preventDefault();
    scroller.scrollLeft = htmlPanStart.scrollLeft - (event.clientX - htmlPanStart.x);
    scroller.scrollTop = htmlPanStart.scrollTop - (event.clientY - htmlPanStart.y);
  }

  /** @param {PointerEvent} event */
  function endHtmlPan(event) {
    if (!htmlPanStart || event.pointerId !== htmlPanStart.pointerId) return;
    htmlPanStart = null;
    updateHtmlToolMode();
  }

  /** @param {MouseEvent} event */
  function preventHtmlMiddleClick(event) {
    if (event.button === 1) event.preventDefault();
  }

  /** @param {KeyboardEvent} event */
  function handleHtmlKeyDown(event) {
    if (event.key !== 'Shift') return;
    htmlShiftPressed = true;
    updateHtmlToolMode();
  }

  /** @param {KeyboardEvent} event */
  function handleHtmlKeyUp(event) {
    if (event.key !== 'Shift') return;
    htmlShiftPressed = false;
    updateHtmlToolMode();
  }

  /** @param {number} pageIndex */
  export function scrollToPage(pageIndex) {
    const page = htmlFrame?.contentDocument?.querySelector(`[data-page-no="${pageIndex + 1}"]`);
    page?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** @param {'undo' | 'redo'} command */
  function runHtmlHistoryCommand(command) {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    htmlFrame?.contentWindow?.focus();
    doc.execCommand(command, false);
    doc.querySelectorAll('.t').forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      node.dataset.docuflexCurrentText = normalizedConvertedNodeText(node);
    });
    syncHtmlFormatState();
    scheduleHtmlGeometrySync();
  }

  export function undo() {
    runHtmlHistoryCommand('undo');
  }

  export function redo() {
    runHtmlHistoryCommand('redo');
  }

  function prepareConvertedHtmlEditor() {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;

    doc.documentElement.classList.add('docuflex-html-editor');
    doc.designMode = 'off';
    if (doc.body) {
      doc.body.contentEditable = 'false';
      doc.body.spellcheck = false;
    }
    applyHtmlViewportStyles();
    const scroller = htmlScroller();
    if (scroller) scroller.scrollLeft = horizontalPanGutter;
    requestAnimationFrame(() => {
      const readyScroller = htmlScroller();
      if (readyScroller) readyScroller.scrollLeft = horizontalPanGutter;
    });
    updateHtmlToolMode();
    const frameWindow = htmlFrame?.contentWindow;
    frameWindow?.addEventListener('wheel', handleHtmlWheel, { passive: false, capture: true });
    frameWindow?.addEventListener('pointerdown', handleHtmlPointerDown, true);
    frameWindow?.addEventListener('pointermove', handleHtmlPointerMove, true);
    frameWindow?.addEventListener('pointerup', endHtmlPan, true);
    frameWindow?.addEventListener('pointercancel', endHtmlPan, true);
    frameWindow?.addEventListener('auxclick', preventHtmlMiddleClick, true);
    frameWindow?.addEventListener('keydown', handleHtmlKeyDown, true);
    frameWindow?.addEventListener('keyup', handleHtmlKeyUp, true);
    frameWindow?.addEventListener('blur', () => {
      htmlShiftPressed = false;
      htmlPanStart = null;
      updateHtmlToolMode();
    });
    frameWindow?.addEventListener('scroll', scheduleHtmlGeometrySync, true);
    frameWindow?.addEventListener('resize', scheduleHtmlGeometrySync);
    doc.addEventListener('wheel', handleHtmlWheel, { passive: false, capture: true });
    doc.addEventListener('pointerdown', handleHtmlPointerDown, true);
    doc.addEventListener('pointermove', handleHtmlPointerMove, true);
    doc.addEventListener('pointerup', endHtmlPan, true);
    doc.addEventListener('pointercancel', endHtmlPan, true);
    doc.addEventListener('auxclick', preventHtmlMiddleClick, true);
    doc.addEventListener('scroll', scheduleHtmlGeometrySync, true);
    hideDuplicateConvertedPageBackdrops(doc);
    requestAnimationFrame(() => hideDuplicateConvertedPageBackdrops(doc));
    doc.querySelectorAll('.t').forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      prepareConvertedHtmlNode(node);
    });
    doc.addEventListener('pointerdown', (event) => activateConvertedHtmlFromTarget(event.target), true);
    doc.addEventListener('click', (event) => activateConvertedHtmlFromTarget(event.target), true);
    doc.addEventListener('focusin', (event) => activateConvertedHtmlFromTarget(event.target), true);
    doc.addEventListener('input', (event) => {
      const node = activateConvertedHtmlFromTarget(event.target);
      if (!node) return;
      node.dataset.docuflexCurrentText = normalizedConvertedNodeText(node);
      node.classList.add('docuflex-live-edit');
      hideDuplicateConvertedPageBackdrops(doc);
    }, true);
    doc.addEventListener('keyup', (event) => activateConvertedHtmlFromTarget(event.target), true);
    doc.addEventListener('selectionchange', () => {
      saveHtmlSelection();
      syncHtmlFormatState();
    });
    scheduleHtmlGeometrySync();
    setTimeout(scheduleHtmlGeometrySync, 160);
    setTimeout(scheduleHtmlGeometrySync, 500);
    onEditorReady();
  }

  /** @param {HTMLElement} node */
  function prepareConvertedHtmlNode(node) {
    rememberConvertedHtmlOriginal(node);
    if (node.dataset.docuflexGrouped === 'true') {
      node.contentEditable = 'true';
      node.spellcheck = false;
      node.setAttribute('role', 'textbox');
      node.tabIndex = 0;
      node.classList.add('docuflex-grouped-line');
      return;
    }
    node.contentEditable = 'true';
    node.spellcheck = false;
    node.setAttribute('role', 'textbox');
    node.tabIndex = 0;
    node.classList.remove('docuflex-bold-edit');
    const fontSize = Number.parseFloat(htmlFrame?.contentWindow?.getComputedStyle(node).fontSize || '0') || 0;
    node.classList.toggle('docuflex-large-heading-edit', fontSize >= 150);

    const wrapper = node.parentElement?.matches('.c') && node.parentElement.querySelectorAll('.t').length === 1
      ? node.parentElement
      : null;
    if (isIframeHtmlElement(wrapper)) {
      wrapper.dataset.docuflexEditId = node.dataset.docuflexEditId ?? '';
      wrapper.dataset.docuflexOriginalText = node.dataset.docuflexOriginalText ?? '';
      wrapper.dataset.docuflexOriginalHtmlText = node.dataset.docuflexOriginalHtmlText ?? '';
      wrapper.contentEditable = 'false';
      wrapper.spellcheck = false;
    }
  }

  /** @param {EventTarget | null} target */
  function activateConvertedHtmlFromTarget(target) {
    if (!isIframeHtmlElement(target)) return null;
    const node = findConvertedHtmlNode(target);
    if (!node) return null;
    activeHtmlTextId = node.dataset.docuflexEditId ?? '';
    detectedFont = detectedFontForConvertedNode(node);
    htmlBoldActive = isConvertedNodeBold(node);
    saveHtmlSelection();
    syncHtmlFormatState();
    return node;
  }

  /** @param {unknown} value @returns {value is HTMLElement} */
  function isIframeHtmlElement(value) {
    return Boolean(value && typeof value === 'object' && /** @type {{ nodeType?: number }} */ (value).nodeType === 1);
  }

  /** @param {Element} target */
  function findConvertedHtmlNode(target) {
    const direct = target.closest('.t');
    if (isIframeHtmlElement(direct)) return direct;
    const wrapper = target.closest('[data-docuflex-edit-id]');
    if (isIframeHtmlElement(wrapper)) {
      const child = wrapper.matches('.t') ? wrapper : wrapper.querySelector('.t');
      if (isIframeHtmlElement(child)) return child;
    }
    const clip = target.closest('.c');
    const clipText = clip?.querySelector('.t');
    return isIframeHtmlElement(clipText) ? clipText : null;
  }

  /** @param {'bold' | 'italic' | 'underline' | 'strikeThrough'} command */
  function formatHtmlSelection(command) {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    htmlFrame?.contentWindow?.focus();
    try {
      const format = htmlFrame?.contentWindow
        ? /** @type {{ __docuflexFormat?: (command: string) => void }} */ (htmlFrame.contentWindow).__docuflexFormat
        : null;
      if (typeof format === 'function') {
        format(command);
        return;
      }
    } catch {
      // Fall back to document commands below.
    }
    restoreHtmlSelection();
    doc.execCommand(command, false);
    syncHtmlFormatState();
    const activeNode = activeHtmlTextId
      ? doc.querySelector(`[data-docuflex-edit-id="${CSS.escape(activeHtmlTextId)}"]`)
      : null;
    if (isIframeHtmlElement(activeNode)) {
      activeNode.classList.add('docuflex-live-edit');
    }
  }

  function toggleHtmlBoldSelection() {
    const nextBold = !htmlBoldActive;
    htmlBoldActive = nextBold;
    htmlFontWeight = nextBold ? 700 : 400;
    updateHtmlTextStyle('fontWeight', String(htmlFontWeight));
  }

  function toggleHtmlItalicSelection() {
    htmlItalicActive = !htmlItalicActive;
    updateHtmlTextStyle('fontStyle', htmlItalicActive ? 'italic' : 'normal');
  }

  function applyHtmlTextDecoration() {
    const decorations = [htmlUnderlineActive ? 'underline' : '', htmlStrikethroughActive ? 'line-through' : ''].filter(Boolean);
    updateHtmlTextStyle('textDecorationLine', decorations.length ? decorations.join(' ') : 'none');
  }

  function selectedHtmlTextboxRows() {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return [];
    const activeBox = activeHtmlTextBoxId
      ? Array.from(doc.querySelectorAll('.docuflex-textbox')).find((candidate) => {
          return isIframeHtmlElement(candidate) && candidate.dataset.docuflexTextBoxId === activeHtmlTextBoxId;
        })
      : activeHtmlTextId
        ? Array.from(doc.querySelectorAll('.docuflex-textbox')).find((candidate) => {
          try {
            return JSON.parse(candidate.getAttribute('data-docuflex-line-ids') || '[]').includes(activeHtmlTextId);
          } catch {
            return false;
          }
        })
        : null;
    if (htmlBoxSelectionActive && activeBox) {
      return Array.from(activeBox.querySelectorAll('.docuflex-textbox-rich-line'))
        .filter(isIframeHtmlElement);
    }
    restoreHtmlSelection();
    const selection = doc.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const container = range?.commonAncestorContainer;
    const element = container
      ? (container.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (container) : container.parentElement)
      : doc.activeElement;
    const editor = element?.closest?.('.docuflex-textbox-editor')
      || doc.activeElement?.closest?.('.docuflex-textbox-editor');
    if (!editor || editor.nodeType !== Node.ELEMENT_NODE || (activeBox && !activeBox.contains(editor))) {
      return activeBox
        ? Array.from(activeBox.querySelectorAll('.docuflex-textbox-rich-line')).filter(isIframeHtmlElement)
        : [];
    }
    const rows = Array.from(editor.querySelectorAll('.docuflex-textbox-rich-line'))
      .filter((row) => row.nodeType === Node.ELEMENT_NODE)
      .map((row) => /** @type {HTMLElement} */ (row));
    if (!range) return rows.slice(0, 1);
    const selected = rows.filter((row) => {
      try {
        return range.intersectsNode(row);
      } catch {
        return false;
      }
    });
    return selected.length ? selected : rows.filter((row) => selection?.anchorNode ? row.contains(selection.anchorNode) : false);
  }

  /** @param {HTMLElement[]} rows */
  function notifyHtmlTextboxRowsChanged(rows) {
    const doc = htmlFrame?.contentDocument;
    if (!doc || !rows.length) return;
    const editor = rows[0].closest('.docuflex-textbox-editor');
    const box = rows[0].closest('.docuflex-textbox');
    if (box && box.nodeType === Node.ELEMENT_NODE) {
      const htmlBox = /** @type {HTMLElement} */ (box);
      htmlBox.classList.add('docuflex-live-edit');
      htmlBox.dataset.docuflexVisualEditing = 'true';
      htmlBox.dataset.docuflexFormattingDirty = 'true';
    }
    rows.forEach((row) => {
      row.dataset.docuflexStyleDirty = 'true';
    });
    if (isIframeHtmlElement(box)) {
      const allRows = Array.from(box.querySelectorAll('.docuflex-textbox-rich-line')).filter(isIframeHtmlElement);
      box.dataset.docuflexStyleSnapshot = JSON.stringify(allRows.map((row) => ({
        'font-family': row.style.fontFamily,
        'font-weight': row.style.fontWeight,
        'font-style': row.style.fontStyle,
        'font-size': row.style.fontSize,
        color: row.style.color,
        'letter-spacing': row.style.letterSpacing,
        'line-height': row.style.lineHeight,
        'text-decoration-line': row.style.textDecorationLine || 'none',
        'text-align': row.style.textAlign
      })));
    }
    let notified = false;
    try {
      const notifyFormatting = htmlFrame?.contentWindow
        ? /** @type {{ __docuflexNotifyTextBoxFormatting?: (boxId: string) => boolean }} */ (htmlFrame.contentWindow).__docuflexNotifyTextBoxFormatting
        : null;
      if (typeof notifyFormatting === 'function' && isIframeHtmlElement(box)) {
        notified = notifyFormatting(box.dataset.docuflexTextBoxId || '');
      }
    } catch {
      // Fall back to the input event for older converted frames.
    }
    if (!notified) {
      const EventCtor = doc.defaultView?.Event || Event;
      editor?.dispatchEvent(new EventCtor('input', { bubbles: true }));
    }
  }

  /** @param {HTMLElement[]} rows */
  function restoreHtmlTextboxStyleSnapshot(rows) {
    const box = rows[0]?.closest('.docuflex-textbox');
    if (!isIframeHtmlElement(box) || !box.dataset.docuflexStyleSnapshot) return;
    try {
      const snapshots = JSON.parse(box.dataset.docuflexStyleSnapshot);
      if (!Array.isArray(snapshots)) return;
      rows.forEach((row, index) => {
        const snapshot = snapshots[index];
        if (!snapshot || typeof snapshot !== 'object') return;
        Object.entries(snapshot).forEach(([property, value]) => {
          if (typeof value !== 'string') return;
          row.style.setProperty(property, value);
          if (property === 'font-family') {
            row.querySelectorAll('*').forEach((child) => {
              if (isIframeHtmlElement(child)) child.style.setProperty('font-family', value, 'important');
            });
          }
        });
      });
    } catch {
      // Ignore an invalid stale snapshot and use the live row styles.
    }
  }

  /** @param {'left' | 'center' | 'right'} alignment */
  function alignHtmlSelection(alignment) {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    htmlFrame?.contentWindow?.focus();
    const rows = selectedHtmlTextboxRows();
    if (rows.length) {
      restoreHtmlTextboxStyleSnapshot(rows);
      const editor = rows[0].closest('.docuflex-textbox-editor');
      if (isIframeHtmlElement(editor)) {
        editor.style.textAlign = alignment;
        editor.dataset.docuflexAlign = alignment;
      }
      rows.forEach((row) => {
        row.style.textAlign = alignment;
        row.dataset.docuflexAlign = alignment;
      });
      notifyHtmlTextboxRowsChanged(rows);
      return;
    }
    restoreHtmlSelection();
    doc.execCommand(alignment === 'center' ? 'justifyCenter' : alignment === 'right' ? 'justifyRight' : 'justifyLeft', false);
    htmlTextAlign = alignment;
  }

  /** @param {'fontWeight' | 'fontFamily' | 'fontSize' | 'fontStyle' | 'color' | 'letterSpacing' | 'lineHeight' | 'textDecorationLine'} property @param {string} value */
  function updateHtmlTextStyle(property, value) {
    const doc = htmlFrame?.contentDocument;
    if (!doc || !activeHtmlTextId) return;
    htmlFrame?.contentWindow?.focus();
    const rows = selectedHtmlTextboxRows();
    if (rows.length) {
      restoreHtmlTextboxStyleSnapshot(rows);
      const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const editor = rows[0].closest('.docuflex-textbox-editor');
      if (isIframeHtmlElement(editor)) editor.style.setProperty(cssProperty, value);
      rows.forEach((row) => {
        row.style.setProperty(cssProperty, value);
        if (property === 'fontFamily') {
          row.querySelectorAll('*').forEach((child) => {
            if (isIframeHtmlElement(child)) child.style.setProperty('font-family', value, 'important');
          });
        }
      });
      notifyHtmlTextboxRowsChanged(rows);
      return;
    }
    const activeNode = doc.querySelector(`[data-docuflex-edit-id="${CSS.escape(activeHtmlTextId)}"]`);
    if (!isIframeHtmlElement(activeNode)) return;
    activeNode.style.setProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value);
    activeNode.classList.add('docuflex-live-edit');
    const EventCtor = doc.defaultView?.Event || Event;
    activeNode.dispatchEvent(new EventCtor('input', { bubbles: true }));
    detectedFont = detectedFontForConvertedNode(activeNode);
  }

  /** @param {number} weight */
  function setHtmlFontWeight(weight) {
    htmlFontWeight = weight;
    htmlBoldActive = weight >= 600;
    updateHtmlTextStyle('fontWeight', String(weight));
  }

  /** @param {string} value */
  function setHtmlFontFamily(value) {
    htmlFontFamily = value;
    updateHtmlTextStyle('fontFamily', value);
  }

  /** @param {number} value */
  function setHtmlFontSize(value) {
    htmlFontSize = Math.max(1, value || 1);
    updateHtmlTextStyle('fontSize', `${htmlFontSize}px`);
  }

  /** @param {string} value */
  function setHtmlTextColor(value) {
    const normalized = normalizeHexColor(value);
    if (!normalized) return;
    htmlTextColor = normalized;
    updateHtmlTextStyle('color', normalized);
  }

  function toggleHtmlUnderlineSelection() {
    htmlUnderlineActive = !htmlUnderlineActive;
    applyHtmlTextDecoration();
  }

  function toggleHtmlStrikethroughSelection() {
    htmlStrikethroughActive = !htmlStrikethroughActive;
    applyHtmlTextDecoration();
  }

  /** @param {HTMLElement} row */
  function htmlRowHasBullet(row) {
    return /^\\s*(?:•|\\*|-)\\s+/u.test(row.textContent || '') || row.dataset.docuflexBullet === 'true';
  }

  /** @param {HTMLElement} row */
  function removeHtmlRowBullet(row) {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    const walker = doc.createTreeWalker(row, 4);
    let consumed = '';
    const touched = [];
    while (consumed.length < 12) {
      const node = walker.nextNode();
      if (!node || node.nodeType !== Node.TEXT_NODE) break;
      touched.push(/** @type {Text} */ (node));
      consumed += node.nodeValue || '';
      if (/^\\s*(?:•|\\*|-)\\s+/u.test(consumed) || consumed.trim().length > 1) break;
    }
    const match = consumed.match(/^(\\s*(?:•|\\*|-)\\s+)/u);
    if (match) {
      let remaining = match[1].length;
      touched.forEach((node) => {
        if (remaining <= 0) return;
        const remove = Math.min(remaining, node.data.length);
        node.data = node.data.slice(remove);
        remaining -= remove;
      });
    } else {
      row.textContent = (row.textContent || '').replace(/^\\s*(?:•|\\-|\\*)\\s+/u, '');
    }
    row.dataset.docuflexBullet = 'false';
  }

  /** @param {HTMLElement} row */
  function addHtmlRowBullet(row) {
    const doc = htmlFrame?.contentDocument;
    if (!doc || htmlRowHasBullet(row)) return;
    row.insertBefore(doc.createTextNode('• '), row.firstChild);
    row.dataset.docuflexBullet = 'true';
  }

  function toggleHtmlListSelection() {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    htmlFrame?.contentWindow?.focus();
    const rows = selectedHtmlTextboxRows();
    if (rows.length) {
      const enable = rows.some((row) => !htmlRowHasBullet(row));
      rows.forEach((row) => {
        if (enable) addHtmlRowBullet(row);
        else removeHtmlRowBullet(row);
      });
      notifyHtmlTextboxRowsChanged(rows);
      return;
    }
    restoreHtmlSelection();
    doc.execCommand('insertUnorderedList', false);
  }

  function syncHtmlFormatState() {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    const activeNode = activeHtmlTextId
      ? doc.querySelector(`[data-docuflex-edit-id="${CSS.escape(activeHtmlTextId)}"]`)
      : null;
    htmlBoldActive = doc.queryCommandState('bold')
      || (isIframeHtmlElement(activeNode) && isConvertedNodeBold(activeNode));
    htmlItalicActive = doc.queryCommandState('italic')
      || (isIframeHtmlElement(activeNode) && isConvertedNodeItalic(activeNode));
    htmlUnderlineActive = doc.queryCommandState('underline')
      || (isIframeHtmlElement(activeNode) && /underline/i.test(htmlFrame?.contentWindow?.getComputedStyle(activeNode).textDecorationLine || ''));
    htmlStrikethroughActive = doc.queryCommandState('strikeThrough')
      || (isIframeHtmlElement(activeNode) && /line-through/i.test(htmlFrame?.contentWindow?.getComputedStyle(activeNode).textDecorationLine || ''));
  }

  function saveHtmlSelection() {
    const doc = htmlFrame?.contentDocument;
    const selection = doc?.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = isIframeHtmlElement(container) ? container : container.parentElement;
    if (!element?.closest('.t, .docuflex-textbox-editor')) return;
    savedHtmlSelection = range.cloneRange();
  }

  function restoreHtmlSelection() {
    const doc = htmlFrame?.contentDocument;
    const selection = doc?.getSelection();
    if (!selection || !savedHtmlSelection) return;
    selection.removeAllRanges();
    selection.addRange(savedHtmlSelection);
  }

  /** @param {HTMLElement} node */
  function rememberConvertedHtmlOriginal(node) {
    if (node.dataset.docuflexOriginalText) return;
    node.dataset.docuflexOriginalText = normalizeLineText(node.textContent ?? '');
    node.dataset.docuflexOriginalHtmlText = node.textContent ?? '';
  }

  /** @param {HTMLElement} node */
  function detectedFontForConvertedNode(node) {
    const className = dominantConvertedFontClass(node);
    const fontName = className ? htmlFontNames[className.toLowerCase()] : '';
    const style = htmlFrame?.contentWindow?.getComputedStyle(node);
    const size = style?.fontSize ?? '';
    const weight = style?.fontWeight ?? '';
    const fallback = cleanFontFamilyLabel(style?.fontFamily ?? '');
    return [fontName || fallback, size, weight ? `weight ${weight}` : ''].filter(Boolean).join(' · ');
  }

  /** @param {HTMLElement} node */
  function isConvertedNodeBold(node) {
    const explicitWeight = explicitConvertedWeight(node);
    if (Number.isFinite(explicitWeight)) return explicitWeight >= 600;
    const className = dominantConvertedFontClass(node);
    const fontName = className ? htmlFontNames[className.toLowerCase()] ?? '' : '';
    const computedWeight = Number(htmlFrame?.contentWindow?.getComputedStyle(node)?.fontWeight ?? '400');
    return /bold|black|heavy|semibold|demibold|medium/i.test(fontName) || computedWeight >= 600;
  }

  /** @param {HTMLElement} node */
  function explicitConvertedWeight(node) {
    const own = node.style.fontWeight || node.dataset.docuflexWeight || '';
    const ownNumber = Number.parseFloat(own);
    if (Number.isFinite(ownNumber)) return ownNumber;
    const weightedChild = node.querySelector('[data-docuflex-weight], [style*="font-weight"]');
    if (!(weightedChild instanceof HTMLElement)) return NaN;
    const childNumber = Number.parseFloat(weightedChild.style.fontWeight || weightedChild.dataset.docuflexWeight || '');
    return Number.isFinite(childNumber) ? childNumber : NaN;
  }

  /** @param {HTMLElement} node */
  function isConvertedNodeItalic(node) {
    const className = dominantConvertedFontClass(node);
    const fontName = className ? htmlFontNames[className.toLowerCase()] ?? '' : '';
    const style = htmlFrame?.contentWindow?.getComputedStyle(node)?.fontStyle ?? '';
    return /italic|oblique/i.test(fontName) || /italic|oblique/i.test(style);
  }

  /** @param {MessageEvent} event */
  function handleHtmlEditorMessage(event) {
    if (event.source !== htmlFrame?.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== 'docuflex-html-editor') return;

    if ((data.type === 'activate' || data.type === 'dirty') && data.font) {
      const font = data.font;
      const nextTextId = typeof font.id === 'string' ? font.id : '';
      if (data.type === 'activate' && nextTextId && !htmlOriginalFonts[nextTextId]) {
        const originalValue = typeof font.fontFamily === 'string' ? font.fontFamily : '';
        const originalLabel = detectedFontFromFrameInfo(font).split(' · ')[0] || cleanFontFamilyLabel(originalValue);
        htmlOriginalFonts = { ...htmlOriginalFonts, [nextTextId]: { value: originalValue, label: originalLabel } };
      }
      if (nextTextId) activeHtmlTextId = nextTextId;
      if (data.type === 'activate') {
        activeHtmlTextBoxId = typeof font.textBoxId === 'string' ? font.textBoxId : '';
        htmlBoxSelectionActive = Boolean(font.boxSelection);
        if (htmlBoxSelectionActive) savedHtmlSelection = null;
      }
      // Dirty messages may be delayed and can describe the editor container's
      // inherited style. Only a deliberate selection activation is allowed to
      // replace the panel's current control values.
      if (data.type === 'activate') {
        detectedFont = detectedFontFromFrameInfo(font);
        htmlBoldActive = Boolean(font.bold);
        htmlItalicActive = Boolean(font.italic);
        syncHtmlFormattingFromFrameInfo(font);
      }
    }

    if (data.type === 'deactivate') {
      activeHtmlTextId = '';
      activeHtmlTextBoxId = '';
      htmlBoxSelectionActive = false;
      htmlColorPicker = null;
      savedHtmlSelection = null;
    }

    if (data.type === 'geometry') {
      scheduleHtmlGeometrySync();
      return;
    }

    if (data.type === 'dirty') {
      scheduleHtmlGeometrySync();
      if (Number(data.dirtyCount) > 0) {
        status = `${Number(data.dirtyCount)} HTML text edit${Number(data.dirtyCount) === 1 ? '' : 's'} staged.`;
      }
    }
  }

  /** @param {Record<string, unknown>} font */
  function detectedFontFromFrameInfo(font) {
    const fontClass = typeof font.fontClass === 'string' ? font.fontClass.toLowerCase() : '';
    const mapped = fontClass ? htmlFontNames[fontClass] : '';
    const family = typeof font.fontFamily === 'string'
      ? cleanFontFamilyLabel(font.fontFamily)
      : '';
    const size = typeof font.fontSize === 'string' ? font.fontSize : '';
    const weight = typeof font.fontWeight === 'string' ? font.fontWeight : '';
    return [mapped || family || fontClass || 'PDF font', size, weight ? `weight ${weight}` : '']
      .filter(Boolean)
      .join(' · ');
  }

  function resetHtmlFormattingState() {
    htmlColorPicker = null;
    htmlUnderlineActive = false;
    htmlStrikethroughActive = false;
    htmlFontFamily = '';
    htmlFontSize = 16;
    htmlFontWeight = 400;
    htmlTextColor = '#171717';
    htmlLetterSpacing = 0;
    htmlLineHeight = 19.2;
    htmlTextAlign = 'left';
  }

  /** @param {Record<string, unknown>} font */
  function syncHtmlFormattingFromFrameInfo(font) {
    htmlFontFamily = typeof font.fontFamily === 'string' ? font.fontFamily : '';
    htmlFontSize = Number.parseFloat(typeof font.fontSize === 'string' ? font.fontSize : '') || 16;
    htmlFontWeight = Number.parseFloat(typeof font.fontWeight === 'string' ? font.fontWeight : '') || (font.bold ? 700 : 400);
    htmlLetterSpacing = Number.parseFloat(typeof font.letterSpacing === 'string' ? font.letterSpacing : '') || 0;
    htmlLineHeight = Number.parseFloat(typeof font.lineHeight === 'string' ? font.lineHeight : '') || htmlFontSize * 1.2;
    htmlTextAlign = typeof font.textAlign === 'string' && ['left', 'center', 'right'].includes(font.textAlign)
      ? font.textAlign
      : 'left';
    htmlUnderlineActive = Boolean(font.underline);
    htmlStrikethroughActive = Boolean(font.strikethrough);
    if (Array.isArray(font.color) && font.color.length >= 3) {
      htmlTextColor = `#${font.color.slice(0, 3).map((component) => Math.round(Math.max(0, Math.min(1, Number(component) || 0)) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    }
  }

  /** @param {string} value */
  function normalizeHexColor(value) {
    const compact = String(value || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(compact)) return `#${compact.split('').map((part) => part + part).join('')}`.toUpperCase();
    if (/^[0-9a-f]{6}$/i.test(compact)) return `#${compact}`.toUpperCase();
    return '';
  }

  /** @param {string} color */
  function htmlHexToHsv(color) {
    const hex = normalizeHexColor(color) || '#000000';
    const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
    const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
    const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
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
  function htmlHsvToHex(hue, saturation, value) {
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

  function toggleHtmlColorPicker() {
    htmlColorPicker = htmlColorPicker ? null : htmlHexToHsv(htmlTextColor);
  }

  /** @param {PointerEvent} event @param {'saturation' | 'hue'} control */
  function updateHtmlColorControl(event, control) {
    if (!htmlColorPicker) return;
    const element = /** @type {HTMLElement} */ (event.currentTarget);
    const rect = element.getBoundingClientRect();
    element.setPointerCapture?.(event.pointerId);
    if (control === 'saturation') {
      htmlColorPicker = {
        ...htmlColorPicker,
        saturation: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        value: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
      };
    } else {
      htmlColorPicker = {
        ...htmlColorPicker,
        hue: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 360
      };
    }
    setHtmlTextColor(htmlHsvToHex(htmlColorPicker.hue, htmlColorPicker.saturation, htmlColorPicker.value));
  }

  /**
   * @param {PointerEvent} event
   * @param {number} initialValue
   * @param {(value: number) => void} update
   * @param {{ step?: number; min?: number; max?: number }} [options]
   */
  function startHtmlNumberScrub(event, initialValue, update, options = {}) {
    if (event.button !== 0) return;
    const target = /** @type {HTMLElement} */ (event.currentTarget);
    const startX = event.clientX;
    const step = options.step ?? 1;
    const minimum = options.min ?? -Infinity;
    const maximum = options.max ?? Infinity;
    let dragging = false;
    target.setPointerCapture?.(event.pointerId);
    /** @param {PointerEvent} moveEvent */
    const move = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      if (!dragging && Math.abs(delta) < 2) return;
      dragging = true;
      const raw = Math.max(minimum, Math.min(maximum, initialValue + delta * step));
      const precision = step < 0.1 ? 100 : step < 1 ? 10 : 1;
      update(Math.round(raw * precision) / precision);
      moveEvent.preventDefault();
    };
    /** @param {PointerEvent} endEvent */
    const end = (endEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      if (target.hasPointerCapture?.(endEvent.pointerId)) target.releasePointerCapture(endEvent.pointerId);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  /** @param {Blob} blob @param {string} downloadName */
  function downloadBlob(blob, downloadName) {
    cleanupExportUrl();
    exportUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = exportUrl;
    link.download = downloadName;
    link.click();
  }

  /** @param {string} name */
  function exportedName(name) {
    return name.toLowerCase().endsWith('.pdf') ? name.replace(/\.pdf$/i, '-export.pdf') : `${name}-export.pdf`;
  }

  function cleanupExportUrl() {
    if (exportUrl) {
      URL.revokeObjectURL(exportUrl);
      exportUrl = '';
    }
  }

  onDestroy(() => {
    if (maskFrame) cancelAnimationFrame(maskFrame);
    if (overlayFrame) cancelAnimationFrame(overlayFrame);
    cleanupExportUrl();
    pdfDocument?.destroy?.();
  });

  onMount(() => {
    window.addEventListener('message', handleHtmlEditorMessage);
    void initializeFile();
    return () => window.removeEventListener('message', handleHtmlEditorMessage);
  });
</script>
<svelte:head>
  {@html embeddedFontStyle}
</svelte:head>

<div class="html-editor-shell" aria-live="polite" bind:this={htmlViewport}>
  {#if convertedHtml}
    <iframe
      bind:this={htmlFrame}
      class="html-preview"
      title=""
      aria-label="Document pages"
      srcdoc={convertedHtml}
      sandbox="allow-scripts allow-same-origin"
      onload={prepareConvertedHtmlEditor}
    ></iframe>
    <HtmlAnnotationOverlay pageFrames={overlayPageFrames} annotations={foregroundAnnotations} />
  {:else}
    <div class="html-editor-state">
      <span class="state-mark">{isConvertingHtml ? 'HTML' : '!'}</span>
      <strong>{isConvertingHtml ? 'Building editable document…' : 'Could not open the editable document'}</strong>
      <span>{status}</span>
      {#if !isConvertingHtml}
        <button type="button" onclick={convertToHtmlLayer}>Try again</button>
      {/if}
    </div>
  {/if}

  {#if convertedHtml && activeTool === 'edit' && activeHtmlTextId}
    <div class="text-properties-panel" role="dialog" aria-label="Selected text properties">
      <header class="text-properties-header">
        <img src="/toolbar/small/edit.svg" alt="" />
        <h2>Edit text</h2>
        <button class="text-properties-close" type="button" aria-label="Close properties" onclick={() => activeHtmlTextId = ''}>
          <span></span><span></span>
        </button>
      </header>
      <div class="text-properties-scroll">
        <section class="typography-section" aria-label="Typography">
          <div class="typography-color-row">
            <span>Color</span>
            <input aria-label="Text color hex" value={htmlTextColor.replace('#', '')} oninput={(event) => setHtmlTextColor(event.currentTarget.value)} />
            <button class:active={Boolean(htmlColorPicker)} class="property-color" type="button" style:--property-color={htmlTextColor} aria-label="Open text color picker" onclick={toggleHtmlColorPicker}></button>
          </div>
          <label class="typography-select-row">
            <span>Font</span>
            <select value={htmlFontFamily} onchange={(event) => setHtmlFontFamily(event.currentTarget.value)}>
              {#if htmlOriginalFonts[activeHtmlTextId]?.value}
                <option value={htmlOriginalFonts[activeHtmlTextId].value}>{htmlOriginalFonts[activeHtmlTextId].label}</option>
              {/if}
              <option value="Open Sans">Open Sans</option>
              <option value="Helvetica">Helvetica</option>
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
              <select value={String(htmlFontWeight)} onchange={(event) => setHtmlFontWeight(Number(event.currentTarget.value))}>
                <option value="300">Light</option>
                <option value="400">Regular</option>
                <option value="500">Medium</option>
                <option value="600">Semibold</option>
                <option value="700">Bold</option>
                <option value="800">Extra Bold</option>
              </select>
            </label>
            <label class="inspector-field typography-size-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startHtmlNumberScrub(event, htmlFontSize, setHtmlFontSize, { step: 0.1, min: 1, max: 400 })}>Size</span><input class="scrubbable-number" type="number" min="1" max="400" step="0.5" value={htmlFontSize} onpointerdown={(event) => startHtmlNumberScrub(event, htmlFontSize, setHtmlFontSize, { step: 0.1, min: 1, max: 400 })} oninput={(event) => setHtmlFontSize(Number(event.currentTarget.value))} /></label>
          </div>
          <div class="typography-spacing-grid">
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startHtmlNumberScrub(event, htmlLetterSpacing, (value) => { htmlLetterSpacing = value; updateHtmlTextStyle('letterSpacing', `${value}px`); }, { step: 0.05, min: -20, max: 100 })}>Letter</span><input class="scrubbable-number" type="number" min="-20" max="100" step="0.1" value={htmlLetterSpacing} onpointerdown={(event) => startHtmlNumberScrub(event, htmlLetterSpacing, (value) => { htmlLetterSpacing = value; updateHtmlTextStyle('letterSpacing', `${value}px`); }, { step: 0.05, min: -20, max: 100 })} oninput={(event) => { htmlLetterSpacing = Number(event.currentTarget.value); updateHtmlTextStyle('letterSpacing', `${htmlLetterSpacing}px`); }} /></label>
            <label class="inspector-field"><span class="scrub-label" role="presentation" onpointerdown={(event) => startHtmlNumberScrub(event, htmlLineHeight, (value) => { htmlLineHeight = value; updateHtmlTextStyle('lineHeight', `${value}px`); }, { step: 0.1, min: 1, max: 500 })}>Line</span><input class="scrubbable-number" type="number" min="1" max="500" step="0.5" value={htmlLineHeight} onpointerdown={(event) => startHtmlNumberScrub(event, htmlLineHeight, (value) => { htmlLineHeight = value; updateHtmlTextStyle('lineHeight', `${value}px`); }, { step: 0.1, min: 1, max: 500 })} oninput={(event) => { htmlLineHeight = Number(event.currentTarget.value); updateHtmlTextStyle('lineHeight', `${htmlLineHeight}px`); }} /></label>
          </div>
          <div class="typography-alignment-row full-width-alignment">
            <div class="typography-segments" aria-label="Horizontal text alignment">
              <button class:active={htmlTextAlign === 'left'} type="button" title="Align left" onclick={() => { htmlTextAlign = 'left'; alignHtmlSelection('left'); }}><img src="/align/align-left.svg" alt="" /></button>
              <button class:active={htmlTextAlign === 'center'} type="button" title="Align center" onclick={() => { htmlTextAlign = 'center'; alignHtmlSelection('center'); }}><img src="/align/align-center.svg" alt="" /></button>
              <button class:active={htmlTextAlign === 'right'} type="button" title="Align right" onclick={() => { htmlTextAlign = 'right'; alignHtmlSelection('right'); }}><img src="/align/align-right.svg" alt="" /></button>
            </div>
          </div>
          <div class="typography-style-row" aria-label="Text styles">
            <button class:active={htmlBoldActive} type="button" title="Bold" onclick={toggleHtmlBoldSelection}><b>B</b></button>
            <button class:active={htmlItalicActive} type="button" title="Italic" onclick={toggleHtmlItalicSelection}><i>I</i></button>
            <button class:active={htmlUnderlineActive} type="button" title="Underline" onclick={toggleHtmlUnderlineSelection}><u>U</u></button>
            <button class:active={htmlStrikethroughActive} type="button" title="Strikethrough" onclick={toggleHtmlStrikethroughSelection}><s>S</s></button>
          </div>
        </section>
      </div>
    </div>
    {#if htmlColorPicker}
      {@const pickerHex = htmlHsvToHex(htmlColorPicker.hue, htmlColorPicker.saturation, htmlColorPicker.value)}
      <div class="figma-color-picker html-text-color-picker" role="dialog" aria-label="Color picker">
        <div class="color-saturation" style:--picker-hue={`hsl(${htmlColorPicker.hue} 100% 50%)`} role="slider" aria-label="Color saturation and brightness" aria-valuenow={Math.round(htmlColorPicker.saturation * 100)} tabindex="0" onpointerdown={(event) => updateHtmlColorControl(event, 'saturation')} onpointermove={(event) => { if (event.buttons) updateHtmlColorControl(event, 'saturation'); }}>
          <span style:left={`${htmlColorPicker.saturation * 100}%`} style:top={`${(1 - htmlColorPicker.value) * 100}%`} style:--thumb-color={pickerHex}></span>
        </div>
        <div class="picker-slider hue-slider" role="slider" aria-label="Hue" aria-valuenow={Math.round(htmlColorPicker.hue)} tabindex="0" onpointerdown={(event) => updateHtmlColorControl(event, 'hue')} onpointermove={(event) => { if (event.buttons) updateHtmlColorControl(event, 'hue'); }}>
          <span style:left={`${htmlColorPicker.hue / 360 * 100}%`} style:--thumb-color={pickerHex}></span>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .html-editor-shell {
    position: absolute;
    inset: 0;
    min-height: 0;
    overflow: hidden;
    background: #f5f5f5;
    scrollbar-width: none;
  }

  .html-editor-shell::-webkit-scrollbar {
    display: none;
  }

  .html-preview {
    position: absolute;
    z-index: 1;
    top: 0;
    left: 50%;
    display: block;
    width: 100%;
    min-height: 100%;
    border: 0;
    background: #f5f5f5;
  }

  .html-editor-state {
    display: grid;
    place-items: center;
    align-content: center;
    gap: 10px;
    width: 100%;
    height: 100%;
    padding: 32px;
    color: #343434;
    text-align: center;
  }

  .html-editor-state span:last-of-type {
    max-width: 560px;
    color: #6b6b6b;
    font-size: 13px;
  }

  .state-mark {
    display: grid;
    place-items: center;
    width: 54px;
    height: 54px;
    border-radius: 15px;
    background: white;
    color: #1495ff;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.09);
    font-weight: 700;
  }

  .html-editor-state button {
    margin-top: 4px;
    padding: 8px 14px;
    border: 1px solid #cfcfcf;
    border-radius: 9px;
    background: white;
    cursor: pointer;
  }

  .text-properties-panel {
    position: absolute;
    z-index: 40;
    top: 20px;
    /* The editor layer compensates for the app shell's 0.85 UI zoom. Keep
       this panel inside the portion of that enlarged layer that is visible. */
    right: calc(15% + 18px);
    display: grid;
    grid-template-rows: 50px 1fr;
    box-sizing: border-box;
    width: min(320px, calc(100% - 36px));
    max-height: calc(100% - 40px);
    overflow: hidden;
    border: 1.5px solid #c5c5c5;
    border-radius: 13px;
    background: #fafafa;
    box-shadow: 0 9px 24px rgba(0, 0, 0, 0.07);
    color: #000;
    font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
  }

  .text-properties-header {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) 28px;
    align-items: center;
    box-sizing: border-box;
    min-width: 0;
    height: 50px;
    padding: 0 12px;
    border-bottom: 1px solid #cacaca;
    background: #eeeeee;
  }

  .text-properties-header > img {
    width: 23px;
    height: 23px;
    opacity: 0.72;
    filter: brightness(0);
  }

  .text-properties-header h2 {
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

  .text-properties-close {
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

  .text-properties-close:active { transform: scale(0.94); }

  .text-properties-close span {
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

  .text-properties-close span + span { transform: rotate(-45deg); }
  .text-properties-close:hover span { background: #000; }

  .text-properties-scroll {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }

  .typography-section {
    display: grid;
    gap: 9px;
    padding: 16px 18px;
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
  .typography-select-row > span { padding-left: 10px; color: #7a7a7a; }

  .typography-color-row > input,
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

  .typography-select-row { grid-template-columns: 74px minmax(0, 1fr); }
  .typography-select-row select { cursor: pointer; text-align-last: right; appearance: none; }

  .property-color {
    display: block;
    box-sizing: border-box;
    width: 24px;
    height: 24px;
    margin: 0 7px;
    padding: 0;
    border: 1px solid rgba(0, 0, 0, 0.16);
    border-radius: 8px;
    background: var(--property-color);
    cursor: pointer;
    transition: box-shadow 150ms ease, transform 150ms ease;
  }

  .property-color:hover,
  .property-color.active { box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px #1684f8; }

  .figma-color-picker {
    position: absolute;
    z-index: 41;
    top: 88px;
    right: calc(15% + 356px);
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
    background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--picker-hue));
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

  .picker-slider { position: relative; height: 18px; border-radius: 999px; cursor: ew-resize; touch-action: none; }
  .picker-slider > span { top: 50%; }
  .hue-slider { background: linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }

  .typography-weight-size-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(0, 0.9fr);
    gap: 9px;
  }

  .compact-weight-row { grid-template-columns: 67px minmax(0, 1fr); }

  .inspector-field {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
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
  }

  .inspector-field:focus-within { border-color: #1684f8; background: #fff; box-shadow: 0 0 0 1px rgba(22, 132, 248, 0.13); }
  .inspector-field input { min-width: 0; width: 100%; padding-left: 7px; border: 0; outline: 0; background: transparent; color: #111; font: inherit; appearance: textfield; text-align: right; }
  .inspector-field input::-webkit-inner-spin-button,
  .inspector-field input::-webkit-outer-spin-button { margin: 0; -webkit-appearance: none; }
  .scrub-label,
  .scrubbable-number { cursor: ew-resize; }
  .scrub-label { user-select: none; }
  .typography-size-field { padding-inline: 9px; }

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

  .typography-alignment-row.full-width-alignment { display: block; }
  .full-width-alignment .typography-segments { width: 100%; }

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
  }

  .typography-segments button:first-child,
  .typography-style-row button:first-child { border-left: 0; }
  .typography-segments button:hover,
  .typography-style-row button:hover { color: #111; background: #ededed; }
  .typography-segments button.active,
  .typography-style-row button.active { color: #fff; background: #111; }
  .typography-segments img { display: block; width: 21px; height: 21px; object-fit: contain; }
  .typography-segments button.active img { filter: brightness(0) invert(1); }
  .typography-style-row { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 2px; }

  @media (prefers-reduced-motion: no-preference) {
    .text-properties-panel { animation: text-properties-in 240ms cubic-bezier(0.22, 1, 0.36, 1); }
  }

  @keyframes text-properties-in {
    from { opacity: 0; transform: translateX(18px); }
    to { opacity: 1; transform: translateX(0); }
  }
</style>
