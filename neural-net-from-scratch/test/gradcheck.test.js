// Numerical gradient checks: compare every analytic gradient from backprop
// with a central finite difference,
//
//     ∂L/∂θ ≈ (L(θ + ε) − L(θ − ε)) / 2ε,      error O(ε²),
//
// using the Float64 code path (ε = 1e-5) so rounding noise stays far below
// the tolerance. Relative error |a − n| / max(|a| + |n|, 1e-8) must be < 1e-4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dense, ReLU, LeakyReLU, Dropout, SoftmaxCrossEntropy } from '../src/layers.js';
import { Sequential } from '../src/network.js';
import { Rng } from '../src/prng.js';

const F64 = Float64Array;
const EPS = 1e-5;
const TOL = 1e-4;
const relErr = (a, n) => Math.abs(a - n) / Math.max(Math.abs(a) + Math.abs(n), 1e-8);

/** Print the worst relative error seen, e.g. "worst rel. error 3.1e-10 over 59 values". */
function report(t, r) {
  t.diagnostic(`worst relative error ${r.worst.toExponential(1)} over ${r.checked} values`);
  return r;
}

function batch(rng, n, d, k) {
  const x = F64.from({ length: n * d }, () => rng.uniform(-1, 1));
  const y = Uint8Array.from({ length: n }, () => rng.int(k));
  return { x, y };
}

/** Check all parameter gradients (and optionally dL/dx) of `net`. */
function gradCheck(net, x, y, n, { checkInput = false } = {}) {
  const k = net.outputSize;
  const ce = new SoftmaxCrossEntropy({ dtype: F64 });
  const lossAt = () => { net.invalidate(); return ce.forward(net.forward(x, n, false), y, n, k); };

  // analytic
  ce.forward(net.forward(x, n, false), y, n, k);
  let g = ce.backward();
  for (let i = net.layers.length - 1; i >= 0; i--) g = net.layers[i].backward(g);
  const analyticX = checkInput ? g.slice() : null;
  const analytic = net.params().map((p) => p.grad.slice());

  let worst = 0, checked = 0;
  net.params().forEach((p, pi) => {
    for (let i = 0; i < p.value.length; i++) {
      const old = p.value[i];
      p.value[i] = old + EPS; const lp = lossAt();
      p.value[i] = old - EPS; const lm = lossAt();
      p.value[i] = old;
      const num = (lp - lm) / (2 * EPS);
      const e = relErr(analytic[pi][i], num);
      worst = Math.max(worst, e); checked++;
      assert.ok(e < TOL, `param ${p.name}[${i}]: analytic ${analytic[pi][i]} vs numeric ${num} (rel ${e})`);
    }
  });
  if (checkInput) {
    for (let i = 0; i < x.length; i++) {
      const old = x[i];
      x[i] = old + EPS; const lp = lossAt();
      x[i] = old - EPS; const lm = lossAt();
      x[i] = old;
      const num = (lp - lm) / (2 * EPS);
      const e = relErr(analyticX[i], num);
      worst = Math.max(worst, e); checked++;
      assert.ok(e < TOL, `input[${i}]: analytic ${analyticX[i]} vs numeric ${num} (rel ${e})`);
    }
  }
  return { worst, checked };
}

test('Dense + softmax-CE: weights, biases and inputs', (t) => {
  const rng = new Rng(1);
  const net = new Sequential([new Dense(5, 4, { rng, dtype: F64, init: 'xavier' })], { dtype: F64 });
  const { x, y } = batch(rng, 3, 5, 4);
  const r = report(t, gradCheck(net, x, y, 3, { checkInput: true }));
  assert.ok(r.checked === 5 * 4 + 4 + 15);
});

test('Dense → ReLU → Dense → softmax-CE (two-layer MLP)', (t) => {
  const rng = new Rng(2);
  const net = new Sequential([
    new Dense(6, 8, { rng, dtype: F64 }), new ReLU({ dtype: F64 }), new Dense(8, 3, { rng, dtype: F64, init: 'xavier' }),
  ], { dtype: F64 });
  const { x, y } = batch(rng, 4, 6, 3);
  report(t, gradCheck(net, x, y, 4, { checkInput: true }));
});

test('three-layer MLP with LeakyReLU', (t) => {
  const rng = new Rng(3);
  const net = new Sequential([
    new Dense(4, 7, { rng, dtype: F64 }), new LeakyReLU({ alpha: 0.1, dtype: F64 }),
    new Dense(7, 5, { rng, dtype: F64 }), new ReLU({ dtype: F64 }),
    new Dense(5, 3, { rng, dtype: F64, init: 'xavier' }),
  ], { dtype: F64 });
  const { x, y } = batch(rng, 5, 4, 3);
  report(t, gradCheck(net, x, y, 5, { checkInput: true }));
});

test('Dense with fused input standardisation (inputNorm) has exact gradients', (t) => {
  const rng = new Rng(4);
  const net = new Sequential([
    new Dense(6, 5, { rng, dtype: F64, inputNorm: { mean: 0.13, std: 0.31 } }), new ReLU({ dtype: F64 }),
    new Dense(5, 4, { rng, dtype: F64, init: 'xavier' }),
  ], { dtype: F64 });
  // sparse, non-negative inputs like raw pixels
  const x = F64.from({ length: 3 * 6 }, () => (rng.next() < 0.5 ? 0 : rng.next()));
  const y = Uint8Array.from([0, 3, 1]);
  report(t, gradCheck(net, x, y, 3, { checkInput: true }));
});

test('inputNorm is identical to standardising the input first', () => {
  const rng = new Rng(5);
  const a = new Dense(6, 4, { rng: new Rng(9), dtype: F64, inputNorm: { mean: 0.2, std: 0.5 } });
  const b = new Dense(6, 4, { rng: new Rng(9), dtype: F64 });
  const x = F64.from({ length: 12 }, () => rng.next());
  const ya = a.forward(x, 2).slice();
  const yb = b.forward(x.map((v) => (v - 0.2) / 0.5), 2);
  ya.forEach((v, i) => assert.ok(Math.abs(v - yb[i]) < 1e-12));
});

test('Dropout: identity at inference, inverted scaling and matching mask in training', () => {
  const rng = new Rng(6);
  const d = new Dropout(0.5, { rng, dtype: F64 });
  const x = F64.from({ length: 10000 }, () => 1);
  assert.equal(d.forward(x, 1, false), x);
  const y = d.forward(x, 1, true);
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  assert.ok(Math.abs(mean - 1) < 0.05, `E[y] ≈ x (got ${mean})`);
  assert.ok(y.every((v) => v === 0 || v === 2));
  const dx = d.backward(F64.from({ length: 10000 }, () => 1));
  dx.forEach((v, i) => assert.equal(v, y[i]));
});
