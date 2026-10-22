/**
 * Prints a finished PDF. The macOS app hands the file to PDFKit, which keeps
 * text sharp and fits each page to the chosen paper. Everywhere else the
 * pages are rendered into a print-only layer at their own size and the
 * browser's print dialog takes it from there (including "Save as PDF").
 */

const ROOT_ID = 'docuflex-print-root';
const STYLE_ID = 'docuflex-print-style';

/** @param {ArrayBuffer} buffer */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * @param {ArrayBuffer} bytes the PDF to print, already limited to the chosen pages
 * @param {string} name document name, used as the print job title
 */
export async function printPdf(bytes, name) {
  const tauri = typeof window === 'undefined' ? null : /** @type {any} */ (window).__TAURI__;
  if (tauri?.core?.invoke) {
    try {
      await tauri.core.invoke('docuflex_print_pdf', { name, base64: toBase64(bytes) });
      return;
    } catch (error) {
      if (String(error) !== 'unsupported') throw new Error(String(error));
    }
  }
  await printThroughPage(bytes);
}

/** Rendering resolution: sharp text without huge memory use on long documents. @param {number} pages */
function dotsPerInch(pages) {
  if (pages > 80) return 150;
  if (pages > 30) return 200;
  return 300;
}

/** @param {ArrayBuffer} bytes */
async function printThroughPage(bytes) {
  const pdfjs = await import('pdfjs-dist');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const root = document.createElement('div');
  root.id = ROOT_ID;
  /** Named @page rules give every sheet its PDF page's own size. */
  /** @type {Map<string, string>} */
  const pageSizes = new Map();
  try {
    const pdf = await task.promise;
    const scale = dotsPerInch(pdf.numPages) / 72;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not prepare the pages for printing.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
      const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not prepare the pages for printing.')), 'image/png'));
      canvas.width = 0;
      canvas.height = 0;
      const width = Math.round(size.width * 100) / 100;
      const height = Math.round(size.height * 100) / 100;
      const key = `${width}x${height}`;
      if (!pageSizes.has(key)) pageSizes.set(key, `docuflex-page-${pageSizes.size}`);
      const sheet = document.createElement('div');
      sheet.className = 'docuflex-print-sheet';
      sheet.style.page = /** @type {string} */ (pageSizes.get(key));
      sheet.style.width = `${width}pt`;
      sheet.style.height = `${height}pt`;
      const image = document.createElement('img');
      image.src = URL.createObjectURL(/** @type {Blob} */ (blob));
      image.alt = '';
      sheet.append(image);
      root.append(sheet);
    }
  } finally {
    void task.destroy();
  }

  clearPrintLayer();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} { display: none; }
    @media print {
      ${[...pageSizes].map(([key, name]) => {
        const [width, height] = key.split('x');
        return `@page ${name} { size: ${width}pt ${height}pt; margin: 0; }`;
      }).join('\n')}
      @page { margin: 0; }
      html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; background: #fff !important; }
      body > :not(#${ROOT_ID}) { display: none !important; }
      #${ROOT_ID} { display: block !important; }
      .docuflex-print-sheet { overflow: hidden; break-after: page; page-break-after: always; }
      .docuflex-print-sheet:last-child { break-after: auto; page-break-after: auto; }
      .docuflex-print-sheet img { display: block; width: 100%; height: 100%; }
    }
  `;
  document.head.append(style);
  document.body.append(root);
  await Promise.all([...root.querySelectorAll('img')].map((image) => image.decode().catch(() => {})));
  window.addEventListener('afterprint', clearPrintLayer, { once: true });
  window.print();
}

/** Removes the hidden print layer and frees its page images. */
export function clearPrintLayer() {
  const root = document.getElementById(ROOT_ID);
  root?.querySelectorAll('img').forEach((image) => URL.revokeObjectURL(image.src));
  root?.remove();
  document.getElementById(STYLE_ID)?.remove();
}
