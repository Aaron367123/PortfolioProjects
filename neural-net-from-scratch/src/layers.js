// layers.js — the building blocks of the network, each with an explicit
// forward pass and a hand-derived backward pass.
//
// Conventions
//   * A batch of n examples is an n×d row-major matrix (one example per row).
//   * forward(x, n, training) returns the layer's output and caches whatever
//     the backward pass needs.
//   * backward(dy) receives dL/dy (same shape as the output) and returns
//     dL/dx (same shape as the input). Parameter gradients are written into
//     each parameter's `grad` array (overwritten, not accumulated).
//   * `dtype` is Float32Array for training/inference and Float64Array for the
//     finite-difference gradient checks in the tests.

import {
  matmul, matmulTransA, matmulTransB, addRowVector, sumRows, Scratch,
} from './tensor.js';
import { heNormal, xavierUniform, Rng } from './prng.js';

/**
 * Fully connected layer:  y = x·W + b,   W is [in × out], b is [out].
 *
 * Optional `inputNorm: {mean, std}` makes the layer behave as if its input
 * had been standardised, x̂ = (x − μ)/σ, while actually consuming the raw
 * input x. That matters because raw MNIST pixels are 81 % exact zeros (which
 * the matmul skips) but standardised pixels have no zeros at all. Expanding:
 *
 *   y  = x̂·W + b = (1/σ)·x·W + (b − (μ/σ)·1ᵀW)          (1ᵀW = column sums of W)
 *   dL/dW = x̂ᵀ·dy = (1/σ)·xᵀ·dy − (μ/σ)·1·(1ᵀdy)           (outer product with db)
 *   dL/dx = (1/σ)·dy·Wᵀ
 *
 * so the result is mathematically identical to a separate Normalize layer,
 * about 2× faster on the first layer, and checked by the gradient tests.
 */
export class Dense {
  constructor(inSize, outSize, {
    rng = new Rng(1), init = 'he', dtype = Float32Array, inputNorm = null, needInputGrad = true,
  } = {}) {
    this.type = 'dense';
    this.inSize = inSize;
    this.outSize = outSize;
    this.dtype = dtype;
    this.inputNorm = inputNorm;
    // The first layer never needs dL/dx (nothing upstream learns), so the
    // network switches this off and saves one of the three matmuls.
    this.needInputGrad = needInputGrad;
    this.W = new dtype(inSize * outSize);
    this.b = new dtype(outSize);
    this.gW = new dtype(inSize * outSize);
    this.gb = new dtype(outSize);
    if (init === 'he') heNormal(rng, this.W, inSize);
    else if (init === 'xavier') xavierUniform(rng, this.W, inSize, outSize);
    else if (init !== 'zeros') throw new Error(`unknown init ${init}`);
    this.yBuf = new Scratch(dtype);
    this.dxBuf = new Scratch(dtype);
    // Effective bias b − (μ/σ)·1ᵀW for inputNorm, cached because summing the
    // 784×256 matrix costs more than the sparse matmul itself at batch size 1.
    this.normBias = new dtype(outSize);
    this.normBiasValid = false;
  }

  /** Call after changing W or b directly (optimisers do it via Sequential). */
  invalidate() { this.normBiasValid = false; }

  params() {
    return [
      { name: 'W', value: this.W, grad: this.gW, decay: true },
      { name: 'b', value: this.b, grad: this.gb, decay: false }, // biases are not weight-decayed
    ];
  }

  forward(x, n) {
    this.x = x;
    this.n = n;
    const { inSize: I, outSize: O } = this;
    const y = this.yBuf.get(n * O);
    matmul(x, this.W, y, n, I, O);
    if (!this.inputNorm) return addRowVector(y, this.b, n, O);

    const inv = 1 / this.inputNorm.std;
    const nb = this.normBias;
    if (!this.normBiasValid) {
      sumRows(this.W, nb, I, O); // 1ᵀW
      for (let j = 0; j < O; j++) nb[j] = this.b[j] - this.inputNorm.mean * inv * nb[j];
      this.normBiasValid = true;
    }
    for (let i = 0; i < n; i++) {
      const r = i * O;
      for (let j = 0; j < O; j++) y[r + j] = y[r + j] * inv + nb[j];
    }
    return y;
  }

  backward(dy) {
    const { inSize: I, outSize: O, n } = this;
    // dL/db_j = Σ_batch dL/dy_ij       (b is added to every row)
    sumRows(dy, this.gb, n, O);
    // dL/dW = xᵀ·dy                    (each weight W_kj sees x_ik for every row i)
    matmulTransA(this.x, dy, this.gW, I, n, O);
    if (this.inputNorm) {
      const inv = 1 / this.inputNorm.std;
      const mu = this.inputNorm.mean;
      for (let k = 0; k < I; k++) {
        const r = k * O;
        for (let j = 0; j < O; j++) this.gW[r + j] = this.gW[r + j] * inv - mu * inv * this.gb[j];
      }
    }
    if (!this.needInputGrad) return null;
    // dL/dx = dy·Wᵀ                    (each input fans out to all `out` units)
    const dx = this.dxBuf.get(n * I);
    matmulTransB(dy, this.W, dx, n, O, I);
    if (this.inputNorm) {
      const inv = 1 / this.inputNorm.std;
      for (let i = 0; i < dx.length; i++) dx[i] *= inv;
    }
    return dx;
  }

  config() {
    return { type: 'dense', in: this.inSize, out: this.outSize, ...(this.inputNorm ? { inputNorm: this.inputNorm } : {}) };
  }
}

/**
 * ReLU: y = max(0, x).  Derivative is 1 where x > 0 and 0 elsewhere, so the
 * backward pass just gates the incoming gradient: dx = dy ⊙ [y > 0].
 */
export class ReLU {
  constructor({ dtype = Float32Array } = {}) {
    this.type = 'relu';
    this.yBuf = new Scratch(dtype);
    this.dxBuf = new Scratch(dtype);
  }
  params() { return []; }
  forward(x) {
    const y = this.yBuf.get(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] > 0 ? x[i] : 0;
    this.y = y;
    return y;
  }
  backward(dy) {
    const dx = this.dxBuf.get(dy.length);
    const y = this.y;
    for (let i = 0; i < dy.length; i++) dx[i] = y[i] > 0 ? dy[i] : 0;
    return dx;
  }
  config() { return { type: 'relu' }; }
}

/** Leaky ReLU: y = x for x > 0, αx otherwise; dy/dx is 1 or α. */
export class LeakyReLU {
  constructor({ alpha = 0.01, dtype = Float32Array } = {}) {
    this.type = 'leaky_relu';
    this.alpha = alpha;
    this.yBuf = new Scratch(dtype);
    this.dxBuf = new Scratch(dtype);
  }
  params() { return []; }
  forward(x) {
    const y = this.yBuf.get(x.length);
    const a = this.alpha;
    for (let i = 0; i < x.length; i++) y[i] = x[i] > 0 ? x[i] : a * x[i];
    this.x = x;
    return y;
  }
  backward(dy) {
    const dx = this.dxBuf.get(dy.length);
    const a = this.alpha;
    for (let i = 0; i < dy.length; i++) dx[i] = this.x[i] > 0 ? dy[i] : a * dy[i];
    return dx;
  }
  config() { return { type: 'leaky_relu', alpha: this.alpha }; }
}

/**
 * Inverted dropout. While training, each unit is zeroed with probability p
 * and survivors are scaled by 1/(1−p) so the expected activation is
 * unchanged; at inference the layer is the identity and costs nothing.
 * Backward multiplies by the same mask (the mask is a constant per step).
 */
export class Dropout {
  constructor(p = 0.2, { rng = new Rng(7), dtype = Float32Array } = {}) {
    this.type = 'dropout';
    this.p = p;
    this.rng = rng;
    this.mask = new Scratch(dtype);
    this.yBuf = new Scratch(dtype);
    this.dxBuf = new Scratch(dtype);
  }
  params() { return []; }
  forward(x, n, training = false) {
    this.active = training && this.p > 0;
    if (!this.active) return x;
    const keep = 1 - this.p;
    const scale = 1 / keep;
    const m = this.mask.get(x.length);
    const y = this.yBuf.get(x.length);
    for (let i = 0; i < x.length; i++) {
      m[i] = this.rng.next() < keep ? scale : 0;
      y[i] = x[i] * m[i];
    }
    return y;
  }
  backward(dy) {
    if (!this.active) return dy;
    const m = this.mask.get(dy.length);
    const dx = this.dxBuf.get(dy.length);
    for (let i = 0; i < dy.length; i++) dx[i] = dy[i] * m[i];
    return dx;
  }
  config() { return { type: 'dropout', p: this.p }; }
}

/**
 * Row-wise softmax with the log-sum-exp trick: softmax(z) = softmax(z − max z),
 * because the constant cancels between numerator and denominator. Shifting by
 * the max makes every exponent ≤ 0, so exp() can never overflow even for
 * logits of ±1000. Returns probabilities in `out` (may alias nothing else).
 */
export function softmax(z, out, n, k) {
  for (let i = 0; i < n; i++) {
    const r = i * k;
    let max = -Infinity;
    for (let j = 0; j < k; j++) if (z[r + j] > max) max = z[r + j];
    let sum = 0;
    for (let j = 0; j < k; j++) {
      const e = Math.exp(z[r + j] - max);
      out[r + j] = e;
      sum += e;
    }
    const inv = 1 / sum;
    for (let j = 0; j < k; j++) out[r + j] *= inv;
  }
  return out;
}

/**
 * Softmax + cross-entropy, fused into one "loss layer".
 *
 * Forward, for one example with logits z and true class c:
 *   p_j = e^{z_j} / Σ_m e^{z_m}
 *   L   = −log p_c = −z_c + log Σ_m e^{z_m}        (computed as  −(z_c − max) + log Σ e^{z_m − max})
 *
 * Backward — differentiate L with respect to each logit:
 *   ∂L/∂z_j = −[j = c] + e^{z_j}/Σ_m e^{z_m} = p_j − y_j        (y = one-hot label)
 *
 * The fused gradient is simply "probabilities minus one-hot", which is both
 * cheaper and far more stable than chaining softmax's Jacobian with the
 * derivative of log. The batch loss is the mean, so the gradient is /n.
 */
export class SoftmaxCrossEntropy {
  constructor({ dtype = Float32Array } = {}) {
    this.type = 'softmax_ce';
    this.pBuf = new Scratch(dtype);
    this.dBuf = new Scratch(dtype);
  }

  /** @returns mean loss over the batch; probabilities are kept in this.probs */
  forward(z, labels, n, k) {
    this.n = n;
    this.k = k;
    this.labels = labels;
    const p = this.pBuf.get(n * k);
    let loss = 0;
    for (let i = 0; i < n; i++) {
      const r = i * k;
      let max = -Infinity;
      for (let j = 0; j < k; j++) if (z[r + j] > max) max = z[r + j];
      let sum = 0;
      for (let j = 0; j < k; j++) {
        const e = Math.exp(z[r + j] - max);
        p[r + j] = e;
        sum += e;
      }
      const inv = 1 / sum;
      for (let j = 0; j < k; j++) p[r + j] *= inv;
      // log-sum-exp form of −log p_c: never takes log(0) even if p_c underflows
      loss += Math.log(sum) - (z[r + labels[i]] - max);
    }
    this.probs = p;
    return loss / n;
  }

  /** dL/dz = (p − onehot(label)) / n */
  backward() {
    const { n, k, labels } = this;
    const d = this.dBuf.get(n * k);
    const p = this.probs;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const r = i * k;
      for (let j = 0; j < k; j++) d[r + j] = p[r + j] * inv;
      d[r + labels[i]] -= inv;
    }
    return d;
  }
}
