// augment.js — light data augmentation for 28×28 digits: a random rotation,
// small scale change and ±2 px shift, applied as one affine warp with
// bilinear sampling. Every epoch then sees slightly different versions of
// each training digit, which reduces overfitting and makes the network more
// tolerant of the off-centre, tilted digits people draw in the demo.

/**
 * Inverse-mapped affine warp. For each destination pixel we ask "where did
 * this come from?" and bilinearly sample the source there; anything outside
 * the source is background (0). Inverse mapping never leaves holes, unlike
 * pushing source pixels forward.
 *
 * Forward transform about the image centre c:  p' = s·R(θ)·(p − c) + c + t
 * Inverse:                                       p  = R(−θ)·(p' − c − t)/s + c
 *
 * @param src  w×h source, any numeric array; values are multiplied by `gain`
 * @param dst  w×h Float32Array output
 */
export function warpAffine(src, dst, w, h, { angle = 0, scale = 1, tx = 0, ty = 0, gain = 1 } = {}) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const cos = Math.cos(-angle) / scale, sin = Math.sin(-angle) / scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx - tx, dy = y - cy - ty;
      const sx = cos * dx - sin * dy + cx;
      const sy = sin * dx + cos * dy + cy;
      dst[y * w + x] = gain * bilinear(src, w, h, sx, sy);
    }
  }
  return dst;
}

/** Bilinear sample of a w×h image at real coordinates (x, y); 0 outside. */
export function bilinear(img, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const at = (xx, yy) => (xx >= 0 && yy >= 0 && xx < w && yy < h ? img[yy * w + xx] : 0);
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bot * fy;
}

/** Draw random augmentation parameters. */
export function randomAffine(rng, { maxShift = 2, maxRotateDeg = 10, maxScale = 0.05 } = {}) {
  return {
    angle: rng.uniform(-maxRotateDeg, maxRotateDeg) * Math.PI / 180,
    scale: 1 + rng.uniform(-maxScale, maxScale),
    tx: rng.uniform(-maxShift, maxShift),
    ty: rng.uniform(-maxShift, maxShift),
  };
}

/**
 * Fill `out` (n×784 floats in [0,1]) with augmented copies of MNIST rows
 * idx[start .. start+n) from the uint8 image array.
 */
export function augmentBatch(images, idx, start, n, out, rng, opts) {
  const D = 784;
  for (let i = 0; i < n; i++) {
    const src = images.subarray(idx[start + i] * D, idx[start + i] * D + D);
    const t = randomAffine(rng, opts);
    t.gain = 1 / 255;
    warpAffine(src, out.subarray(i * D, i * D + D), 28, 28, t);
  }
  return out;
}
