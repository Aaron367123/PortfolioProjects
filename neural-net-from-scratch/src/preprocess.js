// preprocess.js — turn a freehand drawing into an MNIST-style 28×28 input.
//
// A network only works on inputs that look like its training data, and MNIST
// digits were prepared in a very particular way (LeCun et al.): each digit
// was size-normalised to fit a 20×20 box preserving its aspect ratio
// (anti-aliased, so edges are grey), then placed in a 28×28 frame so that its
// centre of mass sits at the centre. A raw canvas drawing is nothing like
// that — different size, position, thickness — so this module repeats the
// same recipe on the user's ink:
//
//   1. bounding box      find the ink
//   2. stroke width      dilate/erode so strokes are as thick, relative to
//                        the digit, as MNIST strokes (≈ 2 px at 20 px tall)
//   3. area resample     scale the longest side to 20 px; each output pixel
//                        is the average of the source area it covers
//   4. centre of mass    shift (sub-pixel, bilinear) so the COM is at (14, 14)
//   5. normalise         peak ink = 1.0, values in [0, 1]
//
// Pure functions on Float32Arrays: the browser demo calls preprocessInk() on
// canvas pixels and the Node tests call it on synthetic strokes.

import { bilinear } from './augment.js';

export const FRAME = 28;
export const BOX = 20;
// Measured on the MNIST training set (scripts in the README):
export const MNIST_COM = 14.0;            // mean centre of mass, pixel-index coordinates
export const MNIST_STROKE_WIDTH = 2.04;   // mean of 2·area/perimeter at the 28×28 scale

/** Ink map (0..1) from RGBA canvas pixels: the alpha channel of the strokes. */
export function inkFromRGBA(rgba, width, height) {
  const ink = new Float32Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = rgba[4 * i + 3] / 255;
  return ink;
}

/** Tight bounding box of pixels above `threshold`, or null if there are none. */
export function boundingBox(img, w, h, threshold = 0.05) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (img[y * w + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Copy a rectangle (may extend past the image: padded with 0). */
export function crop(img, w, h, rx, ry, rw, rh) {
  const out = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const sy = ry + y;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < rw; x++) {
      const sx = rx + x;
      if (sx >= 0 && sx < w) out[y * rw + x] = img[sy * w + sx];
    }
  }
  return out;
}

/** Intensity-weighted centre of mass in pixel-index coordinates. */
export function centerOfMass(img, w, h) {
  let m = 0, mx = 0, my = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      m += v; mx += v * x; my += v * y;
    }
  }
  return m > 0 ? { x: mx / m, y: my / m, mass: m } : { x: (w - 1) / 2, y: (h - 1) / 2, mass: 0 };
}

/**
 * Stroke width estimate: for a stroke of width t and length L, the inked
 * area is ≈ t·L and the outline length is ≈ 2L, so t ≈ 2·area / perimeter.
 * Works on any digit shape without having to find a skeleton.
 */
export function strokeWidth(img, w, h, threshold = 0.5) {
  let area = 0, perim = 0;
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && img[y * w + x] >= threshold;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = on(x, y);
      if (a) area++;
      if (a !== on(x + 1, y)) perim++;
      if (a !== on(x, y + 1)) perim++;
      if (x === 0 && a) perim++;
      if (y === 0 && a) perim++;
    }
  }
  return perim ? (2 * area) / perim : 0;
}

/**
 * Grey-scale dilation (max filter, r > 0) or erosion (min filter, r < 0)
 * with a (2|r|+1)² square, done as two separable 1-D passes.
 */
export function morph(img, w, h, r) {
  if (r === 0) return img;
  const rad = Math.abs(r);
  const pick = r > 0 ? Math.max : Math.min;
  const edge = 0; // outside the image counts as background (input is padded)
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = img[y * w + x];
      for (let d = -rad; d <= rad; d++) {
        const xx = x + d;
        v = pick(v, xx >= 0 && xx < w ? img[y * w + xx] : edge);
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      for (let d = -rad; d <= rad; d++) {
        const yy = y + d;
        v = pick(v, yy >= 0 && yy < h ? tmp[yy * w + x] : edge);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Area-averaging resize of a sw×sh image to tw×th. Output pixel (x, y) is the
 * mean of the source rectangle it covers, with partial coverage of edge
 * pixels weighted by overlap — this is what an optical downscale does and it
 * produces MNIST's soft grey edges. Separable: rows first, then columns.
 * When enlarging (target bigger than source) it falls back to bilinear.
 */
export function resizeArea(src, sw, sh, tw, th) {
  if (tw > sw || th > sh) {
    const out = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        out[y * tw + x] = bilinear(src, sw, sh, (x + 0.5) * sw / tw - 0.5, (y + 0.5) * sh / th - 0.5);
      }
    }
    return out;
  }
  const horiz = new Float32Array(tw * sh);
  resample1D(src, horiz, sw, tw, sh, 1, sw, 1, tw);
  const out = new Float32Array(tw * th);
  resample1D(horiz, out, sh, th, tw, tw, 1, tw, 1);
  return out;
}

// One separable pass: `lines` independent lines of length n → m, where element
// e of line l is at l·lineStride + e·step in the source and l·outLineStride + e·outStep in the output.
function resample1D(src, dst, n, m, lines, step, lineStride, outStep, outLineStride) {
  const scale = n / m; // source pixels per output pixel (≥ 1)
  for (let l = 0; l < lines; l++) {
    const sBase = l * lineStride, dBase = l * outLineStride;
    for (let o = 0; o < m; o++) {
      const a = o * scale, b = a + scale;
      let sum = 0;
      for (let s = Math.floor(a); s < Math.ceil(b) && s < n; s++) {
        const overlap = Math.min(b, s + 1) - Math.max(a, s);
        if (overlap > 0) sum += overlap * src[sBase + s * step];
      }
      dst[dBase + o * outStep] = sum / scale;
    }
  }
}

/**
 * Full pipeline. `ink` is a width×height Float32Array, 0 = paper, 1 = ink.
 * @returns null for an empty drawing, else
 *   { input: Float32Array(784) in [0,1],
 *     stages: { bbox, crop:{data,w,h}, stroke:{before,target,radius}, box:{data,w,h}, com:{x,y}, offset:{x,y} } }
 */
export function preprocessInk(ink, width, height, { normalizeStroke = true, threshold = 0.05 } = {}) {
  let bb = boundingBox(ink, width, height, threshold);
  if (!bb) return null;

  // --- 2. stroke-width normalisation, at source resolution -----------------
  let longSide = Math.max(bb.w, bb.h);
  const before = strokeWidth(crop(ink, width, height, bb.x, bb.y, bb.w, bb.h), bb.w, bb.h);
  // MNIST strokes are ≈2 px when the digit is ≈20 px tall: scale to this drawing.
  const target = MNIST_STROKE_WIDTH * longSide / BOX;
  let radius = 0;
  if (normalizeStroke && before > 0) {
    radius = Math.round((target - before) / 2);       // each side of the stroke moves by r
    radius = Math.max(-Math.floor(before / 3), Math.min(radius, Math.ceil(longSide / 10)));
  }
  const pad = Math.max(radius, 0) + 1;
  let img = crop(ink, width, height, bb.x - pad, bb.y - pad, bb.w + 2 * pad, bb.h + 2 * pad);
  let cw = bb.w + 2 * pad, ch = bb.h + 2 * pad;
  if (radius !== 0) img = morph(img, cw, ch, radius);
  const bb2 = boundingBox(img, cw, ch, threshold);
  if (!bb2) return null;
  img = crop(img, cw, ch, bb2.x, bb2.y, bb2.w, bb2.h);
  cw = bb2.w; ch = bb2.h;
  const cropped = { data: img, w: cw, h: ch };

  // --- 3. scale the longest side to 20 px, preserving aspect ratio ---------
  longSide = Math.max(cw, ch);
  const tw = Math.max(1, Math.round((cw * BOX) / longSide));
  const th = Math.max(1, Math.round((ch * BOX) / longSide));
  const box = resizeArea(img, cw, ch, tw, th);

  // --- 5 (done early so the COM uses final intensities). peak ink = 1 ------
  let peak = 0;
  for (const v of box) if (v > peak) peak = v;
  if (peak > 0) for (let i = 0; i < box.length; i++) box[i] = Math.min(1, box[i] / peak);

  // --- 4. centre of mass → (14, 14) with a sub-pixel bilinear shift --------
  const com = centerOfMass(box, tw, th);
  const ox = MNIST_COM - com.x, oy = MNIST_COM - com.y; // where box(0,0) lands in the frame
  const input = new Float32Array(FRAME * FRAME);
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) input[y * FRAME + x] = bilinear(box, tw, th, x - ox, y - oy);
  }

  return {
    input,
    stages: {
      bbox: bb,
      crop: cropped,
      stroke: { before, target, radius },
      box: { data: box, w: tw, h: th },
      com: { x: com.x, y: com.y },
      offset: { x: ox, y: oy },
    },
  };
}
