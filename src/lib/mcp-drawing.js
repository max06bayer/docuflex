const POINTS_HELP = 'points must be an array of at least two objects, for example [{"x":100,"y":300},{"x":200,"y":300}]. Do not send a string or a flat array of numbers.';
/** Validate completely before the editor creates an undoable stroke.
 * @param {Record<string, any>} args @param {(coordinate: number) => number} [toPixels]
 * @returns {{points: {x: number; y: number; pressure: number}[]; thickness?: number; opacity?: number}}
 */
export function mcpDrawing(args, toPixels = (coordinate) => coordinate) {
  if (!Array.isArray(args.points) || args.points.length < 2) throw new Error(POINTS_HELP);
  if (args.points.length > 10_000) throw new Error('A drawing can contain at most 10,000 input points. Split it into shorter strokes.');
  const points = args.points.map((/** @type {any} */ point, /** @type {number} */ index) => {
    if (!point || typeof point !== 'object' || Array.isArray(point) || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(`Invalid point ${index + 1}. ${POINTS_HELP}`);
    const x = toPixels(point.x), y = toPixels(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Point ${index + 1} is outside the supported coordinate range.`);
    return { x, y, pressure: 0.5 };
  });
  if (args.tool !== undefined && !['pen', 'marker'].includes(args.tool)) throw new Error('tool must be pen or marker.');
  if (args.thickness !== undefined && (typeof args.thickness !== 'number' || !Number.isFinite(args.thickness) || args.thickness < 0.25 || args.thickness > 40)) throw new Error('thickness must be a finite number between 0.25 and 40 points.');
  if (args.opacity !== undefined && (typeof args.opacity !== 'number' || !Number.isFinite(args.opacity) || args.opacity < 0.01 || args.opacity > 1)) throw new Error('opacity must be a finite number between 0.01 and 1.');
  const dense = [points[0]];
  for (const point of points.slice(1)) {
    const last = dense[dense.length - 1];
    const distance = Math.hypot(point.x - last.x, point.y - last.y);
    if (distance < 0.35) continue;
    const steps = Math.max(1, Math.ceil(distance / 2));
    if (!Number.isFinite(steps) || dense.length + steps > 50_000) throw new Error('This stroke is too long or detailed. Use smaller coordinates or split it into shorter strokes.');
    for (let step = 1; step <= steps; step++) {
      const amount = step / steps;
      const x = last.x * (1 - amount) + point.x * amount;
      const y = last.y * (1 - amount) + point.y * amount;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('The drawing contains an invalid coordinate.');
      dense.push({ x, y, pressure: 0.5 });
    }
  }
  if (dense.length < 2) throw new Error('A drawing needs at least two distinct points.');
  return { points: dense, thickness: args.thickness === undefined ? undefined : toPixels(args.thickness), opacity: args.opacity };
}
