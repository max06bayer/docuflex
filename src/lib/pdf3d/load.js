import { PdfObjects, inflate, load3dAnnotation } from './pdf-3d.js';
import { parsePrc } from './prc.js';

/**
 * Controls of a live 3D view, shown in the editor's side panel.
 * @typedef {{ views: string[]; selectView: (index: number) => void; close: () => void }} Pdf3dSession
 */

/** One object index per open file; scanning a large PDF is the slow part. */
/** @type {WeakMap<ArrayBuffer, PdfObjects>} */
const indexes = new WeakMap();

/**
 * Loads and decodes the model of one 3D annotation.
 * @param {ArrayBuffer} pdfBytes
 * @param {number} annotationRef object number of the annotation
 */
export async function loadPdf3dModel(pdfBytes, annotationRef) {
  let objects = indexes.get(pdfBytes);
  if (!objects) {
    objects = new PdfObjects(new Uint8Array(pdfBytes));
    indexes.set(pdfBytes, objects);
  }
  const content = await load3dAnnotation(objects, annotationRef);
  if (!content) throw new Error('This 3D annotation has no model data.');
  if (content.format === 'U3D') throw new Error('This model is stored as U3D, which Docuflex cannot show yet.');
  if (content.format !== 'PRC') throw new Error('This 3D model format is not supported.');
  const model = await parsePrc(content.data, inflate);
  if (!model.items.length) throw new Error(model.warnings[0] ?? 'The 3D model is empty.');
  if (model.warnings.length) console.warn('3D model loaded with warnings:', model.warnings);
  return { content, model };
}

/** @param {string | undefined} id a PDF.js annotation id such as "16R" */
export function annotationRefFromId(id) {
  const match = /^(\d+)R$/.exec(id ?? '');
  return match ? Number(match[1]) : null;
}
