import mathJaxUrl from 'mathjax/es5/tex-svg-full.js?url';

/**
 * Renders LaTeX for the PDF: MathJax draws it as SVG paths (no fonts needed),
 * which is rasterized at print resolution so it exports like any image.
 * MathJax (about 2 MB) is loaded on first use only.
 */

/** @type {Promise<any> | undefined} */
let loading;

function loadMathJax() {
  const scope = /** @type {any} */ (window);
  if (scope.MathJax?.tex2svgPromise) return Promise.resolve(scope.MathJax);
  loading ??= new Promise((resolve, reject) => {
    scope.MathJax = {
      startup: {
        typeset: false,
        ready() {
          scope.MathJax.startup.defaultReady();
          scope.MathJax.startup.promise.then(() => resolve(scope.MathJax), reject);
        }
      },
      svg: { fontCache: 'none' },
      tex: { packages: { '[+]': ['ams', 'boldsymbol', 'mathtools', 'cancel', 'color'] } }
    };
    const script = document.createElement('script');
    script.src = mathJaxUrl;
    script.async = true;
    script.onerror = () => {
      loading = undefined;
      reject(new Error('Could not load the math renderer.'));
    };
    document.head.append(script);
  });
  return loading;
}

/** Formulas render one at a time: MathJax keeps per-formula TeX state. */
/** @type {Promise<unknown>} */
let queue = Promise.resolve();

/** Output resolution: pixels per PDF point (8.33 ≈ 600 dpi). */
const PIXELS_PER_POINT = 600 / 72;
const MAX_SIDE = 4096;

/**
 * @param {string} latex
 * @param {{ display?: boolean; color?: string; fontSize?: number }} [options] fontSize in points
 * @returns {Promise<{ dataUrl: string; width: number; height: number }>} size in points
 */
export function renderLatex(latex, options = {}) {
  const result = queue.then(() => renderNow(latex, options));
  queue = result.catch(() => {});
  return result;
}

/**
 * @param {string} latex
 * @param {{ display?: boolean; color?: string; fontSize?: number }} options
 * @returns {Promise<{ dataUrl: string; width: number; height: number }>}
 */
async function renderNow(latex, { display = true, color = '#171717', fontSize = 12 }) {
  const MathJax = await loadMathJax();
  MathJax.texReset?.();
  const container = await MathJax.tex2svgPromise(latex, { display });
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('The formula could not be rendered.');
  const error = container.querySelector('[data-mjx-error]');
  if (error) throw new Error(`LaTeX error: ${error.getAttribute('data-mjx-error')}. Fix the LaTeX and try again.`);

  // The viewBox is in thousandths of an em.
  const viewBox = (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
  if (viewBox.length !== 4 || !(viewBox[2] > 0) || !(viewBox[3] > 0)) throw new Error('The formula could not be measured.');
  const width = (viewBox[2] / 1000) * fontSize;
  const height = (viewBox[3] / 1000) * fontSize;

  const scale = Math.min(PIXELS_PER_POINT, MAX_SIDE / Math.max(width, height));
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));
  svg.setAttribute('width', String(pixelWidth));
  svg.setAttribute('height', String(pixelHeight));
  svg.setAttribute('style', `color: ${color}`);
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('The formula could not be drawn.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The formula could not be drawn.');
  context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}
