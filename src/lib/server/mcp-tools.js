import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { callApp } from '#lib/server/mcp-bridge.js';

/**
 * Tools the Docuflex MCP server exposes. Each one runs inside the open
 * Docuflex window through the same code a person uses, so every change is
 * visible live, undoable, and exported exactly like a manual edit.
 *
 * Conventions shared by all tools (repeated in the server instructions):
 * - Pages are numbered from 1.
 * - Positions and sizes are PDF points (1/72 inch) measured from the
 *   top-left corner of the page as it is displayed (rotation applied).
 * - Colors are hex strings like "#1a73e8".
 */

const page = { type: 'integer', minimum: 1, description: 'Page number, starting at 1.' };
const pages = { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Page numbers, starting at 1.' };
const x = { type: 'number', description: 'Left edge in points from the left of the page.' };
const y = { type: 'number', description: 'Top edge in points from the top of the page.' };
const width = { type: 'number', exclusiveMinimum: 0, description: 'Width in points.' };
const height = { type: 'number', exclusiveMinimum: 0, description: 'Height in points.' };
const color = { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$', description: 'Hex color, e.g. "#e8453c".' };
const objectId = { type: 'integer', description: 'Object id from list_objects or the tool that created it.' };
const filePath = { type: 'string', description: 'Absolute file path on this computer ("~" is allowed).' };
const fontFamily = {
  type: 'string',
  enum: ['Helvetica', 'Arial', 'Verdana', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Courier New'],
  description: 'Sans-serif: Helvetica (default), Arial, Verdana, Trebuchet MS. Serif: Times New Roman, Georgia. Monospace: Courier New. Any Unicode character works (symbols a font lacks are embedded from a Unicode font). For formulas use add_math instead.'
};

/** @type {{ name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }[]} */
export const MCP_TOOLS = [
  // Documents
  {
    name: 'list_documents',
    title: 'List open documents',
    description: 'Lists the documents open in Docuflex tabs with their ids, names and which one is active.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'open_document',
    title: 'Open a PDF',
    description: 'Opens a PDF file from disk in a new Docuflex tab and makes it the active document. All editing tools work on the active document. If the file needs a password to open, pass password (or call unlock_document afterwards); the result says passwordRequired otherwise.',
    inputSchema: { type: 'object', properties: { path: filePath, password: { type: 'string', description: 'Password to open an encrypted PDF.' } }, required: ['path'] }
  },
  {
    name: 'unlock_document',
    title: 'Unlock with password',
    description: 'Unlocks the active document when it needs a password to open. The password must be the correct one; it is not guessed.',
    inputSchema: { type: 'object', properties: { password: { type: 'string', minLength: 1 } }, required: ['password'] }
  },
  {
    name: 'switch_document',
    title: 'Switch document',
    description: 'Makes another open document the active one.',
    inputSchema: { type: 'object', properties: { documentId: { type: 'integer' } }, required: ['documentId'] }
  },
  {
    name: 'close_document',
    title: 'Close document',
    description: 'Closes an open document tab. Unsaved changes are lost.',
    inputSchema: { type: 'object', properties: { documentId: { type: 'integer' } }, required: ['documentId'] },
    annotations: { destructiveHint: true }
  },
  {
    name: 'get_document_info',
    title: 'Document info',
    description: 'Active document overview: name, page count, page sizes in points, protection state, counts of added objects/comments, and form fields. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'save_document',
    title: 'Save as PDF',
    description: 'Exports the active document with all edits to a PDF file. mode "auto" saves normally (on an edit-protected file only allowed changes such as form filling and comments, keeping the protection); mode "flattened" saves a print copy of an edit-protected file, which is only possible when its owner allows printing.',
    inputSchema: {
      type: 'object',
      properties: { path: filePath, mode: { type: 'string', enum: ['auto', 'flattened'], default: 'auto' } },
      required: ['path']
    }
  },

  // Reading
  {
    name: 'get_page_text',
    title: 'Read page text',
    description: 'Returns the PDF\'s own text on a page plus every text run with its position in points, so you can place things next to existing text. Text and formulas you added in Docuflex are listed separately in addedText.',
    inputSchema: { type: 'object', properties: { page }, required: ['page'] },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'search_text',
    title: 'Search text',
    description: 'Finds text in the document and returns every match with its page and bounding box in points.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 }, caseSensitive: { type: 'boolean', default: false } },
      required: ['query']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'render_page',
    title: 'Render page image',
    description: 'Renders a page to a PNG image so you can look at it. withEdits (default true) shows the page exactly as it will be exported, including everything added in Docuflex. Use it to verify your changes.',
    inputSchema: {
      type: 'object',
      properties: {
        page,
        scale: { type: 'number', minimum: 0.25, maximum: 3, default: 1.25, description: 'Pixels per point.' },
        withEdits: { type: 'boolean', default: true },
        region: {
          type: 'object',
          description: 'Only this part of the page, in points, rendered sharper (scale defaults to 3). Use it to check small details like formulas or line breaks.',
          properties: { x, y, width, height },
          required: ['x', 'y', 'width', 'height']
        }
      },
      required: ['page']
    },
    annotations: { readOnlyHint: true }
  },

  // Adding content
  {
    name: 'add_text',
    title: 'Add text',
    description: 'Adds a text box. Without width the box fits the longest line; with width the text wraps inside it. Height defaults to the wrapped text height. The result reports lines and textHeight (points) so you can size things around it, and overflow when a given height is too small. Default color #171717. Returns the new object id.',
    inputSchema: {
      type: 'object',
      properties: {
        page, x, y, width, height,
        text: { type: 'string', minLength: 1 },
        fontSize: { type: 'number', minimum: 2, maximum: 400, default: 12 },
        fontFamily,
        color,
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right'] }
      },
      required: ['page', 'x', 'y', 'text']
    }
  },
  {
    name: 'add_math',
    title: 'Add formula',
    description: 'Places a math formula written in LaTeX (e.g. "\\int_0^1 x^2\\,dx = \\tfrac{1}{3}", "\\forall x \\in M: x \\Rightarrow y", "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}"). Use it for anything with fractions, sub/superscripts, integrals, matrices or aligned steps; plain prose goes in add_text. Do not wrap the LaTeX in $. Size follows the formula; maxWidth scales it down to fit. Returns the object id and its width/height in points.',
    inputSchema: {
      type: 'object',
      properties: {
        page, x, y,
        latex: { type: 'string', minLength: 1 },
        fontSize: { type: 'number', minimum: 4, maximum: 200, default: 14, description: 'Size of the formula text in points.' },
        color,
        display: { type: 'boolean', default: true, description: 'Display style (larger fractions and limits). false for inline style.' },
        maxWidth: { type: 'number', exclusiveMinimum: 0, description: 'Scale down to at most this width in points.' }
      },
      required: ['page', 'x', 'y', 'latex']
    }
  },
  {
    name: 'measure_text',
    title: 'Measure text',
    description: 'Measures text before placing it: the box width and height in points it needs and its line count, wrapped like add_text. Give width to wrap at that width.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        fontSize: { type: 'number', minimum: 2, maximum: 400, default: 12 },
        fontFamily,
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        width
      },
      required: ['text']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_shape',
    title: 'Add shape',
    description: 'Adds a rectangle, circle (ellipse), triangle, check mark or cross. Rectangles, circles and triangles are filled unless noFill is true. Returns the new object id.',
    inputSchema: {
      type: 'object',
      properties: {
        page, x, y, width, height,
        type: { type: 'string', enum: ['rectangle', 'circle', 'triangle', 'check', 'cross'] },
        fillColor: color,
        fillOpacity: { type: 'number', minimum: 0, maximum: 1 },
        noFill: { type: 'boolean' },
        strokeColor: color,
        strokeWidth: { type: 'number', minimum: 0, maximum: 40 },
        noStroke: { type: 'boolean' },
        cornerRadius: { type: 'number', minimum: 0 },
        rotation: { type: 'number', description: 'Degrees clockwise.' },
        opacity: { type: 'number', minimum: 0, maximum: 1 }
      },
      required: ['page', 'type', 'x', 'y', 'width', 'height']
    }
  },
  {
    name: 'add_line',
    title: 'Add line or arrow',
    description: 'Draws a straight line or an arrow from (x1, y1) to (x2, y2). Returns the new object id.',
    inputSchema: {
      type: 'object',
      properties: {
        page,
        type: { type: 'string', enum: ['line', 'arrow'], default: 'line' },
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        color,
        strokeWidth: { type: 'number', minimum: 0.25, maximum: 40 }
      },
      required: ['page', 'x1', 'y1', 'x2', 'y2']
    }
  },
  {
    name: 'add_image',
    title: 'Add image',
    description: 'Places an image (PNG, JPEG, WebP, GIF or SVG) from a file path or a data URL. Give width or height to keep the aspect ratio, or both to stretch. Returns the new object id.',
    inputSchema: {
      type: 'object',
      properties: { page, x, y, width, height, path: filePath, dataUrl: { type: 'string', description: 'data:image/...;base64,... instead of a path.' } },
      required: ['page', 'x', 'y']
    }
  },
  {
    name: 'draw',
    title: 'Freehand drawing',
    description: 'Draws a freehand pen or marker stroke through the given points. Returns the new object id.',
    inputSchema: {
      type: 'object',
      properties: {
        page,
        tool: { type: 'string', enum: ['pen', 'marker'], default: 'pen' },
        points: {
          type: 'array',
          minItems: 2,
          maxItems: 10000,
          description: 'An array of point objects, e.g. [{"x":100,"y":300},{"x":200,"y":300}]. Each coordinate must be a finite number. Never pass points as a string, coordinate pairs or a flat number array.',
          items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }
        },
        color,
        thickness: { type: 'number', minimum: 0.25, maximum: 40 },
        opacity: { type: 'number', minimum: 0.01, maximum: 1 }
      },
      required: ['page', 'points']
    }
  },
  {
    name: 'mark_text',
    title: 'Highlight / strike / redact text',
    description: 'Highlights, underlines or crosses out text, or redacts it with blackout/whiteout. Redaction is permanent on save: the text, images and drawings under the box are destroyed, not covered. Target text by query (optionally limited to a page and occurrence): the boxes then match the text exactly, like a selection by hand, so do not adjust them. Or give explicit rectangles in points; rectangles also redact things that are not text, like signatures, photos or stamps. A black add_shape rectangle is only a drawing and removes nothing, so always redact with this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['highlight', 'underline', 'crossout', 'blackout', 'whiteout'] },
        query: { type: 'string' },
        page,
        occurrence: { type: 'integer', minimum: 1, description: 'Only the n-th match (1-based). Default: all matches.' },
        rects: { type: 'array', items: { type: 'object', properties: { x, y, width, height }, required: ['x', 'y', 'width', 'height'] } },
        color
      },
      required: ['type']
    }
  },
  {
    name: 'set_watermark',
    title: 'Watermark',
    description: 'Adds a diagonal text watermark to every page, or removes it with an empty text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },

  // Objects
  {
    name: 'list_objects',
    title: 'List added objects',
    description: 'Lists everything added in Docuflex (text boxes, shapes, images, drawings, text marks, form fields) with ids and positions in points.',
    inputSchema: { type: 'object', properties: { page } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'update_object',
    title: 'Update object',
    description: 'Changes an added object: position/size (x, y, width, height, rotation), text and text style (text, fontSize, fontFamily, color, bold, italic, underline, align), a formula (latex, fontSize, color), shape style (fillColor, fillOpacity, noFill, strokeColor, strokeWidth, noStroke, cornerRadius, opacity), stacking (arrange "front" or "back" among added objects), or a form field value. Only the given properties change. A text box grows taller when its text no longer fits, unless you give height.',
    inputSchema: {
      type: 'object',
      properties: {
        objectId, x, y, width, height,
        rotation: { type: 'number' },
        text: { type: 'string' }, fontSize: { type: 'number' }, fontFamily, color,
        bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
        fillColor: color, fillOpacity: { type: 'number', minimum: 0, maximum: 1 }, noFill: { type: 'boolean' },
        strokeColor: color, strokeWidth: { type: 'number', minimum: 0 }, noStroke: { type: 'boolean' },
        cornerRadius: { type: 'number', minimum: 0 }, opacity: { type: 'number', minimum: 0, maximum: 1 },
        value: { type: ['string', 'boolean'], description: 'Form field value.' },
        latex: { type: 'string', description: 'New LaTeX for a formula object.' },
        arrange: { type: 'string', enum: ['front', 'back'], description: 'Put the object in front of or behind the other added objects on its page (e.g. a background box goes "back").' }
      },
      required: ['objectId']
    }
  },
  {
    name: 'delete_object',
    title: 'Delete objects',
    description: 'Removes added objects: one (objectId), several (objectIds), or everything added on a page (allOnPage). The PDF\'s own content is not affected.',
    inputSchema: {
      type: 'object',
      properties: {
        objectId,
        objectIds: { type: 'array', items: { type: 'integer' } },
        allOnPage: { type: 'integer', minimum: 1, description: 'Page number: delete every object added on it.' }
      }
    },
    annotations: { destructiveHint: true }
  },

  // Editing existing text
  {
    name: 'replace_text',
    title: 'Replace existing text',
    description: 'Rewrites text that is already in the PDF (not added objects), keeping its font and position where possible. Use get_page_text or search_text first to get the exact text. Fails on edit-protected files.',
    inputSchema: {
      type: 'object',
      properties: {
        page,
        find: { type: 'string', minLength: 1, description: 'Exact existing text, ideally one full line or text run.' },
        replace: { type: 'string' },
        occurrence: { type: 'integer', minimum: 1, description: 'Which match on the page (1-based). Default: the first.' }
      },
      required: ['page', 'find', 'replace']
    }
  },

  // Comments
  {
    name: 'list_comments',
    title: 'List comments',
    description: 'Lists all comments (from the PDF and added in Docuflex) with ids, authors, text, replies and positions.',
    inputSchema: { type: 'object', properties: { page } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_comment',
    title: 'Add comment',
    description: 'Adds a comment. Give quote to attach it to text on the page (it gets highlighted), or x/y for a sticky note at that spot. Saved as a standard PDF comment.',
    inputSchema: {
      type: 'object',
      properties: {
        page, x, y,
        text: { type: 'string', minLength: 1 },
        quote: { type: 'string', description: 'Existing text on the page to comment on.' },
        author: { type: 'string' }
      },
      required: ['page', 'text']
    }
  },
  {
    name: 'reply_to_comment',
    title: 'Reply to comment',
    description: 'Adds a reply to a comment (from the PDF or added in Docuflex).',
    inputSchema: {
      type: 'object',
      properties: { commentId: { type: 'integer' }, text: { type: 'string', minLength: 1 }, author: { type: 'string' } },
      required: ['commentId', 'text']
    }
  },
  {
    name: 'delete_comment',
    title: 'Delete comment',
    description: 'Deletes a comment added in Docuflex. Comments already in the PDF cannot be deleted.',
    inputSchema: { type: 'object', properties: { commentId: { type: 'integer' } }, required: ['commentId'] },
    annotations: { destructiveHint: true }
  },

  // Forms
  {
    name: 'list_form_fields',
    title: 'List form fields',
    description: 'Lists the fillable fields (text inputs and checkboxes) with names, values and positions.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'fill_form_field',
    title: 'Fill form field',
    description: 'Sets a form field value by name: text for inputs, true/false for checkboxes.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, value: { type: ['string', 'boolean'] } },
      required: ['name', 'value']
    }
  },
  {
    name: 'add_form_field',
    title: 'Add form field',
    description: 'Adds a new fillable text input or checkbox. Returns the new object id.',
    inputSchema: {
      type: 'object',
      properties: {
        page, x, y, width, height,
        type: { type: 'string', enum: ['text', 'checkbox'] },
        name: { type: 'string' },
        value: { type: ['string', 'boolean'] }
      },
      required: ['page', 'type', 'x', 'y', 'width', 'height']
    }
  },

  // Pages
  {
    name: 'rotate_pages',
    title: 'Rotate pages',
    description: 'Rotates pages by 90, 180 or 270 degrees clockwise (-90 for counterclockwise).',
    inputSchema: {
      type: 'object',
      properties: { pages, degrees: { type: 'integer', enum: [90, 180, 270, -90] } },
      required: ['pages', 'degrees']
    }
  },
  {
    name: 'delete_pages',
    title: 'Delete pages',
    description: 'Deletes pages. At least one page must remain.',
    inputSchema: { type: 'object', properties: { pages }, required: ['pages'] },
    annotations: { destructiveHint: true }
  },
  {
    name: 'reorder_pages',
    title: 'Reorder pages',
    description: 'Puts the pages in a new order. order lists every current page number once, e.g. [3, 1, 2].',
    inputSchema: { type: 'object', properties: { order: pages }, required: ['order'] }
  },
  {
    name: 'insert_blank_page',
    title: 'Insert blank page',
    description: 'Inserts an empty page, filled with a color if given. after = 0 inserts at the start; default inserts at the end. Size defaults to the page before it.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'integer', minimum: 0, description: 'Insert after this page number.' },
        color: { ...color, description: 'Page color, default white.' },
        width: { ...width, description: 'Width in points (A4 is 595 × 842).' },
        height
      }
    }
  },
  {
    name: 'insert_pdf',
    title: 'Insert PDF pages',
    description: 'Inserts all pages of another PDF file. after = 0 inserts at the start; default inserts at the end.',
    inputSchema: {
      type: 'object',
      properties: { path: filePath, after: { type: 'integer', minimum: 0, description: 'Insert after this page number.' } },
      required: ['path']
    }
  },
  {
    name: 'extract_pages',
    title: 'Extract pages',
    description: 'Saves the given pages, with their edits, as a new PDF file.',
    inputSchema: { type: 'object', properties: { pages, path: filePath }, required: ['pages', 'path'] }
  },

  // Document-wide
  {
    name: 'rasterize_pages',
    title: 'Rasterize / adjust pages',
    description: 'Turns pages into 300 DPI images, optionally rotating (straightening scans) and color-correcting them. Values range from -100 to 100 (hue -180..180, sharpness 0..100, rotation -45..45 degrees). Default: all pages.',
    inputSchema: {
      type: 'object',
      properties: {
        pages,
        rotation: { type: 'number', minimum: -45, maximum: 45 },
        fillEdges: { type: 'boolean', default: true, description: 'Zoom in while rotating so no white corners appear.' },
        exposure: { type: 'number', minimum: -100, maximum: 100 },
        contrast: { type: 'number', minimum: -100, maximum: 100 },
        saturation: { type: 'number', minimum: -100, maximum: 100 },
        hue: { type: 'number', minimum: -180, maximum: 180 },
        temperature: { type: 'number', minimum: -100, maximum: 100 },
        sharpness: { type: 'number', minimum: 0, maximum: 100 }
      }
    }
  },
  {
    name: 'run_ocr',
    title: 'Recognize text (OCR)',
    description: 'Runs OCR so scanned pages get searchable, selectable text.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_password',
    title: 'Password protection',
    description: 'Encrypts the exported PDF with AES-256 and this password (max 32 bytes), or removes the protection Docuflex added when password is empty.',
    inputSchema: { type: 'object', properties: { password: { type: 'string' } }, required: ['password'] }
  },
  {
    name: 'undo',
    title: 'Undo',
    description: 'Undoes the last change.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Redoes the last undone change.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_view',
    title: 'Control the view',
    description: 'Scrolls to a page, sets the zoom (0.5 to 4) and/or turns the comment view on or off in the Docuflex window.',
    inputSchema: {
      type: 'object',
      properties: { page, zoom: { type: 'number', minimum: 0.5, maximum: 4 }, commentMode: { type: 'boolean' } }
    }
  }
];

export const MCP_INSTRUCTIONS = [
  'Docuflex is a PDF editor running on this computer. These tools control the open Docuflex window live: every change appears immediately, can be undone, and is exported like a manual edit.',
  'Workflow: open_document (or use the active document) → get_document_info → read with get_page_text/search_text → edit → render_page to check your work → save_document.',
  'Pages are numbered from 1. Positions and sizes are PDF points (1/72 inch) from the top-left of the displayed page. Colors are hex strings.',
  'Added content (text, shapes, images, drawings, marks, comments) are objects you can list, update and delete. replace_text rewrites text that is already in the PDF.',
  'Added text: any Unicode character is fine. Formulas (fractions, sub/superscripts, integrals, aligned steps) go in add_math as LaTeX. Use measure_text, or the textHeight that add_text returns, to size boxes and backgrounds around text.',
  'Every change returns the object and pageNow, the objects now on that page: trust it, your change landed. Never repeat a call that succeeded. get_page_text shows only the PDF\'s own text; added text is in its addedText.'
].join('\n');

/** @param {string} path */
function resolvePath(path) {
  const expanded = path.startsWith('~') ? `${homedir()}${path.slice(1)}` : path;
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

const IMAGE_TYPES = /** @type {Record<string, string>} */ ({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
});

/** @param {string} path @param {number} limit */
async function readLimited(path, limit) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`File not found: ${path}`);
  if (info.size > limit) throw new Error(`File is too large: ${path}`);
  return readFile(path);
}

/** @param {string} path @param {string} base64 */
async function writePdf(path, base64) {
  if (extname(path).toLowerCase() !== '.pdf') throw new Error('The output path must end in .pdf.');
  const bytes = Buffer.from(base64, 'base64');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes.length;
}

/**
 * Runs a tool: file system work happens here, everything else in the window.
 * @param {string} name @param {Record<string, any>} args
 * @returns {Promise<{ content: any[]; isError?: boolean }>}
 */
/**
 * Guard against agents that loop: weaker models repeat calls they think
 * failed, sometimes hundreds of times. Shared by the MCP server and the AI
 * chat. State lives on globalThis so dev reloads keep it.
 */
const guard = /** @type {{ recent: { key: string; name: string; at: number }[]; failures: Map<string, number>; running: Map<string, number> }} */ (
  /** @type {any} */ (globalThis).__docuflexToolGuard ??= { recent: [], failures: new Map(), running: new Map() }
);
const GUARD_WINDOW_MS = 120_000;
/** Calls that are fine to repeat with the same arguments. */
const REPEATABLE = new Set(['undo', 'redo', 'rotate_pages', 'set_view', 'render_page', 'list_objects', 'list_documents', 'get_document_info', 'list_comments', 'list_form_fields', 'measure_text', 'save_document', 'switch_document']);
const READ_ONLY = new Set(MCP_TOOLS.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name));
const wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {unknown} value @returns {unknown} */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(/** @type {any} */ (value)[key])]));
  return value;
}

/** @param {string} name @param {Record<string, any>} args @param {string} agent */
async function guardedRun(name, args, agent, /** @type {() => Promise<any>} */ run) {
  const now = Date.now();
  guard.recent = guard.recent.filter((entry) => now - entry.at < GUARD_WINDOW_MS);
  // Repeats count per agent: parallel helpers may read the same page.
  const key = `${agent}:${name}:${JSON.stringify(stable(args))}`;

  if (!REPEATABLE.has(name)) {
    const repeats = guard.recent.filter((entry) => entry.key === key).length;
    const limit = READ_ONLY.has(name) ? 3 : 2;
    if (repeats >= limit) {
      throw new Error(`Not run: you already made this exact ${name} call ${repeats} times in the last 2 minutes and it succeeded each time. Repeating it changes nothing${READ_ONLY.has(name) ? '; use the result you already have' : ' and would stack duplicates'}. Check the current state with list_objects, or do something different.`);
    }
  }

  const running = guard.running.get(name) ?? 0;
  // Parallel helpers legitimately run several of the same tool at once.
  if (running >= 8) {
    await wait(500);
    throw new Error(`Wait: ${running} ${name} calls are still running. Let them finish and look at their results before sending more.`);
  }

  const failureKey = `${agent}:${name}`;
  const failures = guard.failures.get(failureKey) ?? 0;
  if (failures >= 8) {
    guard.failures.set(failureKey, failures - 1);
    await wait(500);
    throw new Error(`Paused: your last ${failures} ${name} calls all failed. Stop retrying. Read the last error, change your approach (different arguments or a different tool), or ask the person.`);
  }
  if (failures >= 3) await wait(500);

  guard.running.set(name, running + 1);
  try {
    const result = await run();
    guard.failures.set(failureKey, 0);
    // After undo/redo, repeating an earlier edit is legitimate again.
    if (name === 'undo' || name === 'redo') guard.recent = [];
    else guard.recent.push({ key, name, at: Date.now() });
    return result;
  } catch (error) {
    guard.failures.set(failureKey, failures + 1);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(failures + 1 >= 3 ? `${message}\n(${name} has now failed ${failures + 1} times in a row. Don't repeat the same call; change the arguments or the approach.)` : message);
  } finally {
    guard.running.set(name, Math.max(0, (guard.running.get(name) ?? 1) - 1));
  }
}

/** @param {string} name @param {Record<string, any>} args @param {string} [agent] who calls, for the repeat guard */
export async function runTool(name, args = {}, agent = 'mcp') {
  if (!MCP_TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown tool: ${name}`);
  return guardedRun(name, args, agent, () => runToolUnguarded(name, args));
}

/** @param {string} name @param {Record<string, any>} args @returns {Promise<{ content: any[]; isError?: boolean }>} */
async function runToolUnguarded(name, args) {
  /** @param {unknown} value */
  const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

  if (name === 'open_document') {
    const path = resolvePath(String(args.path ?? ''));
    const bytes = await readLimited(path, 150 * 1024 * 1024);
    return text(await callApp('open_document', { name: basename(path), base64: bytes.toString('base64'), password: args.password }));
  }
  if (name === 'insert_pdf') {
    const path = resolvePath(String(args.path ?? ''));
    const bytes = await readLimited(path, 150 * 1024 * 1024);
    return text(await callApp('insert_pdf', { base64: bytes.toString('base64'), after: args.after }));
  }
  if (name === 'add_image' && args.path) {
    const path = resolvePath(String(args.path));
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!type) throw new Error('Unsupported image type. Use PNG, JPEG, WebP, GIF or SVG.');
    const bytes = await readLimited(path, 24 * 1024 * 1024);
    const { path: _path, ...rest } = args;
    return text(await callApp('add_image', { ...rest, dataUrl: `data:${type};base64,${bytes.toString('base64')}` }));
  }
  if (name === 'save_document' || name === 'extract_pages') {
    const path = resolvePath(String(args.path ?? ''));
    const { path: _path, ...rest } = args;
    const result = await callApp(name, rest);
    const bytes = await writePdf(path, result.base64);
    const { base64: _base64, ...details } = result;
    return text({ ...details, path, bytes });
  }
  if (name === 'render_page') {
    const result = await callApp('render_page', args);
    return {
      content: [
        { type: 'image', data: result.png, mimeType: 'image/png' },
        { type: 'text', text: `Page ${result.page}: ${result.widthPt} × ${result.heightPt} pt, rendered at ${result.width} × ${result.height} px${result.note ? `. ${result.note}` : ''}.` }
      ]
    };
  }
  return text(await callApp(name, args));
}
