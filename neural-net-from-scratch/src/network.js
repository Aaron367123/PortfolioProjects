// network.js — a sequential container that chains layers, runs backprop and
// evaluates. Training a step is:
//
//   1. forward:   x → layer₁ → … → layerₙ → logits z → softmax-CE → loss L
//   2. backward:  dL/dz = p − y, then each layer, in reverse, turns dL/d(out)
//                 into dL/d(in) and fills its parameters' gradients
//                 (the chain rule, applied one layer at a time)
//   3. update:    the optimiser moves every parameter against its gradient
import { Dense, ReLU, LeakyReLU, Dropout, SoftmaxCrossEntropy, softmax } from './layers.js';
import { argmax } from './tensor.js';
import { Rng } from './prng.js';
import { confusionMatrix } from './metrics.js';

export class Sequential {
  constructor(layers, { inputSize, dtype = Float32Array } = {}) {
    this.layers = layers;
    this.dtype = dtype;
    this.inputSize = inputSize ?? layers.find((l) => l.inSize)?.inSize;
    const dense = layers.filter((l) => l.type === 'dense');
    this.outputSize = dense[dense.length - 1].outSize;
    this.loss = new SoftmaxCrossEntropy({ dtype });
    this.meta = {};
  }

  /** All trainable parameters, in layer order. */
  params() {
    return this.layers.flatMap((l) => l.params());
  }

  paramCount() {
    return this.params().reduce((s, p) => s + p.value.length, 0);
  }

  /** Forward pass for a batch of n rows; returns the logits (n × classes). */
  forward(x, n, training = false) {
    let h = x;
    for (const layer of this.layers) h = layer.forward(h, n, training);
    return h;
  }

  /** Backward pass from dL/dlogits through every layer (reverse order). */
  backward(dLogits) {
    let g = dLogits;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      g = this.layers[i].backward(g);
      if (g === null) break; // first Dense layer skips dL/dx: nothing upstream
    }
  }

  /** Mean loss and gradients for one batch (does not update weights). */
  computeGradients(x, labels, n, training = true) {
    const z = this.forward(x, n, training);
    const loss = this.loss.forward(z, labels, n, this.outputSize);
    this.backward(this.loss.backward());
    let correct = 0;
    for (let i = 0; i < n; i++) if (argmax(z, i * this.outputSize, this.outputSize) === labels[i]) correct++;
    return { loss, correct };
  }

  /** One optimisation step on a mini-batch. */
  trainBatch(x, labels, n, optimizer, lr) {
    const r = this.computeGradients(x, labels, n, true);
    optimizer.step(this.params(), lr);
    this.invalidate();
    return r;
  }

  /** Drop values cached from the weights; call after modifying parameters directly. */
  invalidate() {
    for (const l of this.layers) l.invalidate?.();
  }

  /** Class probabilities for n rows (n × classes, a fresh array). */
  predict(x, n = 1) {
    const z = this.forward(x, n, false);
    return softmax(z, new this.dtype(z.length), n, this.outputSize);
  }

  /**
   * Single-example forward pass that also returns every layer's output —
   * the demo uses this to light up neurons in the network visualisation.
   * @returns {{probs: Float32Array, activations: {type: string, values: ArrayLike<number>}[]}}
   */
  trace(x) {
    const activations = [];
    let h = x;
    for (const layer of this.layers) {
      h = layer.forward(h, 1, false);
      if (layer.type !== 'dropout') activations.push({ type: layer.type, values: h.slice() });
    }
    return { probs: softmax(h, new this.dtype(h.length), 1, this.outputSize), activations };
  }

  /**
   * Accuracy / mean loss / confusion matrix over a dataset.
   * @param images  uint8 or float rows (count × inputSize)
   * @param toInput converts a chunk of `images` to the float input the network expects
   */
  evaluate(images, labels, count, { batch = 1000, toInput = defaultToInput } = {}) {
    const preds = new Uint8Array(count);
    let lossSum = 0, correct = 0;
    const D = this.inputSize;
    const buf = new this.dtype(batch * D);
    for (let s = 0; s < count; s += batch) {
      const n = Math.min(batch, count - s);
      const x = toInput(images, s, n, D, buf);
      const z = this.forward(x, n, false);
      const lab = labels.subarray(s, s + n);
      lossSum += this.loss.forward(z, lab, n, this.outputSize) * n;
      for (let i = 0; i < n; i++) {
        preds[s + i] = argmax(z, i * this.outputSize, this.outputSize);
        if (preds[s + i] === lab[i]) correct++;
      }
    }
    return {
      loss: lossSum / count,
      accuracy: correct / count,
      preds,
      confusion: confusionMatrix(labels.subarray(0, count), preds, this.outputSize),
    };
  }

  config() {
    return this.layers.map((l) => l.config());
  }
}

/** uint8 pixels (0-255) → floats in [0, 1]. Standardisation happens inside the first Dense layer. */
export function defaultToInput(images, start, n, D, out) {
  const x = out.subarray(0, n * D);
  const off = start * D;
  for (let i = 0; i < n * D; i++) x[i] = images[off + i] / 255;
  return x;
}

/**
 * Build the MNIST MLP: [standardise] → Dense → ReLU → Dropout → … → Dense(10).
 * @param {object} o
 * @param {number[]} o.hidden      hidden layer widths, e.g. [256, 128]
 * @param {{mean:number,std:number}} [o.inputNorm] training-set pixel statistics
 */
export function buildMLP({
  input = 784, hidden = [256, 128], classes = 10, dropout = 0.2, activation = 'relu',
  inputNorm = null, seed = 1, dtype = Float32Array,
} = {}) {
  const rng = new Rng(seed);
  const layers = [];
  let prev = input;
  hidden.forEach((h, i) => {
    layers.push(new Dense(prev, h, {
      rng, init: 'he', dtype, inputNorm: i === 0 ? inputNorm : null, needInputGrad: i !== 0,
    }));
    layers.push(activation === 'leaky' ? new LeakyReLU({ dtype }) : new ReLU({ dtype }));
    if (dropout > 0) layers.push(new Dropout(dropout, { rng: new Rng(seed * 7919 + i), dtype }));
    prev = h;
  });
  // Output layer feeds softmax, so Xavier init (no ReLU after it).
  layers.push(new Dense(prev, classes, {
    rng, init: 'xavier', dtype, needInputGrad: hidden.length > 0, inputNorm: hidden.length ? null : inputNorm,
  }));
  return new Sequential(layers, { inputSize: input, dtype });
}
