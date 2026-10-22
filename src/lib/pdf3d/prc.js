import { DOUBLE_CODES, EXPONENT_CODE_RUNS } from './prc-double-table.js';
import { decodeCompressedTess, readCompressedTess } from './prc-hct.js';

/**
 * Reader for PRC (ISO 14739-1), the 3D format Acrobat embeds in PDFs. Only the
 * parts needed to show a model are decoded: tessellated meshes, their colors
 * and the placement of each part. Exact B-rep geometry is skipped; exporters
 * always store a tessellation next to it for display.
 */

const TYPE = {
  TESS_3D: 172,
  TESS_3D_COMPRESSED: 173,
  TESS_FACE: 174,
  TESS_3D_WIRE: 175,
  TESS_MARKUP: 176,
  MISC_ATTRIBUTE: 201,
  MISC_CARTESIAN_TRANSFORMATION: 202,
  MISC_ENTITY_REFERENCE: 203,
  MISC_MARKUP_LINKED_ITEM: 204,
  MISC_REFERENCE_ON_PRC_BASE: 205,
  MISC_REFERENCE_ON_TOPOLOGY: 206,
  MISC_GENERAL_TRANSFORMATION: 207,
  RI_BREP_MODEL: 232,
  RI_CURVE: 233,
  RI_DIRECTION: 234,
  RI_PLANE: 235,
  RI_POINT_SET: 236,
  RI_POLY_BREP_MODEL: 237,
  RI_POLY_WIRE: 238,
  RI_SET: 239,
  RI_COORDINATE_SYSTEM: 240,
  ASM_PRODUCT_OCCURRENCE: 310,
  ASM_PART_DEFINITION: 311,
  ASM_FILTER: 320,
  MKP_VIEW: 501,
  MKP_MARKUP: 502,
  MKP_LEADER: 503,
  MKP_ANNOTATION_ITEM: 504,
  MKP_ANNOTATION_SET: 505,
  MKP_ANNOTATION_REFERENCE: 506,
  GRAPH_STYLE: 701,
  GRAPH_MATERIAL: 702,
  GRAPH_PICTURE: 703,
  GRAPH_TEXTURE_APPLICATION: 711,
  GRAPH_TEXTURE_DEFINITION: 712,
  GRAPH_TEXTURE_TRANSFORMATION: 713,
  GRAPH_LINE_PATTERN: 721,
  GRAPH_DOTTING_PATTERN: 723,
  GRAPH_HATCHING_PATTERN: 724,
  GRAPH_SOLID_PATTERN: 725,
  GRAPH_VPICTURE_PATTERN: 726,
  GRAPH_AMBIENT_LIGHT: 731,
  GRAPH_POINT_LIGHT: 732,
  GRAPH_DIRECTIONAL_LIGHT: 733,
  GRAPH_SPOT_LIGHT: 734,
  GRAPH_SCENE_DISPLAY_PARAMETERS: 741,
  GRAPH_CAMERA: 742
};

/** Types whose base data carries CAD and PRC identifiers. */
const REFERENCEABLE = new Set([
  TYPE.MISC_ENTITY_REFERENCE, TYPE.MISC_MARKUP_LINKED_ITEM, TYPE.RI_BREP_MODEL, TYPE.RI_CURVE,
  TYPE.RI_DIRECTION, TYPE.RI_PLANE, TYPE.RI_POINT_SET, TYPE.RI_POLY_BREP_MODEL, TYPE.RI_POLY_WIRE,
  TYPE.RI_SET, TYPE.RI_COORDINATE_SYSTEM, TYPE.ASM_PRODUCT_OCCURRENCE, TYPE.ASM_PART_DEFINITION,
  TYPE.ASM_FILTER, TYPE.MKP_VIEW, TYPE.MKP_MARKUP, TYPE.MKP_LEADER, TYPE.MKP_ANNOTATION_ITEM,
  TYPE.MKP_ANNOTATION_SET, TYPE.MKP_ANNOTATION_REFERENCE, TYPE.GRAPH_STYLE, TYPE.GRAPH_MATERIAL,
  TYPE.GRAPH_TEXTURE_APPLICATION, TYPE.GRAPH_TEXTURE_DEFINITION, TYPE.GRAPH_LINE_PATTERN,
  TYPE.GRAPH_DOTTING_PATTERN, TYPE.GRAPH_HATCHING_PATTERN, TYPE.GRAPH_SOLID_PATTERN,
  TYPE.GRAPH_VPICTURE_PATTERN, TYPE.GRAPH_AMBIENT_LIGHT, TYPE.GRAPH_POINT_LIGHT,
  TYPE.GRAPH_DIRECTIONAL_LIGHT, TYPE.GRAPH_SPOT_LIGHT, TYPE.GRAPH_SCENE_DISPLAY_PARAMETERS,
  TYPE.GRAPH_CAMERA
]);

const FACE = {
  POLYFACE: 0x0001,
  TRIANGLE: 0x0002,
  FAN: 0x0004,
  STRIPE: 0x0008,
  POLYFACE_ONE_NORMAL: 0x0010,
  TRIANGLE_ONE_NORMAL: 0x0020,
  FAN_ONE_NORMAL: 0x0040,
  STRIPE_ONE_NORMAL: 0x0080,
  TEXTURED_SHIFT: 8
};
const NORMAL_SINGLE = 0x40000000;
const NORMAL_MASK = 0x3fffffff;

/** Huffman code (bit count * 2^22 + code) -> { exponent } or { value }. */
/** @type {Map<number, { exponent?: number; value?: number }> | null} */
let doubleCodes = null;

function getDoubleCodes() {
  if (doubleCodes) return doubleCodes;
  doubleCodes = new Map();
  let exponent = 0;
  for (const [bits, first, count] of EXPONENT_CODE_RUNS) {
    for (let offset = 0; offset < count; offset += 1) {
      doubleCodes.set(bits * 0x400000 + first + offset, { exponent: exponent++ });
    }
  }
  const view = new DataView(new ArrayBuffer(8));
  for (const [bits, code, high, low] of DOUBLE_CODES) {
    view.setUint32(0, high);
    view.setUint32(4, low);
    doubleCodes.set(bits * 0x400000 + code, { value: view.getFloat64(0) });
  }
  return doubleCodes;
}

export class PrcFormatError extends Error {}

/** MSB-first bit reader with PRC's variable-length number encodings. */
export class BitReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
    this.scratch = new DataView(new ArrayBuffer(8));
    /** Names and graphics repeat the previous one when flagged "same". */
    this.currentName = '';
    this.currentGraphics = { layer: -1, style: -1, behaviour: 1 };
  }

  bit() {
    const byte = this.bytes[this.position >> 3];
    if (byte === undefined) throw new PrcFormatError('Unexpected end of PRC data.');
    const value = (byte >> (7 - (this.position & 7))) & 1;
    this.position += 1;
    return value;
  }

  /** @param {number} count */
  bits(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) value = value * 2 + this.bit();
    return value;
  }

  bool() {
    return this.bit() === 1;
  }

  char() {
    return this.bits(8);
  }

  uint() {
    let value = 0;
    let factor = 1;
    while (this.bit()) {
      value += this.bits(8) * factor;
      factor *= 256;
      if (factor > 2 ** 40) throw new PrcFormatError('PRC integer out of range.');
    }
    return value;
  }

  int() {
    let value = 0;
    let factor = 1;
    let last = 0;
    while (this.bit()) {
      last = this.bits(8);
      value += last * factor;
      factor *= 256;
      if (factor > 2 ** 40) throw new PrcFormatError('PRC integer out of range.');
    }
    return last & 0x80 ? value - factor : value;
  }

  string() {
    if (!this.bool()) return '';
    const length = this.uint();
    if (length > this.bytes.length) throw new PrcFormatError('PRC string out of range.');
    const chars = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) chars[index] = this.char();
    return new TextDecoder().decode(chars);
  }

  double() {
    const codes = getDoubleCodes();
    let code = 0;
    let entry;
    for (let bits = 1; bits <= 22 && !entry; bits += 1) {
      code = code * 2 + this.bit();
      entry = codes.get(bits * 0x400000 + code);
    }
    if (!entry) throw new PrcFormatError('Invalid PRC double.');
    if (entry.value === 0) return 0;
    const negative = this.bit();
    if (entry.value !== undefined) return negative ? -entry.value : entry.value;

    const bytes = new Uint8Array(8);
    const exponent = /** @type {number} */ (entry.exponent);
    bytes[7] = (negative << 7) | (exponent >> 4);
    bytes[6] = (exponent & 0x0f) << 4;
    if (this.bool()) {
      bytes[6] |= this.bits(4);
      // Mantissa bytes, most significant first; a back reference repeats an
      // earlier byte, distance 0 fills the rest and 6 fills all but the last.
      for (let index = 5; index >= 0; index -= 1) {
        if (this.bool()) {
          bytes[index] = this.char();
          continue;
        }
        const distance = this.bits(3);
        if (distance === 0 || distance === 6) {
          const fill = bytes[index + 1];
          for (let rest = index; rest >= 0; rest -= 1) bytes[rest] = fill;
          if (distance === 6) bytes[0] = this.char();
          break;
        }
        bytes[index] = bytes[index + distance];
      }
    }
    for (let index = 0; index < 8; index += 1) this.scratch.setUint8(index, bytes[7 - index]);
    return this.scratch.getFloat64(0);
  }

  vector3() {
    return [this.double(), this.double(), this.double()];
  }

  /** @param {number} [count] */
  skipUserData(count) {
    const bits = count ?? this.uint();
    this.position += bits;
    if (this.position > this.bytes.length * 8) throw new PrcFormatError('Unexpected end of PRC data.');
  }

  name() {
    if (!this.bool()) this.currentName = this.string();
    return this.currentName;
  }

  attributes() {
    const count = this.uint();
    for (let index = 0; index < count; index += 1) {
      this.expectType(TYPE.MISC_ATTRIBUTE);
      this.attributeEntry();
      const keys = this.uint();
      for (let key = 0; key < keys; key += 1) {
        this.attributeEntry();
        const type = this.uint();
        if (type === 1) this.int();
        else if (type === 2) this.double();
        else if (type === 3) this.uint();
        else if (type === 4) this.string();
      }
    }
  }

  attributeEntry() {
    if (this.bool()) this.uint();
    else this.string();
  }

  /** @param {number} type */
  contentBase(type) {
    this.attributes();
    const name = this.name();
    if (REFERENCEABLE.has(type)) {
      this.uint();
      this.uint();
      this.uint();
    }
    return name;
  }

  graphics() {
    if (!this.bool()) {
      this.currentGraphics = { layer: this.uint() - 1, style: this.uint() - 1, behaviour: this.char() | (this.char() << 8) };
    }
    return { ...this.currentGraphics };
  }

  resetState() {
    this.currentName = '';
    this.currentGraphics = { layer: -1, style: -1, behaviour: 1 };
  }

  /** @param {number} type */
  expectType(type) {
    const found = this.uint();
    if (found !== type) throw new PrcFormatError(`Expected PRC type ${type}, found ${found}.`);
  }
}

/**
 * @typedef {{ positions: Float32Array; normals: Float32Array | null; faceStyles: Int32Array | null; colors: Float32Array | null }} PrcTriangles
 * @typedef {{ kind: 'mesh'; triangles: PrcTriangles } | { kind: 'lines'; positions: Float32Array; colors: Float32Array | null } | { kind: 'other' }} PrcTessellation
 * @typedef {{ color: [number, number, number]; opacity: number; lineWidth: number; visible: boolean }} PrcStyle
 * @typedef {{ tessellation: number; style: number; matrix: number[]; kind: 'mesh' | 'lines' | 'points'; points?: number[] }} PrcItem
 * @typedef {{ items: PrcItem[]; tessellations: PrcTessellation[]; styles: PrcStyle[]; unit: number; warnings: string[] }} PrcModel
 */

/**
 * @param {Uint8Array} data an uncompressed /Subtype /PRC stream
 * @param {(bytes: Uint8Array) => Promise<Uint8Array>} inflate zlib decompressor
 * @returns {Promise<PrcModel>}
 */
export async function parsePrc(data, inflate) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (String.fromCharCode(data[0], data[1], data[2]) !== 'PRC') throw new PrcFormatError('Not a PRC stream.');
  let offset = 3 + 4 + 4 + 16 + 16;
  const structureCount = view.getUint32(offset, true);
  offset += 4;
  /** @type {number[][]} */
  const structureOffsets = [];
  for (let index = 0; index < structureCount; index += 1) {
    offset += 16 + 4;
    const count = view.getUint32(offset, true);
    offset += 4;
    const offsets = [];
    for (let entry = 0; entry < count; entry += 1) offsets.push(view.getUint32(offset + entry * 4, true));
    offset += count * 4;
    structureOffsets.push(offsets);
  }

  /** @type {PrcModel} */
  const model = { items: [], tessellations: [], styles: [], unit: 1, warnings: [] };
  for (const offsets of structureOffsets) {
    // offsets: [header, globals, tree, tessellation, geometry, extra geometry]
    if (offsets.length < 4) continue;
    /** @param {number} section */
    const sectionBytes = (section) => {
      const start = offsets[section];
      const end = offsets[section + 1] ?? data.length;
      return inflate(data.subarray(start, Math.max(start, end)));
    };
    const base = { tessellations: model.tessellations.length, styles: model.styles.length };
    try {
      const tessellation = new BitReader(await sectionBytes(3));
      model.tessellations.push(...readTessellationSection(tessellation, model.warnings));
    } catch (error) {
      model.warnings.push(`Tessellation: ${error instanceof Error ? error.message : error}`);
    }
    try {
      const globals = new BitReader(await sectionBytes(1));
      model.styles.push(...readGlobalsSection(globals));
    } catch (error) {
      model.warnings.push(`Globals: ${error instanceof Error ? error.message : error}`);
    }
    let treeItems = null;
    try {
      treeItems = readTreeSection(new BitReader(await sectionBytes(2)));
    } catch (error) {
      model.warnings.push(`Tree: ${error instanceof Error ? error.message : error}`);
    }
    if (treeItems?.length) {
      for (const item of treeItems) {
        model.items.push({
          ...item,
          tessellation: item.tessellation < 0 ? -1 : item.tessellation + base.tessellations,
          style: item.style < 0 ? -1 : item.style + base.styles
        });
      }
    } else {
      // Without a readable tree, show every tessellation in place.
      for (let index = base.tessellations; index < model.tessellations.length; index += 1) {
        const tess = model.tessellations[index];
        if (tess.kind === 'other') continue;
        model.items.push({ tessellation: index, style: -1, matrix: identity(), kind: tess.kind });
      }
    }
  }
  return model;
}


/** @param {BitReader} reader @param {string[]} warnings */
function readTessellationSection(reader, warnings) {
  reader.expectType(TYPE_FILE_STRUCTURE_TESSELLATION);
  reader.contentBase(0);
  const count = reader.uint();
  /** @type {PrcTessellation[]} */
  const tessellations = [];
  for (let index = 0; index < count; index += 1) {
    const type = reader.uint();
    if (type === TYPE.TESS_3D) tessellations.push(read3dTess(reader));
    else if (type === TYPE.TESS_3D_WIRE) tessellations.push(readWireTess(reader));
    else if (type === TYPE.TESS_3D_COMPRESSED) {
      const data = readCompressedTess(reader);
      try {
        tessellations.push({ kind: 'mesh', triangles: decodeCompressedTess(data) });
      } catch (error) {
        warnings.push(`Compressed tessellation ${index}: ${error instanceof Error ? error.message : error}`);
        tessellations.push({ kind: 'other' });
      }
    } else if (type === TYPE.TESS_MARKUP) {
      readMarkupTess(reader);
      tessellations.push({ kind: 'other' });
    } else {
      // Unknown entities have no length prefix, so nothing after them can be
      // located.
      warnings.push(`Unknown PRC tessellation type ${type}.`);
      break;
    }
  }
  return tessellations;
}

const TYPE_FILE_STRUCTURE_GLOBALS = 303;
const TYPE_FILE_STRUCTURE_TREE = 304;
const TYPE_FILE_STRUCTURE_TESSELLATION = 305;

/** @param {BitReader} reader */
function readBaseTessData(reader) {
  reader.bool(); // is_calculated
  const count = reader.uint();
  const coordinates = new Float64Array(count);
  for (let index = 0; index < count; index += 1) coordinates[index] = reader.double();
  return coordinates;
}

/** @param {BitReader} reader @returns {PrcTessellation} */
function read3dTess(reader) {
  const coordinates = readBaseTessData(reader);
  reader.bool(); // has_faces
  reader.bool(); // has_loops
  if (reader.bool()) {
    reader.char(); // normals recalculation flags
    reader.double(); // crease angle
  }
  const normalCount = reader.uint();
  const normals = new Float64Array(normalCount);
  for (let index = 0; index < normalCount; index += 1) normals[index] = reader.double();
  const wireCount = reader.uint();
  for (let index = 0; index < wireCount; index += 1) reader.uint();
  const indexCount = reader.uint();
  const indices = new Uint32Array(indexCount);
  for (let index = 0; index < indexCount; index += 1) indices[index] = reader.uint();
  const faceCount = reader.uint();
  const faces = [];
  for (let index = 0; index < faceCount; index += 1) faces.push(readTessFace(reader));
  const textureCount = reader.uint();
  for (let index = 0; index < textureCount; index += 1) reader.double();
  return { kind: 'mesh', triangles: triangulate(coordinates, normals, indices, faces) };
}

/**
 * @typedef {{ lineAttributes: number[]; flags: number; start: number; sizes: number[]; textureIndexes: number; colors: Uint8Array | null; rgba: boolean }} TessFace
 */

/** @param {BitReader} reader @returns {TessFace} */
function readTessFace(reader) {
  reader.expectType(TYPE.TESS_FACE);
  const lineAttributeCount = reader.uint();
  const lineAttributes = [];
  for (let index = 0; index < lineAttributeCount; index += 1) lineAttributes.push(reader.uint() - 1);
  reader.uint(); // start_wire
  const wireSizes = reader.uint();
  for (let index = 0; index < wireSizes; index += 1) reader.uint();
  const flags = reader.uint();
  const start = reader.uint();
  const sizeCount = reader.uint();
  const sizes = [];
  for (let index = 0; index < sizeCount; index += 1) sizes.push(reader.uint());
  const textureIndexes = reader.uint();
  /** @type {Uint8Array | null} */
  let colors = null;
  let rgba = false;
  if (reader.bool()) {
    rgba = reader.bool();
    if (reader.bool()) throw new PrcFormatError('Optimised PRC vertex colors are not supported.');
    const components = rgba ? 4 : 3;
    const vertices = forEachTriangle({ flags, sizes }, () => {});
    colors = new Uint8Array(Math.max(1, vertices) * components);
    for (let index = 0; index < components; index += 1) colors[index] = reader.char();
    for (let vertex = 1; vertex < vertices; vertex += 1) {
      const same = reader.bool();
      for (let index = 0; index < components; index += 1) {
        colors[vertex * components + index] = same ? colors[(vertex - 1) * components + index] : reader.char();
      }
    }
  }
  if (lineAttributeCount) reader.uint(); // behaviour
  return { lineAttributes, flags, start, sizes, textureIndexes, colors, rgba };
}

/**
 * Walks a face's triangle runs in PRC's fixed order (triangles, fans, strips,
 * then their one-normal and textured variants) and reports each triangle as
 * three vertex slots: { normal slot or -1, point slot } relative to the
 * face's start. Returns the number of vertex slots used.
 * @param {{ flags: number; sizes: number[] }} face
 * @param {(kind: 'triangle', vertices: number[], triangleIndex: number) => void} emit
 * @param {{ normals: boolean; textures: number }} [layout]
 */
function forEachTriangle(face, emit, layout = { normals: false, textures: 0 }) {
  let sizeIndex = 0;
  let slot = 0;
  let vertexCount = 0;
  let triangleIndex = 0;
  const next = () => face.sizes[sizeIndex++] ?? 0;
  /** Reads one vertex: optional normal, texture slots, point. @param {boolean} withNormal */
  const vertex = (withNormal) => {
    let normal = -1;
    if (withNormal && layout.normals) normal = slot++;
    slot += layout.textures;
    const point = slot++;
    vertexCount += 1;
    return [normal, point];
  };
  /** @param {number[][]} corners */
  const triangle = (corners) => emit('triangle', corners.flat(), triangleIndex++);

  for (const textured of [false, true]) {
    const shift = textured ? FACE.TEXTURED_SHIFT : 0;
    const saved = layout.textures;
    if (!textured) layout.textures = 0;
    if (face.flags & (FACE.TRIANGLE << shift)) {
      const count = next();
      for (let index = 0; index < count; index += 1) triangle([vertex(true), vertex(true), vertex(true)]);
    }
    for (const strip of [false, true]) {
      if (!(face.flags & ((strip ? FACE.STRIPE : FACE.FAN) << shift))) continue;
      const runs = next();
      for (let run = 0; run < runs; run += 1) {
        const points = next() & NORMAL_MASK;
        const corners = [];
        for (let index = 0; index < points; index += 1) corners.push(vertex(true));
        emitRun(corners, strip, triangle);
      }
    }
    if (face.flags & (FACE.TRIANGLE_ONE_NORMAL << shift)) {
      const count = next();
      for (let index = 0; index < count; index += 1) {
        const normal = layout.normals ? slot++ : -1;
        const corners = [vertex(false), vertex(false), vertex(false)];
        for (const corner of corners) corner[0] = normal;
        triangle(corners);
      }
    }
    for (const strip of [false, true]) {
      if (!(face.flags & ((strip ? FACE.STRIPE_ONE_NORMAL : FACE.FAN_ONE_NORMAL) << shift))) continue;
      const runs = next();
      for (let run = 0; run < runs; run += 1) {
        const size = next();
        const single = (size & NORMAL_SINGLE) !== 0;
        const points = size & NORMAL_MASK;
        const normal = single && layout.normals ? slot++ : -1;
        const corners = [];
        for (let index = 0; index < points; index += 1) {
          const corner = vertex(!single);
          if (single) corner[0] = normal;
          corners.push(corner);
        }
        emitRun(corners, strip, triangle);
      }
    }
    if (face.flags & ((FACE.POLYFACE | FACE.POLYFACE_ONE_NORMAL) << shift)) {
      throw new PrcFormatError('PRC polyface tessellation is not supported.');
    }
    layout.textures = saved;
  }
  return vertexCount;
}

/**
 * @param {number[][]} corners
 * @param {boolean} strip
 * @param {(corners: number[][]) => void} triangle
 */
function emitRun(corners, strip, triangle) {
  for (let index = 2; index < corners.length; index += 1) {
    if (!strip) triangle([corners[0], corners[index - 1], corners[index]]);
    else if (index % 2 === 0) triangle([corners[index - 2], corners[index - 1], corners[index]]);
    else triangle([corners[index - 1], corners[index - 2], corners[index]]);
  }
}

/**
 * @param {Float64Array} coordinates
 * @param {Float64Array} normals
 * @param {Uint32Array} indices
 * @param {TessFace[]} faces
 * @returns {PrcTriangles}
 */
function triangulate(coordinates, normals, indices, faces) {
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const normalValues = [];
  /** @type {number[]} */
  const faceStyles = [];
  /** @type {number[]} */
  const colors = [];
  const hasNormals = normals.length > 0;
  const hasStyles = faces.some((face) => face.lineAttributes.length > 0);
  const hasColors = faces.some((face) => face.colors);
  for (const face of faces) {
    const layout = { normals: hasNormals, textures: face.textureIndexes };
    let vertexIndex = 0;
    forEachTriangle(face, (_kind, slots, triangleIndex) => {
      for (let corner = 0; corner < 3; corner += 1) {
        const normalSlot = slots[corner * 2];
        const pointSlot = slots[corner * 2 + 1];
        const point = indices[face.start + pointSlot] ?? 0;
        positions.push(coordinates[point] ?? 0, coordinates[point + 1] ?? 0, coordinates[point + 2] ?? 0);
        if (hasNormals) {
          const normal = normalSlot < 0 ? -1 : indices[face.start + normalSlot];
          if (normal === undefined || normal < 0) normalValues.push(0, 0, 0);
          else normalValues.push(normals[normal] ?? 0, normals[normal + 1] ?? 0, normals[normal + 2] ?? 0);
        }
        if (hasColors) {
          const components = face.rgba ? 4 : 3;
          const source = face.colors;
          const base = vertexIndex * components;
          if (source && base + 2 < source.length) colors.push(source[base] / 255, source[base + 1] / 255, source[base + 2] / 255);
          else colors.push(1, 1, 1);
          vertexIndex += 1;
        }
      }
      if (hasStyles) {
        const attributes = face.lineAttributes;
        faceStyles.push(attributes.length === 1 ? attributes[0] : attributes[triangleIndex] ?? -1);
      }
    }, layout);
  }
  // A normal of (0, 0, 0) means "compute it", so drop normals if any are missing.
  let normalsComplete = hasNormals;
  for (let index = 0; normalsComplete && index < normalValues.length; index += 3) {
    if (normalValues[index] === 0 && normalValues[index + 1] === 0 && normalValues[index + 2] === 0) normalsComplete = false;
  }
  return {
    positions: new Float32Array(positions),
    normals: normalsComplete ? new Float32Array(normalValues) : null,
    faceStyles: hasStyles ? new Int32Array(faceStyles) : null,
    colors: hasColors ? new Float32Array(colors) : null
  };
}

const WIRE_IS_CLOSING = 0x10000000;
const WIRE_IS_CONTINUOUS = 0x20000000;
const WIRE_MASK = 0x0fffffff;

/** @param {BitReader} reader @returns {PrcTessellation} */
function readWireTess(reader) {
  const coordinates = readBaseTessData(reader);
  const count = reader.uint();
  const wireIndexes = [];
  for (let index = 0; index < count; index += 1) wireIndexes.push(reader.uint());
  /** @type {number[]} */
  const segments = [];
  /** @type {number[]} */
  let previous = [];
  let pointCount = 0;
  for (let index = 0; index < wireIndexes.length;) {
    const header = wireIndexes[index++];
    const size = header & WIRE_MASK;
    const points = wireIndexes.slice(index, index + size);
    index += size;
    pointCount += size;
    if (header & WIRE_IS_CONTINUOUS && previous.length && points.length) points.unshift(previous[previous.length - 1]);
    if (header & WIRE_IS_CLOSING && points.length > 2) points.push(points[0]);
    for (let point = 1; point < points.length; point += 1) {
      for (const offset of [points[point - 1], points[point]]) {
        segments.push(coordinates[offset] ?? 0, coordinates[offset + 1] ?? 0, coordinates[offset + 2] ?? 0);
      }
    }
    previous = points;
  }
  if (reader.bool()) {
    const rgba = reader.bool();
    reader.bool(); // is_segment_color
    if (reader.bool()) throw new PrcFormatError('Optimised PRC wire colors are not supported.');
    const components = rgba ? 4 : 3;
    for (let index = 0; index < components; index += 1) reader.char();
    for (let point = 1; point < pointCount; point += 1) {
      if (!reader.bool()) for (let index = 0; index < components; index += 1) reader.char();
    }
  }
  return { kind: 'lines', positions: new Float32Array(segments), colors: null };
}

/** @param {BitReader} reader */
function readMarkupTess(reader) {
  readBaseTessData(reader);
  const codes = reader.uint();
  for (let index = 0; index < codes; index += 1) reader.uint();
  const texts = reader.uint();
  for (let index = 0; index < texts; index += 1) reader.string();
  reader.string(); // label
  reader.char(); // behaviour
}

/**
 * @param {BitReader} reader
 * @returns {PrcStyle[]}
 */
function readGlobalsSection(reader) {
  const schemas = reader.uint();
  for (let index = 0; index < schemas; index += 1) {
    reader.uint(); // entity type
    const tokens = reader.uint();
    for (let token = 0; token < tokens; token += 1) reader.int();
  }
  reader.expectType(TYPE_FILE_STRUCTURE_GLOBALS);
  reader.contentBase(0);
  const referencedStructures = reader.uint();
  for (let index = 0; index < referencedStructures * 4; index += 1) reader.uint();
  reader.double(); // tessellation chord height ratio
  reader.double(); // tessellation angle
  reader.string(); // default font family
  const fonts = reader.uint();
  for (let index = 0; index < fonts; index += 1) {
    reader.string();
    reader.uint();
    const keys = reader.uint();
    for (let key = 0; key < keys; key += 1) {
      reader.uint();
      reader.char();
    }
  }
  const colorCount = reader.uint();
  /** @type {[number, number, number][]} */
  const colors = [];
  for (let index = 0; index < colorCount; index += 1) colors.push([reader.double(), reader.double(), reader.double()]);
  const pictures = reader.uint();
  for (let index = 0; index < pictures; index += 1) {
    reader.expectType(TYPE.GRAPH_PICTURE);
    reader.contentBase(TYPE.GRAPH_PICTURE);
    reader.int();
    reader.uint();
    reader.uint();
    reader.uint();
  }
  const textures = reader.uint();
  for (let index = 0; index < textures; index += 1) readTextureDefinition(reader);
  const materialCount = reader.uint();
  /** @type {{ diffuse: number; alpha: number; generic: number }[]} */
  const materials = [];
  for (let index = 0; index < materialCount; index += 1) {
    const type = reader.uint();
    reader.contentBase(type);
    if (type === TYPE.GRAPH_MATERIAL) {
      reader.uint();
      const diffuse = reader.uint() - 1;
      reader.uint();
      reader.uint();
      reader.double();
      reader.double();
      const alpha = reader.double();
      reader.double();
      reader.double();
      materials.push({ diffuse, alpha, generic: -1 });
    } else if (type === TYPE.GRAPH_TEXTURE_APPLICATION) {
      const generic = reader.uint() - 1;
      reader.uint();
      reader.uint();
      reader.uint();
      materials.push({ diffuse: -1, alpha: 1, generic });
    } else throw new PrcFormatError(`Unknown PRC material type ${type}.`);
  }
  const patterns = reader.uint();
  for (let index = 0; index < patterns; index += 1) {
    const type = reader.uint();
    reader.contentBase(type);
    if (type !== TYPE.GRAPH_LINE_PATTERN) throw new PrcFormatError(`Unsupported PRC line pattern ${type}.`);
    const lengths = reader.uint();
    for (let length = 0; length < lengths; length += 1) reader.double();
    reader.double();
    reader.bool();
  }
  const styleCount = reader.uint();
  /** @type {PrcStyle[]} */
  const styles = [];
  for (let index = 0; index < styleCount; index += 1) {
    reader.expectType(TYPE.GRAPH_STYLE);
    reader.contentBase(TYPE.GRAPH_STYLE);
    const lineWidth = reader.double();
    reader.bool(); // is_vpicture
    reader.uint(); // line pattern / vpicture
    const isMaterial = reader.bool();
    const colorIndex = reader.uint() - 1;
    let opacity = 1;
    if (reader.bool()) opacity = reader.char() / 255;
    for (let additional = 0; additional < 3; additional += 1) if (reader.bool()) reader.char();
    /** @type {[number, number, number]} */
    let color = [0.75, 0.75, 0.75];
    if (isMaterial) {
      let material = materials[colorIndex];
      if (material && material.generic >= 0) material = materials[material.generic];
      if (material && colors[material.diffuse]) {
        color = colors[material.diffuse];
        if (opacity === 1 && material.alpha > 0 && material.alpha < 1) opacity = material.alpha;
      }
    } else if (colors[colorIndex]) color = colors[colorIndex];
    styles.push({ color, opacity, lineWidth, visible: true });
  }
  return styles;
}

/** @param {BitReader} reader */
function readTextureDefinition(reader) {
  reader.expectType(TYPE.GRAPH_TEXTURE_DEFINITION);
  reader.contentBase(TYPE.GRAPH_TEXTURE_DEFINITION);
  reader.uint();
  const dimension = reader.char();
  if (reader.int() === 4) throw new PrcFormatError('PRC texture mapping operators are not supported.');
  reader.uint();
  const intensities = reader.uint();
  for (let index = 0; index < intensities; index += 1) reader.double();
  const components = reader.uint();
  for (let index = 0; index < components; index += 1) reader.char();
  if (reader.int() === 4) for (let index = 0; index < 4; index += 1) reader.double();
  if (reader.int() !== 0) reader.int();
  if (reader.int() !== 0) reader.int();
  if (reader.char() & 0x02) {
    reader.int();
    reader.double();
  }
  for (let index = 0; index < Math.min(3, dimension); index += 1) reader.int();
  if (reader.bit()) throw new PrcFormatError('PRC texture transformations are not supported.');
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Column-major 4x4 product a * b. @param {number[]} a @param {number[]} b */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** @param {BitReader} reader */
function readTransformation3d(reader) {
  const type = reader.uint();
  if (type === TYPE.MISC_GENERAL_TRANSFORMATION) {
    const matrix = [];
    for (let index = 0; index < 16; index += 1) matrix.push(reader.double());
    return matrix;
  }
  if (type !== TYPE.MISC_CARTESIAN_TRANSFORMATION) throw new PrcFormatError(`Unknown PRC transformation ${type}.`);
  const behaviour = reader.char();
  let origin = [0, 0, 0];
  let x = [1, 0, 0];
  let y = [0, 1, 0];
  /** @type {number[] | null} */
  let z = null;
  let scale = [1, 1, 1];
  if (behaviour & 0x01) origin = reader.vector3();
  if (behaviour & 0x20) {
    x = reader.vector3();
    y = reader.vector3();
    z = reader.vector3();
  } else if (behaviour & 0x02) {
    x = reader.vector3();
    y = reader.vector3();
  }
  if (behaviour & 0x10) scale = reader.vector3();
  else if (behaviour & 0x08) {
    const uniform = reader.double();
    scale = [uniform, uniform, uniform];
  }
  if (behaviour & 0x40) for (let index = 0; index < 4; index += 1) reader.double();
  z ??= [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  if (behaviour & 0x04) z = z.map((value) => -value);
  return [
    x[0] * scale[0], x[1] * scale[0], x[2] * scale[0], 0,
    y[0] * scale[1], y[1] * scale[1], y[2] * scale[1], 0,
    z[0] * scale[2], z[1] * scale[2], z[2] * scale[2], 0,
    origin[0], origin[1], origin[2], 1
  ];
}

/**
 * @typedef {{ tessellation: number; style: number; localSystem: number; kind: PrcItem['kind']; points?: number[]; children?: RawItem[] }} RawItem
 */

/** @param {BitReader} reader @param {number} type */
function readRepresentationItemContent(reader, type) {
  reader.contentBase(type);
  const graphics = reader.graphics();
  const localSystem = reader.uint() - 1;
  const tessellation = reader.uint() - 1;
  return { style: graphics.style, localSystem, tessellation };
}

/** @param {BitReader} reader @returns {RawItem | null} */
function readRepresentationItem(reader) {
  const type = reader.uint();
  const content = readRepresentationItemContent(reader, type);
  /** @type {RawItem | null} */
  let item = null;
  switch (type) {
    case TYPE.RI_BREP_MODEL:
      if (reader.bit()) {
        reader.uint();
        reader.uint();
      }
      reader.bool();
      item = { ...content, kind: 'mesh' };
      break;
    case TYPE.RI_POLY_BREP_MODEL:
      reader.bool();
      item = { ...content, kind: 'mesh' };
      break;
    case TYPE.RI_CURVE:
      if (reader.bit()) {
        reader.uint();
        reader.uint();
      }
      item = { ...content, kind: 'lines' };
      break;
    case TYPE.RI_POLY_WIRE:
      item = { ...content, kind: 'lines' };
      break;
    case TYPE.RI_POINT_SET: {
      const count = reader.uint();
      const points = [];
      for (let index = 0; index < count; index += 1) points.push(...reader.vector3());
      item = { ...content, kind: 'points', points };
      break;
    }
    case TYPE.RI_SET: {
      const count = reader.uint();
      const children = [];
      for (let index = 0; index < count; index += 1) {
        const child = readRepresentationItem(reader);
        if (child) children.push(child);
      }
      item = { ...content, kind: 'mesh', tessellation: -1, children };
      break;
    }
    case TYPE.RI_COORDINATE_SYSTEM:
      readTransformation3d(reader);
      break;
    default:
      throw new PrcFormatError(`Unsupported PRC representation item ${type}.`);
  }
  reader.skipUserData();
  return item;
}

/** @param {BitReader} reader */
function readEmptyMarkupsAndViews(reader) {
  for (let index = 0; index < 4; index += 1) {
    if (reader.uint() !== 0) throw new PrcFormatError('PRC markups are not supported.');
  }
  if (reader.uint() !== 0) throw new PrcFormatError('PRC views are not supported.');
}

/** @param {BitReader} reader @returns {PrcItem[]} */
function readTreeSection(reader, coordinateSystems = /** @type {number[][]} */ ([])) {
  reader.expectType(TYPE_FILE_STRUCTURE_TREE);
  reader.contentBase(0);
  /** @type {{ items: RawItem[]; style: number }[]} */
  const parts = [];
  /** @type {PrcItem[]} */
  const fallback = [];
  const partCount = reader.uint();
  try {
    for (let index = 0; index < partCount; index += 1) {
      reader.expectType(TYPE.ASM_PART_DEFINITION);
      reader.contentBase(TYPE.ASM_PART_DEFINITION);
      const graphics = reader.graphics();
      for (let value = 0; value < 6; value += 1) reader.double(); // bounding box
      const count = reader.uint();
      /** @type {RawItem[]} */
      const items = [];
      parts.push({ items, style: graphics.style });
      for (let item = 0; item < count; item += 1) {
        const parsed = readRepresentationItem(reader);
        if (parsed) items.push(parsed);
      }
      readEmptyMarkupsAndViews(reader);
      reader.skipUserData();
    }
  } catch (error) {
    // Keep what was read: every part placed at the origin still beats nothing.
    for (const part of parts) flattenItems(part.items, identity(), part.style, coordinateSystems, fallback);
    if (fallback.length) return fallback;
    throw error;
  }

  /** @type {{ part: number; prototype: number; sons: number[]; matrix: number[] | null; style: number }[]} */
  const occurrences = [];
  try {
    const occurrenceCount = reader.uint();
    for (let index = 0; index < occurrenceCount; index += 1) {
      reader.expectType(TYPE.ASM_PRODUCT_OCCURRENCE);
      reader.contentBase(TYPE.ASM_PRODUCT_OCCURRENCE);
      const graphics = reader.graphics();
      const part = reader.uint() - 1;
      const prototype = reader.uint() - 1;
      if (prototype >= 0 && !reader.bool()) for (let id = 0; id < 4; id += 1) reader.uint();
      if (reader.uint() - 1 >= 0 && !reader.bool()) for (let id = 0; id < 4; id += 1) reader.uint();
      const sonCount = reader.uint();
      const sons = [];
      for (let son = 0; son < sonCount; son += 1) sons.push(reader.uint());
      reader.char(); // product behaviour
      reader.bool(); // unit from CAD
      reader.double(); // unit
      reader.char(); // product information flags
      reader.int(); // load status
      const matrix = reader.bit() ? readTransformation3d(reader) : null;
      occurrences.push({ part, prototype, sons, matrix, style: graphics.style });
      if (reader.uint() !== 0) throw new PrcFormatError('PRC occurrence references are not supported.');
      readEmptyMarkupsAndViews(reader);
      if (reader.bit()) throw new PrcFormatError('PRC entity filters are not supported.');
      if (reader.uint() !== 0) throw new PrcFormatError('PRC display filters are not supported.');
      if (reader.uint() !== 0) throw new PrcFormatError('PRC scene display parameters are not supported.');
      reader.skipUserData();
    }
  } catch {
    // Occurrences after this point are unknown; place the remaining parts as-is.
  }

  /** @type {PrcItem[]} */
  const result = [];
  const placedParts = new Set();
  const sonIndexes = new Set(occurrences.flatMap((occurrence) => occurrence.sons));
  /** @param {number} index @param {number[]} parentMatrix @param {number} parentStyle @param {number} depth */
  const visit = (index, parentMatrix, parentStyle, depth) => {
    const occurrence = occurrences[index];
    if (!occurrence || depth > 64) return;
    const matrix = occurrence.matrix ? multiply(parentMatrix, occurrence.matrix) : parentMatrix;
    const style = occurrence.style >= 0 ? occurrence.style : parentStyle;
    let part = occurrence.part;
    let sons = occurrence.sons;
    for (let prototype = occurrence.prototype, guard = 0; prototype >= 0 && guard < 64; guard += 1) {
      const source = occurrences[prototype];
      if (!source) break;
      if (part < 0) part = source.part;
      if (!sons.length) sons = source.sons;
      prototype = source.prototype;
    }
    if (part >= 0 && parts[part]) {
      placedParts.add(part);
      flattenItems(parts[part].items, matrix, parts[part].style >= 0 ? parts[part].style : style, coordinateSystems, result);
    }
    for (const son of sons) visit(son, matrix, style, depth + 1);
  };
  occurrences.forEach((_occurrence, index) => {
    if (!sonIndexes.has(index)) visit(index, identity(), -1, 0);
  });
  parts.forEach((part, index) => {
    if (!placedParts.has(index)) flattenItems(part.items, identity(), part.style, coordinateSystems, result);
  });
  return result;
}

/**
 * @param {RawItem[]} items
 * @param {number[]} matrix
 * @param {number} style
 * @param {number[][]} coordinateSystems
 * @param {PrcItem[]} out
 */
function flattenItems(items, matrix, style, coordinateSystems, out) {
  for (const item of items) {
    const local = coordinateSystems[item.localSystem];
    const itemMatrix = local ? multiply(matrix, local) : matrix;
    const itemStyle = item.style >= 0 ? item.style : style;
    if (item.children) flattenItems(item.children, itemMatrix, itemStyle, coordinateSystems, out);
    else if (item.tessellation >= 0 || item.points) {
      out.push({ tessellation: item.tessellation, style: itemStyle, matrix: itemMatrix, kind: item.kind, points: item.points });
    }
  }
}
