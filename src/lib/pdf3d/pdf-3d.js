/**
 * Finds the data behind a PDF 3D annotation (/Subtype /3D): the embedded PRC or
 * U3D stream and the view it should open with. PDF.js reports these
 * annotations but does not expose their streams, so this reads the objects
 * straight from the file bytes. Objects are located by scanning rather than
 * through the xref table, which also copes with slightly damaged files.
 */

/**
 * @typedef {{ name: string }} PdfName
 * @typedef {{ ref: number }} PdfRef
 * @typedef {{ dict: Record<string, any>; data?: Uint8Array }} PdfStream
 * @typedef {null | boolean | number | string | PdfName | PdfRef | any[] | { dict: Record<string, any> } | PdfStream} PdfValue
 */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Inflates zlib data, keeping whatever decoded before a damaged tail. @param {Uint8Array} bytes */
export async function inflate(bytes) {
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } catch (error) {
    if (!length) throw error;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

class Lexer {
  /** @param {Uint8Array} bytes @param {number} position */
  constructor(bytes, position = 0) {
    this.bytes = bytes;
    this.position = position;
  }

  skipSpace() {
    const { bytes } = this;
    while (this.position < bytes.length) {
      const byte = bytes[this.position];
      if (WHITESPACE.has(byte)) this.position += 1;
      else if (byte === 0x25) {
        while (this.position < bytes.length && bytes[this.position] !== 0x0a && bytes[this.position] !== 0x0d) this.position += 1;
      } else break;
    }
  }

  regular() {
    const start = this.position;
    while (this.position < this.bytes.length && !WHITESPACE.has(this.bytes[this.position]) && !DELIMITERS.has(this.bytes[this.position])) {
      this.position += 1;
    }
    return String.fromCharCode(...this.bytes.subarray(start, this.position));
  }

  /** @returns {PdfValue | { keyword: string }} */
  token() {
    this.skipSpace();
    const { bytes } = this;
    const byte = bytes[this.position];
    if (byte === undefined) return { keyword: 'EOF' };
    if (byte === 0x2f) {
      this.position += 1;
      return { name: this.regular().replace(/#([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16))) };
    }
    if (byte === 0x5b) {
      this.position += 1;
      return { keyword: '[' };
    }
    if (byte === 0x5d) {
      this.position += 1;
      return { keyword: ']' };
    }
    if (byte === 0x3c && bytes[this.position + 1] === 0x3c) {
      this.position += 2;
      return { keyword: '<<' };
    }
    if (byte === 0x3e && bytes[this.position + 1] === 0x3e) {
      this.position += 2;
      return { keyword: '>>' };
    }
    if (byte === 0x3c) {
      const end = bytes.indexOf(0x3e, this.position);
      const hex = String.fromCharCode(...bytes.subarray(this.position + 1, end < 0 ? bytes.length : end)).replace(/\s+/g, '');
      this.position = end < 0 ? bytes.length : end + 1;
      let text = '';
      for (let index = 0; index < hex.length; index += 2) text += String.fromCharCode(parseInt(hex.slice(index, index + 2).padEnd(2, '0'), 16));
      return text;
    }
    if (byte === 0x28) return this.literalString();
    const word = this.regular();
    if (!word) {
      this.position += 1;
      return { keyword: String.fromCharCode(byte) };
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { keyword: word };
  }

  literalString() {
    const { bytes } = this;
    this.position += 1;
    let depth = 1;
    let text = '';
    while (this.position < bytes.length) {
      const byte = bytes[this.position++];
      if (byte === 0x5c) {
        const next = bytes[this.position++];
        const escapes = /** @type {Record<number, string>} */ ({ 0x6e: '\n', 0x72: '\r', 0x74: '\t', 0x62: '\b', 0x66: '\f' });
        if (escapes[next]) text += escapes[next];
        else if (next >= 0x30 && next <= 0x37) {
          let octal = String.fromCharCode(next);
          while (octal.length < 3 && bytes[this.position] >= 0x30 && bytes[this.position] <= 0x37) octal += String.fromCharCode(bytes[this.position++]);
          text += String.fromCharCode(parseInt(octal, 8) & 0xff);
        } else if (next === 0x0d || next === 0x0a) {
          if (next === 0x0d && bytes[this.position] === 0x0a) this.position += 1;
        } else text += String.fromCharCode(next);
      } else if (byte === 0x28) {
        depth += 1;
        text += '(';
      } else if (byte === 0x29) {
        depth -= 1;
        if (!depth) break;
        text += ')';
      } else text += String.fromCharCode(byte);
    }
    return text;
  }

  /** @returns {PdfValue} */
  value() {
    const token = this.token();
    return this.complete(token);
  }

  /** @param {PdfValue | { keyword: string }} token @returns {PdfValue} */
  complete(token) {
    if (token && typeof token === 'object' && 'keyword' in token) {
      if (token.keyword === '[') {
        /** @type {PdfValue[]} */
        const items = [];
        for (;;) {
          const next = this.token();
          if (next && typeof next === 'object' && 'keyword' in next && (next.keyword === ']' || next.keyword === 'EOF')) break;
          if (next && typeof next === 'object' && 'keyword' in next && next.keyword === 'R' && items.length >= 2) {
            items.pop();
            const number = items.pop();
            items.push({ ref: Number(number) });
            continue;
          }
          items.push(this.complete(next));
        }
        return items;
      }
      if (token.keyword === '<<') {
        /** @type {Record<string, PdfValue>} */
        const dict = {};
        for (;;) {
          const key = this.token();
          if (!key || typeof key !== 'object' || !('name' in key)) break;
          dict[key.name] = this.dictValue();
        }
        return { dict };
      }
      return null;
    }
    return /** @type {PdfValue} */ (token);
  }

  /** Reads a value that may be an indirect reference "n g R". */
  dictValue() {
    const value = this.value();
    if (typeof value !== 'number' || !Number.isInteger(value)) return value;
    const saved = this.position;
    const generation = this.token();
    const keyword = this.token();
    if (typeof generation === 'number' && keyword && typeof keyword === 'object' && 'keyword' in keyword && keyword.keyword === 'R') {
      return { ref: value };
    }
    this.position = saved;
    return value;
  }
}

/** @param {PdfValue | undefined} value @returns {value is { dict: Record<string, PdfValue> }} */
export function isDict(value) {
  return Boolean(value && typeof value === 'object' && 'dict' in value);
}

/** @param {PdfValue | undefined} value @returns {value is PdfName} */
export function isName(value) {
  return Boolean(value && typeof value === 'object' && 'name' in value);
}

/** @param {PdfValue | undefined} value @returns {value is PdfRef} */
function isRef(value) {
  return Boolean(value && typeof value === 'object' && 'ref' in value);
}

export class PdfObjects {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    /** Object number -> byte offset of its "obj" body (last definition wins). */
    /** @type {Map<number, number>} */
    this.offsets = new Map();
    /** Object number -> [object stream number, index]. */
    /** @type {Map<number, number>} */
    this.inStream = new Map();
    /** @type {Map<number, PdfValue>} */
    this.cache = new Map();
    /** @type {Map<number, { bytes: Uint8Array; offsets: Map<number, number> }>} */
    this.objectStreams = new Map();
    this.encrypted = false;
    this.scan();
  }

  scan() {
    const text = new TextDecoder('latin1').decode(this.bytes);
    const pattern = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      this.offsets.set(Number(match[1]), match.index + match[0].length);
    }
    this.encrypted = /\/Encrypt\s*\d+\s+\d+\s+R|\/Encrypt\s*<</.test(text);
  }

  /** @param {number} number @returns {Promise<PdfValue>} */
  async get(number) {
    if (this.cache.has(number)) return /** @type {PdfValue} */ (this.cache.get(number));
    let value = null;
    const offset = this.offsets.get(number);
    if (offset !== undefined) value = await this.readAt(this.bytes, offset, true);
    else value = await this.fromObjectStreams(number);
    this.cache.set(number, value);
    return value;
  }

  /** @param {PdfValue | undefined} value @returns {Promise<PdfValue>} */
  async resolve(value) {
    let current = value ?? null;
    for (let depth = 0; isRef(current) && depth < 16; depth += 1) current = await this.get(current.ref);
    return current;
  }

  /** @param {Uint8Array} bytes @param {number} offset @param {boolean} allowStream */
  async readAt(bytes, offset, allowStream) {
    const lexer = new Lexer(bytes, offset);
    const value = lexer.dictValue();
    if (!allowStream || !isDict(value)) return value;
    lexer.skipSpace();
    if (String.fromCharCode(...bytes.subarray(lexer.position, lexer.position + 6)) !== 'stream') return value;
    let start = lexer.position + 6;
    if (bytes[start] === 0x0d) start += 1;
    if (bytes[start] === 0x0a) start += 1;
    let length = await this.resolve(value.dict.Length);
    if (typeof length !== 'number' || start + length > bytes.length || !this.endsStream(bytes, start + length)) {
      const end = findSequence(bytes, 'endstream', start);
      length = Math.max(0, (end < 0 ? bytes.length : end) - start);
      while (length > 0 && (bytes[start + length - 1] === 0x0a || bytes[start + length - 1] === 0x0d)) length -= 1;
    }
    return { dict: value.dict, data: bytes.subarray(start, start + length) };
  }

  /** @param {Uint8Array} bytes @param {number} position */
  endsStream(bytes, position) {
    let index = position;
    while (WHITESPACE.has(bytes[index])) index += 1;
    return String.fromCharCode(...bytes.subarray(index, index + 9)) === 'endstream';
  }

  /** @param {number} number */
  async fromObjectStreams(number) {
    if (!this.objectStreams.size) await this.loadObjectStreams();
    for (const stream of this.objectStreams.values()) {
      const offset = stream.offsets.get(number);
      if (offset !== undefined) return this.readAt(stream.bytes, offset, false);
    }
    return null;
  }

  async loadObjectStreams() {
    for (const [number] of this.offsets) {
      const value = await this.get(number);
      if (!isDict(value) || !('data' in value) || !isName(value.dict.Type) || value.dict.Type.name !== 'ObjStm') continue;
      try {
        const bytes = await this.streamData(/** @type {PdfStream} */ (value));
        const first = Number(value.dict.First) || 0;
        const count = Number(value.dict.N) || 0;
        const header = new Lexer(bytes, 0);
        /** @type {Map<number, number>} */
        const offsets = new Map();
        for (let index = 0; index < count; index += 1) {
          const objectNumber = header.value();
          const objectOffset = header.value();
          if (typeof objectNumber !== 'number' || typeof objectOffset !== 'number') break;
          offsets.set(objectNumber, first + objectOffset);
        }
        this.objectStreams.set(number, { bytes, offsets });
      } catch {
        // A damaged object stream only hides the objects inside it.
      }
    }
  }

  /** Decoded stream bytes (Flate only; 3D streams use nothing else in practice). @param {PdfStream} stream */
  async streamData(stream) {
    const data = stream.data ?? new Uint8Array(0);
    const filter = await this.resolve(stream.dict.Filter);
    const filters = (Array.isArray(filter) ? filter : filter ? [filter] : []).map((entry) => (isName(entry) ? entry.name : ''));
    let output = data;
    for (const name of filters) {
      if (name === 'FlateDecode' || name === 'Fl') output = await inflate(output);
      else throw new Error(`Unsupported stream filter ${name}.`);
    }
    const params = await this.resolve(stream.dict.DecodeParms);
    if (isDict(params) && Number(params.dict.Predictor) >= 10) output = undoPngPredictor(output, Number(params.dict.Columns) || 1);
    return output;
  }
}

/** @param {Uint8Array} bytes @param {string} text @param {number} from */
function findSequence(bytes, text, from) {
  const first = text.charCodeAt(0);
  for (let index = bytes.indexOf(first, from); index >= 0; index = bytes.indexOf(first, index + 1)) {
    let matches = true;
    for (let offset = 1; offset < text.length && matches; offset += 1) matches = bytes[index + offset] === text.charCodeAt(offset);
    if (matches) return index;
  }
  return -1;
}

/** @param {Uint8Array} data @param {number} columns */
function undoPngPredictor(data, columns) {
  const rowLength = columns + 1;
  const rows = Math.floor(data.length / rowLength);
  const output = new Uint8Array(rows * columns);
  for (let row = 0; row < rows; row += 1) {
    const type = data[row * rowLength];
    for (let column = 0; column < columns; column += 1) {
      const raw = data[row * rowLength + 1 + column];
      const left = column ? output[row * columns + column - 1] : 0;
      const up = row ? output[(row - 1) * columns + column] : 0;
      const upLeft = row && column ? output[(row - 1) * columns + column - 1] : 0;
      let value = raw;
      if (type === 1) value = raw + left;
      else if (type === 2) value = raw + up;
      else if (type === 3) value = raw + Math.floor((left + up) / 2);
      else if (type === 4) {
        const estimate = left + up - upLeft;
        const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        value = raw + (distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upLeft);
      }
      output[row * columns + column] = value & 0xff;
    }
  }
  return output;
}

/**
 * @typedef {{
 *   cameraToWorld: number[] | null; centerOfOrbit: number | null;
 *   projection: { orthographic: boolean; fov: number | null; scale: number | null; binding: string };
 *   background: [number, number, number] | null; name: string
 * }} Pdf3dView
 * @typedef {{ format: 'PRC' | 'U3D' | 'unknown'; data: Uint8Array; view: Pdf3dView | null; views: Pdf3dView[] }} Pdf3dContent
 */

/**
 * @param {PdfObjects} objects
 * @param {number} annotationRef object number of the /Subtype /3D annotation
 * @returns {Promise<Pdf3dContent | null>}
 */
export async function load3dAnnotation(objects, annotationRef) {
  if (objects.encrypted) throw new Error('3D content in encrypted PDFs is not supported yet.');
  const annotation = await objects.get(annotationRef);
  if (!isDict(annotation) || !isName(annotation.dict.Subtype) || annotation.dict.Subtype.name !== '3D') return null;
  let stream = await objects.resolve(annotation.dict['3DD']);
  // A 3D reference dictionary points at a stream shared with another annotation.
  if (isDict(stream) && !('data' in stream) && stream.dict['3DD']) stream = await objects.resolve(stream.dict['3DD']);
  if (!isDict(stream) || !('data' in stream)) return null;
  const subtype = isName(stream.dict.Subtype) ? stream.dict.Subtype.name : '';
  const data = await objects.streamData(/** @type {PdfStream} */ (stream));

  const viewList = await objects.resolve(stream.dict.VA);
  /** @type {Pdf3dView[]} */
  const views = [];
  if (Array.isArray(viewList)) {
    for (const entry of viewList) {
      const view = await readView(objects, entry);
      if (view) views.push(view);
    }
  }
  const selector = annotation.dict['3DV'] ?? stream.dict.DV;
  const view = await pickView(objects, selector, views);
  return {
    format: subtype === 'PRC' ? 'PRC' : subtype === 'U3D' ? 'U3D' : 'unknown',
    data,
    view,
    views
  };
}

/** @param {PdfObjects} objects @param {PdfValue | undefined} selector @param {Pdf3dView[]} views */
async function pickView(objects, selector, views) {
  const value = await objects.resolve(selector);
  if (typeof value === 'number') return views[value] ?? views[0] ?? null;
  if (isName(value)) {
    if (value.name === 'L') return views[views.length - 1] ?? null;
    return views[0] ?? null;
  }
  if (typeof value === 'string') return views.find((view) => view.name === value) ?? views[0] ?? null;
  if (isDict(value)) return readView(objects, value);
  return views[0] ?? null;
}

/** @param {PdfObjects} objects @param {PdfValue | undefined} entry @returns {Promise<Pdf3dView | null>} */
async function readView(objects, entry) {
  const view = await objects.resolve(entry);
  if (!isDict(view)) return null;
  const { dict } = view;
  const matrix = await objects.resolve(dict.C2W);
  const usesMatrix = !isName(dict.MS) || dict.MS.name === 'M';
  const cameraToWorld = usesMatrix && Array.isArray(matrix) && matrix.length >= 12 && matrix.every((value) => typeof value === 'number')
    ? /** @type {number[]} */ (matrix.slice(0, 12))
    : null;
  const projection = await objects.resolve(dict.P);
  let orthographic = false;
  let fov = null;
  let scale = null;
  let binding = 'W';
  if (isDict(projection)) {
    const bindingValue = await objects.resolve(projection.dict.PS ?? projection.dict.OB);
    if (isName(bindingValue)) binding = bindingValue.name;
    orthographic = isName(projection.dict.Subtype) && projection.dict.Subtype.name === 'O';
    const fovValue = await objects.resolve(projection.dict.FOV);
    if (typeof fovValue === 'number') fov = fovValue;
    const scaleValue = await objects.resolve(projection.dict.OS);
    if (typeof scaleValue === 'number') scale = scaleValue;
  }
  const backgroundDict = await objects.resolve(dict.BG);
  let background = /** @type {[number, number, number] | null} */ (null);
  if (isDict(backgroundDict)) {
    const color = await objects.resolve(backgroundDict.dict.C);
    if (Array.isArray(color) && color.length >= 3) background = [Number(color[0]), Number(color[1]), Number(color[2])];
    else background = [1, 1, 1];
  }
  const center = await objects.resolve(dict.CO);
  const name = await objects.resolve(dict.XN ?? dict.IN);
  return {
    cameraToWorld,
    centerOfOrbit: typeof center === 'number' ? center : null,
    projection: { orthographic, fov, scale, binding },
    background,
    name: typeof name === 'string' ? name : ''
  };
}
