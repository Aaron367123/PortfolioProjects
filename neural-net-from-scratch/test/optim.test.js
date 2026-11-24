import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adam, SGD, cosineLR, stepLR } from '../src/optim.js';

const close = (a, b, tol = 1e-12) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
const param = (w, decay = false) => ({ name: 'w', value: Float64Array.of(w), grad: new Float64Array(1), decay });

test('Adam matches a hand-computed two-step update (with bias correction)', () => {
  // β₁ = 0.9, β₂ = 0.999, η = 0.1, ε = 1e-8, w₀ = 1
  const p = param(1);
  const adam = new Adam({ lr: 0.1, beta1: 0.9, beta2: 0.999, eps: 1e-8 });

  // step 1, g = 0.5:
  //   m = 0.1·0.5 = 0.05            v = 0.001·0.25 = 0.00025
  //   m̂ = 0.05/(1−0.9) = 0.5        v̂ = 0.00025/(1−0.999) = 0.25
  //   w = 1 − 0.1·0.5/(√0.25 + 1e-8) = 1 − 0.1·0.5/0.50000001 = 0.900000002
  p.grad[0] = 0.5;
  adam.step([p]);
  const s = adam.state.get(p.value);
  close(s.m[0], 0.05);
  close(s.v[0], 0.00025);
  close(p.value[0], 1 - 0.1 * 0.5 / (0.5 + 1e-8));
  close(p.value[0], 0.900000002, 1e-9);

  // step 2, g = −0.2:
  //   m = 0.9·0.05 + 0.1·(−0.2) = 0.025
  //   v = 0.999·0.00025 + 0.001·0.04 = 0.00028975
  //   m̂ = 0.025/(1−0.81) = 0.1315789474     v̂ = 0.00028975/(1−0.998001) = 0.1449474737
  //   w = 0.900000002 − 0.1·0.1315789474/0.3807196...  = 0.8654394181
  p.grad[0] = -0.2;
  adam.step([p]);
  close(s.m[0], 0.025);
  close(s.v[0], 0.00028975);
  close(p.value[0], 0.8654394181, 1e-9);
});

test('Adam first step moves every weight by ≈ lr regardless of gradient scale', () => {
  // m̂/√v̂ = g/|g| on step 1, the property that makes Adam robust to scaling.
  for (const g of [1e-3, 1, 1e4]) { // (much below ε·100 the ε term starts to matter)
    const p = param(0);
    p.grad[0] = g;
    new Adam({ lr: 0.01 }).step([p]);
    close(p.value[0], -0.01, 1e-6);
  }
});

test('AdamW decoupled weight decay shrinks weights only where decay=true', () => {
  const w = param(2, true), b = param(2, false);
  const adam = new Adam({ lr: 0.1, weightDecay: 0.5 });
  adam.step([w, b]); // zero gradient: only decay acts
  close(w.value[0], 2 - 0.1 * 0.5 * 2); // 1.9
  close(b.value[0], 2);
});

test('SGD with momentum matches hand-computed values, L2 adds λw', () => {
  const p = param(1);
  const sgd = new SGD({ lr: 0.1, momentum: 0.9 });
  p.grad[0] = 0.5; sgd.step([p]);   // v = 0.5,              w = 1 − 0.05 = 0.95
  close(p.value[0], 0.95);
  p.grad[0] = -0.2; sgd.step([p]);  // v = 0.9·0.5 − 0.2 = 0.25, w = 0.95 − 0.025 = 0.925
  close(p.value[0], 0.925);

  const q = param(1, true);
  q.grad[0] = 0;
  new SGD({ lr: 0.1, momentum: 0, weightDecay: 0.1 }).step([q]); // g = 0 + 0.1·1
  close(q.value[0], 0.99);
});

test('learning-rate schedules', () => {
  close(cosineLR(1, 0, 100), 1);
  close(cosineLR(1, 50, 100), 0.5);
  close(cosineLR(1, 100, 100, { min: 0.01 }), 0.01);
  close(cosineLR(1, 4, 100, { warmup: 10 }), 0.5);
  close(stepLR(1, 9, { every: 5, gamma: 0.5 }), 0.5);
  close(stepLR(1, 10, { every: 5, gamma: 0.5 }), 0.25);
});
