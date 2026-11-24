// prng.js — reproducible randomness. Math.random() cannot be seeded, and a
// training run that cannot be reproduced cannot be debugged, so everything
// random in this project (weight init, shuffling, dropout masks, augmentation)
// draws from one of these generators.

/**
 * mulberry32: a tiny 32-bit generator with a full 2^32 period and good
 * statistical quality for simulation work. Returns floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1) {
    this.next = mulberry32(seed);
    this.spare = null; // Box–Muller produces normals in pairs; keep the second one
  }

  /** Uniform float in [lo, hi). */
  uniform(lo = 0, hi = 1) {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /**
   * Standard normal via the Box–Muller transform: for independent
   * u1, u2 ~ U(0,1],  r = sqrt(-2 ln u1),  θ = 2π u2  gives two independent
   * N(0,1) samples r·cos θ and r·sin θ.
   */
  gaussian() {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    const u1 = 1 - this.next(); // (0, 1] so log() is finite
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

/**
 * He (Kaiming) normal init: w ~ N(0, 2 / fanIn). With ReLU, half the units
 * are off, so doubling the variance keeps activation variance roughly
 * constant from layer to layer and stops signals vanishing in deep stacks.
 */
export function heNormal(rng, out, fanIn) {
  const std = Math.sqrt(2 / fanIn);
  for (let i = 0; i < out.length; i++) out[i] = rng.gaussian() * std;
  return out;
}

/**
 * Xavier/Glorot uniform init: w ~ U(-a, a), a = sqrt(6 / (fanIn + fanOut)).
 * Preserves variance for symmetric activations (tanh, linear, softmax head).
 */
export function xavierUniform(rng, out, fanIn, fanOut) {
  const a = Math.sqrt(6 / (fanIn + fanOut));
  for (let i = 0; i < out.length; i++) out[i] = rng.uniform(-a, a);
  return out;
}
