import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { callApp } from '$lib/server/mcp-bridge.js';

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
    description: 'Returns the text of a page plus every text run with its position and size in points, so you can place things next to existing text.',
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
        withEdits: { type: 'boolean', default: true }
      },
      required: ['page']
    },
    annotations: { readOnlyHint: true }
  },

  // Adding content
  {
    name: 'add_text',
    title: 'Add text',
    description: 'Adds a text box. Width and height default to fit the text. Returns the new object id.',
    inputSchema: {
      type: 'object',
      properties: {
        page, x, y, width, height,
        text: { type: 'string', minLength: 1 },
        fontSize: { type: 'number', minimum: 2, maximum: 400, default: 12 },
        fontFamily: { type: 'string', default: 'Helvetica', description: 'Helvetica, Times, Courier or another installed font name.' },
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
    description: 'Highlights, underlines or crosses out text, or redacts it with blackout/whiteout (redactions permanently remove the content on export). Target text by query (optionally limited to a page and occurrence) or by explicit rectangles in points.',
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
    description: 'Changes an added object: position/size (x, y, width, height, rotation), text and text style (text, fontSize, fontFamily, color, bold, italic, underline, align), shape style (fillColor, fillOpacity, noFill, strokeColor, strokeWidth, noStroke, cornerRadius, opacity), or a form field value. Only the given properties change.',
    inputSchema: {
      type: 'object',
      properties: {
        objectId, x, y, width, height,
        rotation: { type: 'number' },
        text: { type: 'string' }, fontSize: { type: 'number' }, fontFamily: { type: 'string' }, color,
        bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
        fillColor: color, fillOpacity: { type: 'number', minimum: 0, maximum: 1 }, noFill: { type: 'boolean' },
        strokeColor: color, strokeWidth: { type: 'number', minimum: 0 }, noStroke: { type: 'boolean' },
        cornerRadius: { type: 'number', minimum: 0 }, opacity: { type: 'number', minimum: 0, maximum: 1 },
        value: { type: ['string', 'boolean'], description: 'Form field value.' }
      },
      required: ['objectId']
    }
  },
  {
    name: 'delete_object',
    title: 'Delete object',
    description: 'Removes an added object.',
    inputSchema: { type: 'object', properties: { objectId }, required: ['objectId'] },
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
  'Added content (text, shapes, images, drawings, marks, comments) are objects you can list, update and delete. replace_text rewrites text that is already in the PDF.'
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
export async function runTool(name, args = {}) {
  if (!MCP_TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown tool: ${name}`);
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
