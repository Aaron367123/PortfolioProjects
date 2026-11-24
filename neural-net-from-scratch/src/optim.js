// optim.js — parameter update rules. Each optimiser is handed the list of
// {value, grad, decay} parameter records from network.params() and updates
// `value` in place from `grad`. Per-parameter state (velocity, moments) is
// kept in a Map keyed by the parameter's value array.

/**
 * SGD with (heavy-ball) momentum and L2 weight decay:
 *   g ← ∇L + λw          (L2 penalty ½λ‖w‖² contributes λw to the gradient)
 *   v ← μv + g
 *   w ← w − η·v
 * Momentum averages gradients over recent steps, damping oscillation across
 * steep directions and accelerating along shallow, consistent ones.
 */
export class SGD {
  constructor({ lr = 0.01, momentum = 0.9, weightDecay = 0, nesterov = false } = {}) {
    Object.assign(this, { lr, momentum, weightDecay, nesterov });
    this.state = new Map();
  }

  step(params, lr = this.lr) {
    const { momentum: mu, weightDecay: wd, nesterov } = this;
    for (const p of params) {
      let v = this.state.get(p.value);
      if (!v) { v = new Float64Array(p.value.length); this.state.set(p.value, v); }
      const w = p.value, g = p.grad;
      const lam = p.decay ? wd : 0;
      for (let i = 0; i < w.length; i++) {
        const gi = g[i] + lam * w[i];
        v[i] = mu * v[i] + gi;
        w[i] -= lr * (nesterov ? gi + mu * v[i] : v[i]);
      }
    }
  }
}

/**
 * Adam (Kingma & Ba, 2015) with bias correction, plus weight decay.
 *
 *   m ← β₁m + (1−β₁)g              running mean of gradients      (1st moment)
 *   v ← β₂v + (1−β₂)g²             running mean of squared grads  (2nd moment)
 *   m̂ = m / (1−β₁ᵗ),  v̂ = v / (1−β₂ᵗ)   bias correction: m and v start at 0,
 *                                      so early averages are biased toward 0
 *   w ← w − η · m̂ / (√v̂ + ε)
 *
 * Dividing by √v̂ gives every weight its own step size: parameters with
 * large, noisy gradients take small steps, rarely-updated ones take larger.
 *
 * Weight decay: with `decoupled: true` (AdamW, the default) the decay is
 * applied directly to the weights, w ← w − η·λ·w, instead of being folded into
 * g where Adam's per-weight scaling would weaken it for large-gradient weights.
 * `decoupled: false` gives classic L2 (λw added to the gradient).
 */
export class Adam {
  constructor({ lr = 1e-3, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weightDecay = 0, decoupled = true } = {}) {
    Object.assign(this, { lr, beta1, beta2, eps, weightDecay, decoupled });
    this.t = 0;
    this.state = new Map();
  }

  step(params, lr = this.lr) {
    this.t += 1;
    const { beta1: b1, beta2: b2, eps, weightDecay: wd, decoupled } = this;
    const bc1 = 1 - b1 ** this.t;
    const bc2 = 1 - b2 ** this.t;
    for (const p of params) {
      let s = this.state.get(p.value);
      if (!s) {
        s = { m: new Float64Array(p.value.length), v: new Float64Array(p.value.length) };
        this.state.set(p.value, s);
      }
      const { m, v } = s;
      const w = p.value, g = p.grad;
      const lam = p.decay ? wd : 0;
      for (let i = 0; i < w.length; i++) {
        const gi = decoupled ? g[i] : g[i] + lam * w[i];
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        const mHat = m[i] / bc1;
        const vHat = v[i] / bc2;
        w[i] -= lr * (mHat / (Math.sqrt(vHat) + eps) + (decoupled ? lam * w[i] : 0));
      }
    }
  }
}

/**
 * Learning-rate schedules, as pure functions of progress.
 * cosine: η(t) = η_min + ½(η₀ − η_min)(1 + cos(π t/T)), with optional linear warm-up.
 */
export function cosineLR(base, step, totalSteps, { min = 0, warmup = 0 } = {}) {
  if (step < warmup) return base * (step + 1) / warmup;
  const t = Math.min(1, (step - warmup) / Math.max(1, totalSteps - warmup));
  return min + 0.5 * (base - min) * (1 + Math.cos(Math.PI * t));
}

/** step: multiply by gamma every `every` epochs. */
export function stepLR(base, epoch, { every = 5, gamma = 0.5 } = {}) {
  return base * gamma ** Math.floor(epoch / every);
}
