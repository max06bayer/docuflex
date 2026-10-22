import { PrcFormatError } from './prc.js';

/**
 * PRC "highly compressed tessellation" (ISO 14739-1, PRC_TYPE_TESS_3D_Compressed),
 * the mesh encoding Acrobat writes by default. Ported from nanoPRC
 * (github.com/mvrhel/nanoPRC, AGPL-3.0, src/prc_parse_tess.c and
 * src/prc_decode_compressed_tess.c), keeping geometry, winding and styles;
 * smooth normals are recomputed by the viewer.
 */

/** @typedef {import('./prc.js').BitReader} BitReader */

/** Huffman-coded array (spec 10.6/10.7). Codes live in 32-bit words read LSB first. */
function readHuffman(/** @type {BitReader} */ reader, /** @type {number} */ valueBits, /** @type {number} */ wordCount) {
  const words = new Uint32Array(wordCount);
  for (let index = 0; index < wordCount; index += 1) {
    words[index] = (reader.char() | (reader.char() << 8) | (reader.char() << 16) | (reader.char() << 24)) >>> 0;
  }
  const lastBits = reader.uint();
  const totalBits = (wordCount - 1) * 32 + lastBits;
  let position = 0;
  const bit = () => {
    if (position >= totalBits) throw new PrcFormatError('Huffman data overrun.');
    const value = (words[position >>> 5] >>> (position & 31)) & 1;
    position += 1;
    return value;
  };
  /** @param {number} count */
  const bits = (count) => {
    let value = 0;
    for (let index = 0; index < count; index += 1) value += bit() * 2 ** index;
    return value;
  };
  const leafCount = bits(valueBits + 1);
  const maxCodeLength = bits(8);
  if (!leafCount || !maxCodeLength || maxCodeLength > 32) throw new PrcFormatError('Invalid Huffman table.');
  /** @type {{ left?: any; right?: any; value?: number }} */
  const root = {};
  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    const value = bits(valueBits);
    const length = bits(maxCodeLength);
    const code = bits(length);
    let node = root;
    for (let index = length - 1; index >= 0; index -= 1) {
      const side = Math.floor(code / 2 ** index) % 2 ? 'right' : 'left';
      node = node[side] ??= {};
    }
    node.value = value;
  }
  const count = bits(32);
  if (count > totalBits) throw new PrcFormatError('Invalid Huffman value count.');
  const values = new Array(count);
  let node = root;
  for (let index = 0; index < count;) {
    node = bit() ? node.right : node.left;
    if (!node) throw new PrcFormatError('Invalid Huffman code.');
    if (node.value !== undefined) {
      values[index++] = node.value;
      node = root;
    }
  }
  return values;
}

/**
 * @param {BitReader} reader
 * @param {number} valueBits
 * @param {boolean | null} compressed null: no flag bit, decided by the caller
 * @returns {number[]}
 */
function readCharacterArray(reader, valueBits, compressed) {
  const isCompressed = compressed ?? reader.bool();
  const size = reader.uint();
  if (!size) return [];
  if (isCompressed) return readHuffman(reader, valueBits, size);
  const values = new Array(size);
  for (let index = 0; index < size; index += 1) values[index] = reader.char();
  return values;
}

/** @param {BitReader} reader @param {number} valueBits */
function readShortArray(reader, valueBits) {
  const compressed = reader.bool();
  const size = reader.uint();
  if (!size) return [];
  if (compressed) return readHuffman(reader, valueBits, size);
  const values = new Array(size);
  for (let index = 0; index < size; index += 1) values[index] = reader.char() | (reader.char() << 8);
  return values;
}

/** @param {BitReader} reader @param {number} length */
function readUintBits(reader, length) {
  if (length > 32 || length < 0) throw new PrcFormatError('Invalid PRC bit width.');
  return reader.bits(length);
}

/** Sign bit then magnitude. @param {BitReader} reader @param {number} length */
function readIntBits(reader, length) {
  const negative = reader.bit();
  const value = readUintBits(reader, length - 1);
  return negative ? -value : value;
}

/** @param {BitReader} reader */
function readCompressedIntegerArray(reader) {
  const lengths = readCharacterArray(reader, 6, null);
  return lengths.map((length) => readIntBits(reader, length));
}

/**
 * Difference-coded indices whose bit widths are themselves difference-coded
 * as 6-bit two's complement.
 * @param {BitReader} reader
 * @param {boolean | null} compressed
 */
function readCompressedIndiceArray(reader, compressed) {
  const lengths = readCharacterArray(reader, 6, compressed);
  if (!lengths.length) return [];
  const signed = lengths.map((length) => (length >= 32 ? length - 64 : length));
  let width = signed[0];
  const values = [readIntBits(reader, width)];
  for (let index = 1; index < signed.length; index += 1) {
    width += signed[index];
    values.push(readIntBits(reader, width) + values[index - 1]);
  }
  return values;
}

/** @param {BitReader} reader */
function readFloat(reader) {
  const view = new DataView(new ArrayBuffer(4));
  for (let index = 3; index >= 0; index -= 1) view.setUint8(index, reader.char());
  return view.getFloat32(0);
}

/**
 * @typedef {{
 *   tolerance: number; origin: number[]; points: number[]; edgeStatus: number[];
 *   triangleFaces: number[]; faceCount: number; isReference: number[]; references: number[];
 *   mustRecalculateNormals: boolean; normalIsReversed: number[]; normalAngleBits: number;
 *   normalBinary: number[]; normalAngles: number[]; isFacePlanar: number[];
 *   pointColors: number[]; multipleLineAttributeOnFace: number[] | null; lineAttributes: number[]
 * }} HctData
 */

/** @param {BitReader} reader @returns {HctData} */
export function readCompressedTess(reader) {
  reader.bit(); // is_calculated
  reader.bit(); // has_faces
  const tolerance = reader.double();
  const origin = [readFloat(reader), readFloat(reader), readFloat(reader)];
  const points = readCompressedIntegerArray(reader);
  const edgeStatus = readCharacterArray(reader, 2, null);
  const triangleFaces = readCompressedIndiceArray(reader, null);
  const faceCount = triangleFaces.reduce((max, face) => Math.max(max, face), 0) + 1;
  const referenceSize = reader.uint();
  const isReference = [];
  let referenceCount = 0;
  for (let index = 0; index < referenceSize; index += 1) {
    const value = reader.bit();
    isReference.push(value);
    referenceCount += value;
  }
  const references = readCompressedIndiceArray(reader, referenceCount > 3);
  const mustRecalculateNormals = reader.bool();
  /** @type {number[]} */
  const normalIsReversed = [];
  let normalAngleBits = 0;
  /** @type {number[]} */
  const normalBinary = [];
  /** @type {number[]} */
  let normalAngles = [];
  /** @type {number[]} */
  const isFacePlanar = [];
  if (mustRecalculateNormals) {
    for (let index = 0; index < triangleFaces.length; index += 1) normalIsReversed.push(reader.bit());
    reader.double(); // crease angle
    reader.char(); // normal recalculation flags
  } else {
    normalAngleBits = reader.char();
    const binarySize = reader.uint();
    for (let index = 0; index < binarySize; index += 1) normalBinary.push(reader.bit());
    normalAngles = readShortArray(reader, normalAngleBits);
    for (let index = 0; index < faceCount; index += 1) isFacePlanar.push(reader.bit());
  }
  /** @type {number[]} */
  let pointColors = [];
  if (reader.bool()) {
    for (let index = 0; index < faceCount; index += 1) reader.bit();
    pointColors = readCharacterArray(reader, 8, null);
  }
  /** @type {number[] | null} */
  let multipleLineAttributeOnFace = null;
  if (reader.bool()) {
    multipleLineAttributeOnFace = [];
    for (let index = 0; index < faceCount; index += 1) multipleLineAttributeOnFace.push(reader.bit());
  }
  const lineAttributes = readShortArray(reader, 16);
  if (!reader.bool()) {
    // Texture data: parsed only to stay in sync.
    const words = reader.uint();
    for (let index = 0; index < words * 4; index += 1) reader.char();
    reader.uint();
    const referenceArray = reader.uint();
    for (let index = 0; index < referenceArray; index += 1) readUintBits(reader, readUintBits(reader, 5));
    reader.double();
    const parameters = reader.uint();
    for (let index = 0; index < parameters; index += 1) readFloat(reader);
    if (!reader.bool()) for (let index = 0; index < faceCount; index += 1) reader.bit();
  }
  if (reader.bool()) readCharacterArray(reader, 8, null); // behaviours
  return {
    tolerance, origin, points, edgeStatus, triangleFaces, faceCount, isReference, references,
    mustRecalculateNormals, normalIsReversed, normalAngleBits, normalBinary, normalAngles,
    isFacePlanar, pointColors, multipleLineAttributeOnFace, lineAttributes
  };
}

/** @typedef {[number, number, number]} Vec */

const FLT_EPSILON = 1.1920928955078125e-7;
const HALF_PI = Math.PI / 2;

/** @param {Vec} a @param {Vec} b @returns {Vec} */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {Vec} a @param {Vec} b @returns {Vec} */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {Vec} a @param {Vec} b @returns {Vec} */
const avg = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
/** @param {Vec} a @param {number} s @returns {Vec} */
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {Vec} a @returns {Vec} */
const negate = (a) => [-a[0], -a[1], -a[2]];
/** @param {Vec} a @param {Vec} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec} a @param {Vec} b @returns {Vec} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** @param {Vec} a @returns {Vec | null} null when too short to normalize */
function normalize(a) {
  const length = Math.sqrt(dot(a, a));
  return length >= FLT_EPSILON ? [a[0] / length, a[1] / length, a[2] / length] : null;
}

/** @param {Vec} a @param {string} what @returns {Vec} */
function mustNormalize(a, what) {
  const result = normalize(a);
  if (!result) throw new PrcFormatError(`Degenerate ${what} in compressed tessellation.`);
  return result;
}

/** MakeOrthoRep (spec 10.3). @param {Vec} x @returns {{ x: Vec; y: Vec; z: Vec } | null} */
function orthonormalBasis(x) {
  const unitX = normalize(x);
  if (!unitX) return null;
  let z = normalize(cross(unitX, [0, 1, 0]));
  z ??= normalize(cross(unitX, [1, 0, 0]));
  if (!z) return null;
  const y = normalize(cross(z, unitX));
  return y ? { x: unitX, y, z } : null;
}

/** Distance of the angle between two vectors from a right angle. @param {Vec} a @param {Vec} b */
function angleFromRight(a, b) {
  const cosine = dot(mustNormalize(a, 'edge'), mustNormalize(b, 'edge'));
  if (cosine > 1 - 1e-12 || cosine < -1 + 1e-12) return HALF_PI;
  return Math.abs(Math.abs(Math.acos(cosine)) - HALF_PI);
}

/** The spec's Taylor approximations, kept so orientation tests match the encoder. */
/** @param {number} x @returns {number} */
function taylorCos(x) {
  if (x > Math.PI / 4) return taylorSin(HALF_PI - x);
  return 1 - (x * x) / 2 + (x ** 4) / 24 - (x ** 6) / 720;
}
/** @param {number} x @returns {number} */
function taylorSin(x) {
  if (x > Math.PI / 4) return taylorCos(HALF_PI - x);
  return x - (x ** 3) / 6 + (x ** 5) / 120 - (x ** 7) / 5040;
}

/**
 * Rebuilds a vertex normal from two angles in a frame derived from the
 * triangle's best-shaped corner.
 * @param {Vec[]} points @param {number} theta @param {number} phi
 * @param {number} triReversed @param {number} xReversed @param {number} yReversed
 * @returns {Vec}
 */
function vertexNormal(points, theta, phi, triReversed, xReversed, yReversed) {
  const [v1, v2, v3] = points;
  const n1 = mustNormalize(sub(v2, v1), 'edge');
  const n2 = mustNormalize(sub(v3, v1), 'edge');
  const n3 = mustNormalize(sub(v3, v2), 'edge');
  const theta1 = angleFromRight(n1, n2);
  const theta2 = angleFromRight(n3, negate(n1));
  const theta3 = angleFromRight(negate(n2), negate(n3));
  /** @type {Vec} */ let x;
  /** @type {Vec} */ let z;
  if (theta1 < theta2 && theta1 < theta3) {
    x = n1;
    z = cross(n1, n2);
  } else if (theta2 < theta3) {
    x = n3;
    z = cross(negate(n3), n1);
  } else {
    x = negate(n2);
    z = cross(n2, n3);
  }
  let unitZ = normalize(z);
  if (!unitZ) {
    const basis = orthonormalBasis(x);
    if (!basis) throw new PrcFormatError('Degenerate normal frame in compressed tessellation.');
    unitZ = basis.z;
  }
  if (triReversed) unitZ = negate(unitZ);
  let y = mustNormalize(cross(unitZ, x), 'normal frame');
  if (xReversed) x = negate(x);
  if (yReversed) y = negate(y);
  const cosPhi = taylorCos(phi);
  return mustNormalize(add(add(scale(x, taylorCos(theta) * cosPhi), scale(y, taylorSin(theta) * cosPhi)), scale(unitZ, taylorSin(phi))), 'normal');
}

/** @param {number} value */
function bitsForUnsigned(value) {
  let bits = 1;
  for (let limit = 1; value > limit; limit *= 2) bits += 1;
  return bits;
}

/**
 * @typedef {{ points: Vec[]; index: number[]; normals: number[]; reversed: boolean;
 *   left: { a: number; b: number; far: number; open: boolean };
 *   right: { a: number; b: number; far: number; open: boolean } }} Triangle
 * @typedef {{ x: Vec; y: Vec; z: Vec; origin: Vec; v0: Vec; v1: Vec; index0: number; index1: number }} Gate
 */

/** @param {HctData} data @returns {import('./prc.js').PrcTriangles} */
export function decodeCompressedTess(data) {
  const triangleCount = data.triangleFaces.length;
  const pointCount = Math.floor(data.points.length / 3);
  if (!triangleCount || pointCount < 3) {
    return { positions: new Float32Array(0), normals: null, faceStyles: null, colors: null };
  }
  const tolerance = data.tolerance;
  const origin = /** @type {Vec} */ (data.origin);
  /** @param {number} index @returns {Vec} */
  const scaled = (index) => {
    if (index >= pointCount) throw new PrcFormatError('Compressed tessellation ran out of points.');
    return [data.points[index * 3] * tolerance, data.points[index * 3 + 1] * tolerance, data.points[index * 3 + 2] * tolerance];
  };
  /** @type {Vec[]} */
  const vertices = new Array(pointCount);
  /** @param {number} index */
  const vertex = (index) => {
    const value = vertices[index];
    if (!value) throw new PrcFormatError('Compressed tessellation references an undecoded point.');
    return value;
  };
  let pointCursor = 0;
  let vertexCursor = 0;
  let referenceCursor = 0;
  let isReferenceCursor = 3;
  /** @param {Vec} point */
  const pushVertex = (point) => {
    if (vertexCursor >= pointCount) throw new PrcFormatError('Compressed tessellation has too many points.');
    vertices[vertexCursor++] = point;
  };
  const nextReference = () => {
    const value = data.references[referenceCursor++];
    if (value === undefined || value < 0 || value >= pointCount) throw new PrcFormatError('Invalid point reference.');
    return value;
  };

  /** @param {Vec[]} points @param {number[]} index @returns {Triangle} */
  const makeTriangle = (points, index) => ({
    points,
    index,
    normals: [-1, -1, -1],
    reversed: false,
    left: { a: 0, b: 0, far: 0, open: false },
    right: { a: 0, b: 0, far: 0, open: false }
  });

  /** A chain start: three points relative to the origin, the first point and their midpoint. */
  const firstTriangle = () => {
    const v0 = add(scaled(pointCursor), origin);
    const v1 = add(scaled(pointCursor + 1), v0);
    const v2 = add(scaled(pointCursor + 2), avg(v0, v1));
    const triangle = makeTriangle([v0, v1, v2], [pointCursor, pointCursor + 1, pointCursor + 2]);
    pointCursor += 3;
    pushVertex(v0);
    pushVertex(v1);
    pushVertex(v2);
    return triangle;
  };

  /** A new chain that may reuse already decoded points. */
  const chainStart = () => {
    const flags = data.isReference.slice(isReferenceCursor, isReferenceCursor + 3);
    if (flags.length < 3) throw new PrcFormatError('Compressed tessellation reference flags ran out.');
    isReferenceCursor += 3;
    const references = flags[0] + flags[1] + flags[2];
    /** @type {Triangle} */
    let triangle;
    if (references === 0) triangle = firstTriangle();
    else if (references === 3) {
      const index = [nextReference(), nextReference(), nextReference()];
      triangle = makeTriangle(index.map(vertex), index);
    } else if (references === 1) {
      const encoded1 = scaled(pointCursor);
      const encoded2 = scaled(pointCursor + 1);
      const reference = nextReference();
      const point = vertex(reference);
      if (flags[0]) {
        const v1 = add(encoded1, point);
        const v2 = add(encoded2, avg(point, v1));
        triangle = makeTriangle([point, v1, v2], [reference, pointCursor, pointCursor + 1]);
        pushVertex(v1);
        pushVertex(v2);
      } else if (flags[1]) {
        const v0 = add(encoded1, origin);
        const v2 = add(encoded2, avg(point, v0));
        triangle = makeTriangle([v0, point, v2], [pointCursor, reference, pointCursor + 1]);
        pushVertex(v0);
        pushVertex(v2);
      } else {
        const v0 = add(encoded1, origin);
        const v1 = add(encoded2, v0);
        triangle = makeTriangle([v0, v1, point], [pointCursor, pointCursor + 1, reference]);
        pushVertex(v0);
        pushVertex(v1);
      }
      pointCursor += 2;
    } else {
      const encoded = scaled(pointCursor);
      const first = nextReference();
      const second = nextReference();
      /** @type {Vec} */
      let point;
      if (!flags[0]) {
        point = add(encoded, origin);
        triangle = makeTriangle([point, vertex(first), vertex(second)], [pointCursor, first, second]);
      } else if (!flags[1]) {
        point = add(vertex(first), encoded);
        triangle = makeTriangle([vertex(first), point, vertex(second)], [first, pointCursor, second]);
      } else {
        point = add(encoded, avg(vertex(first), vertex(second)));
        triangle = makeTriangle([vertex(first), vertex(second), point], [first, second, pointCursor]);
      }
      pointCursor += 1;
      pushVertex(point);
    }
    if (triangle.index[0] > triangle.index[1]) {
      triangle.index = [triangle.index[1], triangle.index[0], triangle.index[2]];
      triangle.points = [triangle.points[1], triangle.points[0], triangle.points[2]];
    }
    return triangle;
  };

  // Normal decoding state. Only the orientation it implies matters for the
  // geometry, but the decoded normals are kept for smooth shading.
  /** @type {Vec[]} */
  const normals = [];
  const angles = data.normalAngles.map((value) => (value * HALF_PI) / (2 ** data.normalAngleBits - 1));
  let angleCursor = 0;
  let binaryCursor = 0;
  const binary = data.normalBinary;
  const readBinary = () => {
    if (binaryCursor >= binary.length) throw new PrcFormatError('Normal data ran out.');
    return binary[binaryCursor++];
  };
  /** @type {Map<number, { multiple: boolean; single: number; stored: number[] }>} */
  const vertexNormals = new Map();
  /** @type {Map<number, number>} */
  const faceNormals = new Map();

  /** @param {Triangle} triangle @param {number} triReversed @param {number} xReversed @param {number} yReversed */
  const decodeNormal = (triangle, triReversed, xReversed, yReversed) => {
    if (angleCursor + 1 >= angles.length) throw new PrcFormatError('Normal angles ran out.');
    const theta = angles[angleCursor];
    const phi = angles[angleCursor + 1];
    angleCursor += 2;
    normals.push(vertexNormal(triangle.points, theta, phi, triReversed, xReversed, yReversed));
    return normals.length - 1;
  };

  /** Reads which of a multi-normal vertex's stored normals is reused. @param {number[]} stored */
  const readStoredNormal = (stored) => {
    const bits = bitsForUnsigned(stored.length - 1);
    let read = 0;
    for (let index = 0; index < bits; index += 1) read |= readBinary() << index;
    return stored[read >= stored.length ? 0 : stored.length - 1 - read];
  };

  /** Whether the triangle's winding disagrees with the normal. @param {Triangle} triangle @param {Vec} normal */
  const windingDisagrees = (triangle, normal) => {
    const [p0, p1, p2] = triangle.points;
    return dot(cross(sub(p2, avg(p0, p1)), sub(p1, p0)), normal) < 0;
  };

  /** @param {Triangle} triangle @param {number} triangleIndex */
  const resolveNormals = (triangle, triangleIndex) => {
    if (data.mustRecalculateNormals) {
      triangle.reversed = data.normalIsReversed[triangleIndex] === 1;
      return;
    }
    const face = data.triangleFaces[triangleIndex];
    if (data.isFacePlanar[face]) {
      let normalIndex = faceNormals.get(face);
      if (normalIndex === undefined) {
        const first = triangle.index[0];
        const known = vertexNormals.get(first);
        if (known && !known.multiple) normalIndex = known.single;
        else if (!known) {
          const multiple = readBinary() === 1;
          const triReversed = readBinary();
          const xReversed = readBinary();
          const yReversed = readBinary();
          normalIndex = decodeNormal(triangle, triReversed, xReversed, yReversed);
          vertexNormals.set(first, { multiple, single: normalIndex, stored: [normalIndex] });
        } else if (readBinary()) normalIndex = readStoredNormal(known.stored);
        else {
          const triReversed = readBinary();
          const xReversed = readBinary();
          const yReversed = readBinary();
          normalIndex = decodeNormal(triangle, triReversed, xReversed, yReversed);
          known.stored.push(normalIndex);
        }
        faceNormals.set(face, normalIndex);
      }
      triangle.normals = [normalIndex, normalIndex, normalIndex];
      triangle.reversed = windingDisagrees(triangle, normals[normalIndex]);
      return;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const index = triangle.index[corner];
      const known = vertexNormals.get(index);
      if (!known) {
        const multiple = readBinary() === 1;
        const triReversed = readBinary();
        const xReversed = readBinary();
        const yReversed = readBinary();
        const normalIndex = decodeNormal(triangle, triReversed, xReversed, yReversed);
        vertexNormals.set(index, { multiple, single: normalIndex, stored: [normalIndex] });
        triangle.normals[corner] = normalIndex;
      } else if (!known.multiple) triangle.normals[corner] = known.single;
      else if (readBinary()) triangle.normals[corner] = readStoredNormal(known.stored);
      else {
        const triReversed = readBinary();
        const xReversed = readBinary();
        const yReversed = readBinary();
        const normalIndex = decodeNormal(triangle, triReversed, xReversed, yReversed);
        known.stored.push(normalIndex);
        triangle.normals[corner] = normalIndex;
      }
    }
    triangle.reversed = windingDisagrees(triangle, normals[triangle.normals[0]]);
  };

  /** @param {Triangle} triangle @param {number} triangleIndex */
  const setGates = (triangle, triangleIndex) => {
    const [i0, i1, i2] = triangle.index;
    let left = { a: i0, b: i2, far: i1, open: false };
    let right = { a: i1, b: i2, far: i0, open: false };
    if (triangle.reversed) [left, right] = [right, left];
    for (const gate of [left, right]) if (gate.a > gate.b) [gate.a, gate.b] = [gate.b, gate.a];
    const status = data.edgeStatus[triangleIndex] ?? 0;
    right.open = (status & 1) !== 0;
    left.open = (status & 2) !== 0;
    triangle.left = left;
    triangle.right = right;
    return Number(right.open) + Number(left.open);
  };

  /** Frame on an open edge, oriented away from the triangle it came from. @param {{ a: number; b: number; far: number }} edge @returns {Gate} */
  const gateBasis = (edge) => {
    const v0 = vertex(edge.a);
    const v1 = vertex(edge.b);
    const v3 = vertex(edge.far);
    const center = avg(v0, v1);
    const x = mustNormalize(sub(v0, v1), 'edge');
    let z = normalize(cross(sub(v3, center), x));
    let y = z ? normalize(cross(z, x)) : null;
    if (!z || !y) {
      const basis = orthonormalBasis(x);
      if (!basis) throw new PrcFormatError('Degenerate edge frame in compressed tessellation.');
      z = basis.z;
      y = normalize(cross(z, x)) ?? basis.y;
    }
    if (dot(y, sub(center, v3)) > 0) {
      z = negate(z);
      y = negate(y);
    }
    return { x, y, z, origin: center, v0, v1, index0: edge.a, index1: edge.b };
  };

  /** @type {number[]} */
  const cornerIndices = [];
  /** @type {number[]} */
  const cornerNormals = [];
  /** @type {number[]} */
  const styles = [];
  /** @type {Map<number, number>} */
  const faceStyles = new Map();
  let styleCursor = 0;
  /** @param {Triangle} triangle @param {number} triangleIndex */
  const emit = (triangle, triangleIndex) => {
    const order = triangle.reversed ? [0, 1, 2] : [0, 2, 1];
    for (const corner of order) {
      cornerIndices.push(triangle.index[corner]);
      cornerNormals.push(triangle.normals[corner]);
    }
    const face = data.triangleFaces[triangleIndex];
    const attributes = data.lineAttributes;
    let style = 0;
    if (data.multipleLineAttributeOnFace?.[face]) style = attributes[styleCursor++] ?? 0;
    else if (attributes.length === 1) style = attributes[0];
    else if (attributes.length > 1) {
      if (!faceStyles.has(face)) faceStyles.set(face, attributes[styleCursor++] ?? 0);
      style = faceStyles.get(face) ?? 0;
    }
    styles.push(style - 1);
  };

  /** @type {Set<string>} */
  const closedEdges = new Set();
  /** @param {number} a @param {number} b */
  const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  /** @type {Gate[]} */
  const stack = [];

  let triangle = firstTriangle();
  resolveNormals(triangle, 0);
  emit(triangle, 0);
  for (let index = 1; index < triangleCount; index += 1) {
    const openEdges = setGates(triangle, index - 1);
    if (openEdges < 2) {
      if (!triangle.left.open) closedEdges.add(edgeKey(triangle.left.a, triangle.left.b));
      if (!triangle.right.open) closedEdges.add(edgeKey(triangle.right.a, triangle.right.b));
    }
    // Right goes on the stack first so the left neighbour is decoded next.
    if (triangle.right.open) stack.push(gateBasis(triangle.right));
    if (triangle.left.open) stack.push(gateBasis(triangle.left));

    /** @type {Gate | undefined} */
    let gate = stack.pop();
    if (gate && openEdges === 0) {
      while (gate && closedEdges.has(edgeKey(gate.index0, gate.index1))) gate = stack.pop();
    }
    if (!gate) triangle = chainStart();
    else {
      const isReference = data.isReference[isReferenceCursor++];
      if (isReference === undefined) throw new PrcFormatError('Compressed tessellation reference flags ran out.');
      if (isReference === 1) {
        const reference = nextReference();
        triangle = makeTriangle([gate.v0, gate.v1, vertex(reference)], [gate.index0, gate.index1, reference]);
      } else {
        const local = scaled(pointCursor);
        const point = add(add(add(gate.origin, scale(gate.x, local[0])), scale(gate.y, local[1])), scale(gate.z, local[2]));
        triangle = makeTriangle([gate.v0, gate.v1, point], [gate.index0, gate.index1, vertexCursor]);
        pointCursor += 1;
        pushVertex(point);
      }
    }
    resolveNormals(triangle, index);
    emit(triangle, index);
  }

  const positions = new Float32Array(cornerIndices.length * 3);
  const hasNormals = !data.mustRecalculateNormals && cornerNormals.every((normal) => normal >= 0 && normals[normal]);
  const normalValues = hasNormals ? new Float32Array(cornerIndices.length * 3) : null;
  cornerIndices.forEach((pointIndex, corner) => {
    positions.set(vertex(pointIndex), corner * 3);
    if (normalValues) normalValues.set(normals[cornerNormals[corner]], corner * 3);
  });
  const anyStyle = styles.some((style) => style >= 0);
  return { positions, normals: normalValues, faceStyles: anyStyle ? new Int32Array(styles) : null, colors: null };
}
