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
  let htmlBoldActive = false;
  let htmlItalicActive = false;
  /** @type {{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null} */
  let htmlPanStart = null;
  let htmlShiftPressed = false;
  /** @type {Range | null} */
  let savedHtmlSelection = null;

  const scale = 1.35;
  const minZoom = 0.5;
  const maxZoom = 4;
  const clickZoomFactor = 1.25;
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
    detectedFont = '';
    activeHtmlTextId = '';
    htmlBoldActive = false;
    htmlItalicActive = false;
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
    detectedFont = '';
    activeHtmlTextId = '';
    htmlBoldActive = false;
    htmlItalicActive = false;
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

  /**
   * Applies the currently staged HTML text changes to a PDF and returns its bytes.
   * The parent editor can then apply marker, pen, highlight, and shape annotations.
   * @param {ArrayBuffer | null} [sourceBytes]
   */
  export async function applyTextEdits(sourceBytes = pdfBytes) {
    if (!sourceBytes) throw new Error('The source PDF is not available.');
    htmlFrame?.contentDocument?.body?.normalize();
    const htmlEdits = await collectConvertedHtmlEdits();
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
        id: typeof edit.id === 'string' ? edit.id : `html-frame-${index}`,
        page: Number.isFinite(Number(edit.page)) ? Number(edit.page) : 0,
        occurrence: Number.isFinite(Number(edit.occurrence)) ? Number(edit.occurrence) : -1,
        rect: Array.isArray(edit.rect) ? edit.rect.map(Number).filter(Number.isFinite) : [],
        alignRect: Array.isArray(edit.alignRect) ? edit.alignRect.map(Number).filter(Number.isFinite) : [],
        visualRect: Array.isArray(edit.visualRect) ? edit.visualRect.map(Number).filter(Number.isFinite) : [],
        originalRect: Array.isArray(edit.originalRect) ? edit.originalRect.map(Number).filter(Number.isFinite) : [],
        pageSize: Array.isArray(edit.pageSize) ? edit.pageSize.map(Number).filter(Number.isFinite) : [],
        fontSize: Number.isFinite(Number(edit.fontSize)) ? Number(edit.fontSize) : 0,
        fontName: resolvedFrameFontName(edit),
        bold: Boolean(edit.bold),
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
      color,
      bold: Number.isFinite(explicitWeight) ? explicitWeight >= 600 : computedWeight >= 600 || familyLooksBold,
      italic: /italic|oblique/i.test(style.fontFamily) || /italic|oblique/i.test(style.fontStyle)
    };
  };
  const docuflexActivate = (target) => {
    const targetBox = docuflexTextBoxNode(target);
    if (targetBox && !target?.closest?.('.docuflex-textbox-handle, .docuflex-textbox-resize')) {
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
      return docuflexOpenTextBoxEditor(promotedBox, 'preserve');
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
    parent.postMessage({
      source: 'docuflex-html-editor',
      type: 'activate',
      font: docuflexFontInfo(lines[0])
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
    return explicitlyAligned || Boolean(docuflexTextBoxRowAlignment(row)) || row.dataset.docuflexBullet === 'true' || row.dataset.docuflexBullet === 'false';
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
  const docuflexTextBoxLineEdit = (box, line, newText, index, moved, row) => {
    const node = document.querySelector('[data-docuflex-edit-id="' + CSS.escape(String(line.id || '')) + '"]');
    if (!(node instanceof HTMLElement)) return null;
    const oldText = docuflexNormalizeText(line.text || '');
    const replacement = docuflexNormalizeText(newText || '');
    const alignment = docuflexTextBoxRowAlignment(row);
    const overlay = !moved && (alignment === 'center' || alignment === 'right');
    if (!oldText || (!moved && !overlay && oldText === replacement)) return null;
    const movedRect = moved ? docuflexMovedTextBoxRect(box, node) : [];
    const baseRect = movedRect.length
      ? movedRect
      : docuflexRect(node);
    const exportRect = baseRect;
    const alignRect = overlay ? docuflexTextBoxAlignRect(box, node) : [];
    const visualRect = overlay ? docuflexVisualTextRect(row, node) : [];
    const originalRect = docuflexRect(node);
    const exportFontNode = (moved || overlay) && row instanceof HTMLElement ? row : node;
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
        const rect = page?.getBoundingClientRect();
        return rect ? [rect.width, rect.height] : [];
      })(),
      fontSize: Number.parseFloat(getComputedStyle(exportFontNode).fontSize || '0') || 0,
      fontClass: docuflexFontInfo(node).fontClass,
      fontFamily: docuflexFontInfo(node).fontFamily,
      bold: docuflexFontInfo(node).bold,
      color: docuflexFontInfo(node).color,
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
    const formattedRows = docuflexFormattedTextBoxRows(rows);
    if (!moved && !box.classList.contains('docuflex-editor-open') && !formattedRows) return [];
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
      const edit = docuflexTextBoxLineEdit(box, line, replacement, index, moved, row);
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
    if (!pageRect.width || !pageRect.height || !rect.width || !rect.height || text.length <= 1) return null;
    const style = getComputedStyle(node);
    const left = Math.min(rect.left, contentRect.left || rect.left) - pageRect.left;
    const top = Math.min(rect.top, contentRect.top || rect.top) - pageRect.top;
    const right = Math.max(rect.right, contentRect.right || rect.right) - pageRect.left;
    const bottom = Math.max(rect.bottom, contentRect.bottom || rect.bottom) - pageRect.top;
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
      width: Math.max(rect.width, contentRect.width || 0),
      height: Math.max(rect.height, contentRect.height || 0),
      fontSize: rect.height,
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
    if (index < 0) return null;
    let start = index;
    let end = index;
    while (start > 0 && docuflexLooseTextFlow(lines[start - 1], lines[start])) start -= 1;
    while (end < lines.length - 1 && docuflexLooseTextFlow(lines[end], lines[end + 1])) end += 1;
    const group = lines.slice(start, end + 1);
    const candidates = group.length >= 2 ? group : [lines[index]].filter(docuflexSingleLineBoxCandidate);
    if (!candidates.length) return null;
    const boxIndex = document.querySelectorAll('.docuflex-textbox').length;
    docuflexCreateTextBox(candidates, boxIndex);
    return docuflexTextBoxForLine(node);
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
    if (!(page instanceof HTMLElement) || lines.length < 1) return;
    const pageHeight = page.getBoundingClientRect().height || 0;
    if (pageHeight > 0) {
      const first = lines[0];
      const last = lines[lines.length - 1];
      const headerToBody = first.top < pageHeight * 0.16 && last.top > pageHeight * 0.22;
      if (headerToBody) return;
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
    const contentSlack = lines.length > 1
      ? Math.max(boxPad * 3, Math.min(180, (right - left) * 0.18))
      : Math.max(boxPad * 1.2, Math.min(28, (right - left) * 0.04));
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
    handle.className = 'docuflex-textbox-handle';
    handle.contentEditable = 'false';
    handle.textContent = '';
    const resize = document.createElement('span');
    resize.className = 'docuflex-textbox-resize';
    resize.contentEditable = 'false';
    resize.textContent = '';
    const editor = document.createElement('div');
    editor.className = 'docuflex-textbox-editor';
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.setAttribute('role', 'textbox');
    editor.style.padding = padTop + 'px ' + padRight + 'px ' + padBottom + 'px ' + padLeft + 'px';
    editor.textContent = lines.map((line) => line.text).join(' ');
    box.append(handle, resize, editor);
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
    box.classList.add('docuflex-textbox-preview');
    docuflexAlignTextBoxEditor(box, true);
    docuflexSetTextBoxLinesHidden(box, true);
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      drag = {
        x: event.clientX,
        y: event.clientY,
        left: Number.parseFloat(box.style.left || '0') || 0,
        top: Number.parseFloat(box.style.top || '0') || 0
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
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
    let resizeDrag = null;
    resize.addEventListener('pointerdown', (event) => {
      resizeDrag = {
        x: event.clientX,
        y: event.clientY,
        width: box.getBoundingClientRect().width,
        height: box.getBoundingClientRect().height
      };
      resize.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    resize.addEventListener('pointermove', (event) => {
      if (!resizeDrag) return;
      const pageWidth = page.getBoundingClientRect().width || 0;
      const rightLimit = pageWidth > 0 ? pageWidth * 0.97 : 0;
      const left = Number.parseFloat(box.style.left || '0') || 0;
      const maxWidth = rightLimit > 0 ? Math.max(24, rightLimit - left) : Infinity;
      box.style.width = Math.min(maxWidth, Math.max(24, resizeDrag.width + event.clientX - resizeDrag.x)) + 'px';
      box.style.minHeight = Math.max(12, resizeDrag.height + event.clientY - resizeDrag.y) + 'px';
      docuflexBeginTextBoxVisualEditing(box);
      docuflexOpenTextBoxEditor(box, 'preserve');
      docuflexGrowTextBoxToEditor(box);
      parent.postMessage({ source: 'docuflex-html-editor', type: 'geometry' }, '*');
      event.preventDefault();
    });
    resize.addEventListener('pointerup', (event) => {
      resizeDrag = null;
      resize.releasePointerCapture(event.pointerId);
      parent.postMessage({ source: 'docuflex-html-editor', type: 'geometry' }, '*');
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
      const groupedLines = new Set(groups.flat());
      groups.forEach((group) => docuflexCreateTextBox(group, boxIndex++));
      lines
        .filter((line) => !groupedLines.has(line) && docuflexSingleLineBoxCandidate(line))
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
  const docuflexCollectEdits = () => [
    ...docuflexCollectTextBoxEdits(),
    ...Array.from(document.querySelectorAll('.t[data-docuflex-edit-id]')).flatMap((node, index) => {
    const groupBox = node.dataset.docuflexGrouped === 'true' ? docuflexTextBoxForLine(node) : null;
    if (groupBox?.classList?.contains('docuflex-editor-open')) return [];
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
        const rect = page?.getBoundingClientRect();
        return rect ? [rect.width, rect.height] : [];
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
  })];
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
    }, 300);
  };
  window.__docuflexCollectEdits = docuflexCollectEdits;
  window.__docuflexRebaseEdits = docuflexRebaseEdits;
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
    requestAnimationFrame(docuflexHideDuplicatePageBackdrops);
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
    addEventListener('load', () => docuflexBuildTextBoxes(), { once: true });
    addEventListener('scroll', () => docuflexScheduleTextBoxBuild(null, 120), { passive: true });
    addEventListener('resize', () => docuflexScheduleTextBoxBuild(null, 160), { passive: true });
    document.addEventListener('pointerdown', (event) => {
      const node = docuflexActivate(event.target);
      if (node) node.focus({ preventScroll: true });
    }, true);
    document.addEventListener('click', (event) => docuflexActivate(event.target), true);
    document.addEventListener('focusin', (event) => docuflexActivate(event.target), true);
    document.addEventListener('keyup', (event) => docuflexActivate(event.target), true);
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
  html {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: auto;
    background: #e9e9e9;
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
    background: #e9e9e9;
  }
  #sidebar, #outline, .loading-indicator {
    display: none !important;
  }
  #page-container {
    position: relative !important;
    top: auto !important;
    right: auto !important;
    bottom: auto !important;
    left: 0 !important;
    width: 100% !important;
    min-width: 100%;
    margin: 0;
    padding: 0;
    overflow: visible !important;
    background: transparent !important;
    background-image: none !important;
  }
  .pf {
    margin: 0 auto var(--docuflex-page-margin, 22.222px) !important;
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
    outline: 1px dashed rgba(45, 87, 128, 0.34);
    outline-offset: 2px;
  }
  .t:hover { outline-color: rgba(45, 87, 128, 0.7); }
  .t:focus, .t.docuflex-live-edit {
    outline: 2px solid rgba(47, 137, 255, 0.9);
    box-shadow: 0 0 0 2px rgba(13,90,167,.16);
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
  .docuflex-textbox {
    position: absolute;
    z-index: 6 !important;
    box-sizing: border-box;
    min-width: 24px;
    min-height: 12px;
    pointer-events: none !important;
    outline: 1px dashed rgba(45, 87, 128, 0.22);
    outline-offset: 2px;
    background: transparent;
  }
  .docuflex-textbox:hover {
    outline-color: rgba(45, 87, 128, 0.58);
  }
  .docuflex-textbox.docuflex-active,
  .docuflex-textbox.docuflex-live-edit {
    outline: 2px solid rgba(47, 137, 255, 0.9);
    box-shadow: 0 0 0 2px rgba(13,90,167,.16);
  }
  .docuflex-textbox-editor {
    position: absolute;
    inset: 0;
    display: none;
    box-sizing: border-box;
    min-height: inherit;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    outline: none;
    caret-color: #0d5aa7;
    pointer-events: auto !important;
  }
  .docuflex-textbox-rich-line {
    display: block;
    margin: 0;
    padding: 0;
    min-height: 1em;
    white-space: pre-wrap;
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
  .docuflex-textbox-handle {
    position: absolute;
    top: -9px;
    left: -9px;
    width: 10px;
    height: 10px;
    border: 1px solid rgba(47, 137, 255, 0.85);
    background: rgba(255, 255, 255, 0.95);
    cursor: move;
    opacity: 0;
    pointer-events: auto !important;
  }
  .docuflex-textbox:hover .docuflex-textbox-handle,
  .docuflex-textbox.docuflex-active .docuflex-textbox-handle,
  .docuflex-textbox.docuflex-live-edit .docuflex-textbox-handle {
    opacity: 1;
  }
  .docuflex-textbox-resize {
    position: absolute;
    right: -7px;
    bottom: -7px;
    width: 12px;
    height: 12px;
    border-right: 2px solid rgba(47, 137, 255, 0.9);
    border-bottom: 2px solid rgba(47, 137, 255, 0.9);
    cursor: nwse-resize;
    opacity: 0;
    pointer-events: auto !important;
  }
  .docuflex-textbox:hover .docuflex-textbox-resize,
  .docuflex-textbox.docuflex-active .docuflex-textbox-resize,
  .docuflex-textbox.docuflex-live-edit .docuflex-textbox-resize {
    opacity: 1;
  }
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
    htmlFrame.style.zoom = '';
    htmlFrame.style.width = `${100 / frameScale}%`;
    htmlFrame.style.height = `${100 / frameScale}%`;
    htmlFrame.style.transform = `translateX(-50%) scale(${frameScale})`;
    htmlFrame.style.transformOrigin = 'top center';
    doc.documentElement.style.setProperty('--docuflex-viewer-padding-top', `${36 / frameScale}px`);
    doc.documentElement.style.setProperty('--docuflex-viewer-padding-right', `${48 / frameScale}px`);
    doc.documentElement.style.setProperty('--docuflex-viewer-padding-bottom', `${80 / frameScale}px`);
    doc.documentElement.style.setProperty('--docuflex-page-margin', `${30 / scale}px`);
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
        let paths = group.querySelectorAll(':scope > path');
        if (paths.length !== 2) {
          group.replaceChildren();
          group.append(doc.createElementNS(svgNamespace, 'path'), doc.createElementNS(svgNamespace, 'path'));
          paths = group.querySelectorAll(':scope > path');
        }
        const edge = paths[0];
        edge.setAttribute('d', pathData);
        edge.setAttribute('fill', 'none');
        edge.setAttribute('stroke', '#f4cd19');
        edge.setAttribute('stroke-width', '0.022');
        edge.setAttribute('stroke-linecap', 'round');
        edge.setAttribute('stroke-linejoin', 'round');
        edge.setAttribute('opacity', '0.13');
        const ink = paths[1];
        ink.setAttribute('d', pathData);
        ink.setAttribute('fill', 'none');
        ink.setAttribute('stroke', '#ffe43b');
        ink.setAttribute('stroke-width', '0.0175');
        ink.setAttribute('stroke-linecap', 'round');
        ink.setAttribute('stroke-linejoin', 'round');
        ink.setAttribute('opacity', '0.34');
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
    const pageElements = [...doc.querySelectorAll('.pf')].filter((page) => page.nodeType === 1);
    const lastPage = pageElements.at(-1);
    if (!pageContainer || pageContainer.nodeType !== 1 || !lastPage || lastPage.nodeType !== 1) return;
    const htmlPageContainer = /** @type {HTMLElement} */ (pageContainer);
    const htmlLastPage = /** @type {HTMLElement} */ (lastPage);
    const requiredHeight = htmlLastPage.offsetTop + htmlLastPage.offsetHeight + 60 / (scale * zoomLevel);
    htmlPageContainer.style.minHeight = `${Math.ceil(requiredHeight)}px`;
    let scrollTail = doc.getElementById('docuflex-html-scroll-tail');
    if (!scrollTail || scrollTail.nodeType !== 1) {
      scrollTail = doc.createElement('div');
      scrollTail.id = 'docuflex-html-scroll-tail';
      scrollTail.setAttribute('aria-hidden', 'true');
      htmlPageContainer.insertAdjacentElement('afterend', scrollTail);
    }
    const htmlScrollTail = /** @type {HTMLElement} */ (scrollTail);
    htmlScrollTail.style.height = `${Math.max(80 / (scale * zoomLevel), (htmlFrame?.contentWindow?.innerHeight ?? 0) * 0.55)}px`;
    htmlScrollTail.style.pointerEvents = 'none';
  }

  function syncOverlayPageFrames() {
    const doc = htmlFrame?.contentDocument;
    if (!doc || !htmlFrame || !htmlViewport) {
      overlayPageFrames = [];
      return;
    }
    const frameScale = scale * zoomLevel;
    overlayPageFrames = [...doc.querySelectorAll('.pf')].flatMap((page, index) => {
      if (page.nodeType !== 1) return [];
      const htmlPage = /** @type {HTMLElement} */ (page);
      const rect = htmlPage.getBoundingClientRect();
      const pageNumber = Number(htmlPage.dataset.pageNo || index + 1);
      return [{
        page: Math.max(0, pageNumber - 1),
        left: rect.left * frameScale,
        top: rect.top * frameScale,
        width: rect.width * frameScale,
        height: rect.height * frameScale
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
    if (!scroller) return;
    const nextZoom = Math.min(maxZoom, Math.max(minZoom, requestedZoom));
    if (Math.abs(nextZoom - zoomLevel) < 0.001) return;
    const oldScale = scale * zoomLevel;
    const nextScale = scale * nextZoom;
    const contentX = scroller.scrollLeft + clientX;
    const contentY = scroller.scrollTop + clientY;
    zoomLevel = nextZoom;
    applyHtmlViewportStyles();
    scroller.scrollLeft = contentX - clientX * oldScale / nextScale;
    scroller.scrollTop = contentY - clientY * oldScale / nextScale;
  }

  /** @param {WheelEvent} event */
  function handleHtmlWheel(event) {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 100 : 1;
    zoomHtmlAt(zoomLevel * Math.exp(-event.deltaY * deltaScale * 0.002), event.clientX, event.clientY);
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
    if (wrapper instanceof HTMLElement) {
      wrapper.dataset.docuflexEditId = node.dataset.docuflexEditId ?? '';
      wrapper.dataset.docuflexOriginalText = node.dataset.docuflexOriginalText ?? '';
      wrapper.dataset.docuflexOriginalHtmlText = node.dataset.docuflexOriginalHtmlText ?? '';
      wrapper.contentEditable = 'false';
      wrapper.spellcheck = false;
    }
  }

  /** @param {EventTarget | null} target */
  function activateConvertedHtmlFromTarget(target) {
    if (!(target instanceof Element)) return null;
    const node = findConvertedHtmlNode(target);
    if (!node) return null;
    activeHtmlTextId = node.dataset.docuflexEditId ?? '';
    detectedFont = detectedFontForConvertedNode(node);
    htmlBoldActive = isConvertedNodeBold(node);
    saveHtmlSelection();
    syncHtmlFormatState();
    return node;
  }

  /** @param {Element} target */
  function findConvertedHtmlNode(target) {
    const direct = target.closest('.t');
    if (direct instanceof HTMLElement) return direct;
    const wrapper = target.closest('[data-docuflex-edit-id]');
    if (wrapper instanceof HTMLElement) {
      const child = wrapper.matches('.t') ? wrapper : wrapper.querySelector('.t');
      if (child instanceof HTMLElement) return child;
    }
    const clip = target.closest('.c');
    const clipText = clip?.querySelector('.t');
    return clipText instanceof HTMLElement ? clipText : null;
  }

  /** @param {'bold' | 'italic'} command */
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
    if (activeNode instanceof HTMLElement) {
      activeNode.classList.add('docuflex-live-edit');
    }
  }

  function toggleHtmlBoldSelection() {
    const nextBold = !htmlBoldActive;
    const weight = nextBold ? '700' : '400';
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    htmlFrame?.contentWindow?.focus();

    try {
      const setBold = htmlFrame?.contentWindow
        ? /** @type {{ __docuflexSetBold?: (bold: boolean) => void }} */ (htmlFrame.contentWindow).__docuflexSetBold
        : null;
      if (typeof setBold === 'function') {
        restoreHtmlSelection();
        setBold(nextBold);
        htmlBoldActive = nextBold;
        return;
      }
    } catch {
      // Fall back to direct node styling below.
    }

    const activeNode = activeHtmlTextId
      ? doc.querySelector(`[data-docuflex-edit-id="${CSS.escape(activeHtmlTextId)}"]`)
      : null;
    if (activeNode instanceof HTMLElement) {
      activeNode.style.fontWeight = weight;
      activeNode.classList.add('docuflex-live-edit');
      htmlBoldActive = nextBold;
      detectedFont = detectedFontForConvertedNode(activeNode);
    }
  }

  function selectedHtmlTextboxRows() {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return [];
    restoreHtmlSelection();
    const selection = doc.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const container = range?.commonAncestorContainer;
    const element = container
      ? (container.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (container) : container.parentElement)
      : doc.activeElement;
    const editor = element?.closest?.('.docuflex-textbox-editor')
      || doc.activeElement?.closest?.('.docuflex-textbox-editor');
    if (!editor || editor.nodeType !== Node.ELEMENT_NODE) return [];
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
      htmlBox.classList.add('docuflex-live-edit', 'docuflex-editor-open');
      htmlBox.dataset.docuflexVisualEditing = 'true';
    }
    const EventCtor = doc.defaultView?.Event || Event;
    editor?.dispatchEvent(new EventCtor('input', { bubbles: true }));
    syncHtmlFormatState();
  }

  /** @param {'left' | 'center' | 'right'} alignment */
  function alignHtmlSelection(alignment) {
    const doc = htmlFrame?.contentDocument;
    if (!doc) return;
    htmlFrame?.contentWindow?.focus();
    const rows = selectedHtmlTextboxRows();
    if (rows.length) {
      const editor = rows[0].closest('.docuflex-textbox-editor');
      if (editor instanceof HTMLElement) {
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
      || (activeNode instanceof HTMLElement && isConvertedNodeBold(activeNode));
    htmlItalicActive = doc.queryCommandState('italic')
      || (activeNode instanceof HTMLElement && isConvertedNodeItalic(activeNode));
  }

  function saveHtmlSelection() {
    const doc = htmlFrame?.contentDocument;
    const selection = doc?.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container instanceof HTMLElement ? container : container.parentElement;
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
      activeHtmlTextId = typeof font.id === 'string' ? font.id : '';
      detectedFont = detectedFontFromFrameInfo(font);
      htmlBoldActive = Boolean(font.bold);
      htmlItalicActive = Boolean(font.italic);
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

  {#if convertedHtml && activeTool === 'edit'}
    <div class="html-format-toolbar" role="toolbar" aria-label="Text formatting">
      <button
        class:active={htmlBoldActive}
        type="button"
        onclick={toggleHtmlBoldSelection}
        disabled={!activeHtmlTextId}
        title="Bold"
        aria-label="Bold"
        aria-pressed={htmlBoldActive}
      >B</button>
      <button
        class:active={htmlItalicActive}
        type="button"
        onclick={() => formatHtmlSelection('italic')}
        disabled={!activeHtmlTextId}
        title="Italic"
        aria-label="Italic"
        aria-pressed={htmlItalicActive}
      ><em>I</em></button>
      <span class="toolbar-divider"></span>
      <button type="button" onclick={() => alignHtmlSelection('left')} disabled={!activeHtmlTextId} title="Align left" aria-label="Align left">≡</button>
      <button type="button" onclick={() => alignHtmlSelection('center')} disabled={!activeHtmlTextId} title="Align center" aria-label="Align center">☰</button>
      <button type="button" onclick={() => alignHtmlSelection('right')} disabled={!activeHtmlTextId} title="Align right" aria-label="Align right">≣</button>
      <button type="button" onclick={toggleHtmlListSelection} disabled={!activeHtmlTextId} title="Bulleted list" aria-label="Bulleted list">•</button>
      <span class="font-status">{detectedFont || 'Click text to edit'}</span>
    </div>
  {/if}
</div>

<style>
  .html-editor-shell {
    position: absolute;
    inset: 0;
    min-height: 0;
    overflow: hidden;
    background: #e9e9e9;
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
    background: #e9e9e9;
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

  .html-format-toolbar {
    position: absolute;
    z-index: 5;
    top: 14px;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: calc(100% - 28px);
    min-height: 38px;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 5px 18px rgba(0, 0, 0, 0.13);
    transform: translateX(-50%);
    backdrop-filter: blur(16px);
  }

  .html-format-toolbar button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #333;
    font: 600 14px/1 system-ui, sans-serif;
    cursor: pointer;
  }

  .html-format-toolbar button:hover:not(:disabled),
  .html-format-toolbar button.active {
    background: #e7f3ff;
    color: #078aec;
  }

  .html-format-toolbar button:disabled {
    color: #aaa;
    cursor: default;
  }

  .toolbar-divider {
    width: 1px;
    height: 20px;
    margin: 0 2px;
    background: #dedede;
  }

  .font-status {
    max-width: 270px;
    padding: 0 7px;
    overflow: hidden;
    color: #666;
    font: 500 11px/1.2 system-ui, sans-serif;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
