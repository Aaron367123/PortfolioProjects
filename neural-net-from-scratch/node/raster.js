// node/raster.js — a tiny anti-aliased "pen" for synthetic drawings, used by
// the tests and the preprocessing figure to stand in for a canvas. Ink at a
// pixel is 1 inside the stroke and falls off linearly over one pixel at the
// edge, like a browser canvas's anti-aliased round-capped line.

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

/**
 * Draw polylines into a width×height ink map.
 * @param {number[][][]} strokes  list of strokes, each a list of [x, y] points
 * @param {number} lineWidth      pen diameter in pixels
 */
export function drawStrokes(width, height, strokes, lineWidth, ink = new Float32Array(width * height)) {
  const r = lineWidth / 2;
  for (const pts of strokes) {
    for (let s = 0; s < Math.max(1, pts.length - 1); s++) {
      const [ax, ay] = pts[s];
      const [bx, by] = pts[Math.min(s + 1, pts.length - 1)];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
          const v = Math.max(0, Math.min(1, r + 0.5 - d));
          if (v > ink[y * width + x]) ink[y * width + x] = v;
        }
      }
    }
  }
  return ink;
}

/** Points along a circular/elliptical arc, for drawing round digits. */
export function arc(cx, cy, rx, ry, a0, a1, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}
