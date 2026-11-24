import { test } from 'node:test';
import assert from 'node:assert/strict';
import { softmax, SoftmaxCrossEntropy } from '../src/layers.js';

test('softmax is stable for huge logits (log-sum-exp shift)', () => {
  const z = Float64Array.of(1000, 0, -1000, 1e4, 1e4, 1e4, -1e4, -1e4 - 1, -1e4 - 2);
  const p = softmax(z, new Float64Array(9), 3, 3);
  assert.ok(p.every(Number.isFinite));
  for (let i = 0; i < 3; i++) {
    const s = p[3 * i] + p[3 * i + 1] + p[3 * i + 2];
    assert.ok(Math.abs(s - 1) < 1e-12);
  }
  assert.equal(p[0], 1);                         // e^0 / (e^0 + e^-1000 + e^-2000)
  assert.ok(Math.abs(p[3] - 1 / 3) < 1e-12);     // equal huge logits → uniform
  assert.ok(p[6] > p[7] && p[7] > p[8]);         // order preserved deep in the negative range
  // naive exp would overflow to Infinity/Infinity = NaN
  assert.ok(Number.isNaN(Math.exp(1000) / (Math.exp(1000) + 1)));
});

test('cross-entropy stays finite even when the true class has p ≈ 0', () => {
  const ce = new SoftmaxCrossEntropy({ dtype: Float64Array });
  const z = Float64Array.of(1000, 0, -1000);
  const loss = ce.forward(z, Uint8Array.of(2), 1, 3);
  // −log p₂ = log Σ e^{z−max} − (z₂ − max) = log(1 + e^-1000 + e^-2000) + 2000 = 2000
  assert.ok(Math.abs(loss - 2000) < 1e-9);
  const d = ce.backward();
  assert.ok(Math.abs(d[0] - 1) < 1e-12 && Math.abs(d[2] + 1) < 1e-12);
});

test('softmax-CE gradient is (p − onehot)/n and sums to zero per row', () => {
  const ce = new SoftmaxCrossEntropy({ dtype: Float64Array });
  const z = Float64Array.of(1, 2, 3, 0.5, -0.5, 0);
  const loss = ce.forward(z, Uint8Array.of(2, 0), 2, 3);
  assert.ok(loss > 0);
  const d = ce.backward();
  const p = ce.probs;
  assert.ok(Math.abs(d[2] - (p[2] - 1) / 2) < 1e-15);
  assert.ok(Math.abs(d[1] - p[1] / 2) < 1e-15);
  assert.ok(Math.abs(d[0] + d[1] + d[2]) < 1e-15);
  assert.ok(Math.abs(d[3] + d[4] + d[5]) < 1e-15);
});
