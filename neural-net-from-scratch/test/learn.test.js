// End-to-end learning on toy problems a linear model cannot solve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dense, ReLU } from '../src/layers.js';
import { Sequential } from '../src/network.js';
import { Adam, SGD } from '../src/optim.js';
import { Rng } from '../src/prng.js';
import { argmax } from '../src/tensor.js';

function accuracy(net, x, y, n) {
  const z = net.forward(x, n, false);
  let c = 0;
  for (let i = 0; i < n; i++) if (argmax(z, i * net.outputSize, net.outputSize) === y[i]) c++;
  return c / n;
}

test('a 2-16-2 MLP learns XOR', () => {
  const rng = new Rng(11);
  const net = new Sequential([new Dense(2, 16, { rng }), new ReLU(), new Dense(16, 2, { rng, init: 'xavier' })]);
  const x = Float32Array.of(0, 0, 0, 1, 1, 0, 1, 1);
  const y = Uint8Array.of(0, 1, 1, 0);
  const opt = new SGD({ lr: 0.1, momentum: 0.9 });
  let loss = Infinity;
  for (let i = 0; i < 500; i++) loss = net.trainBatch(x, y, 4, opt).loss;
  assert.equal(accuracy(net, x, y, 4), 1);
  assert.ok(loss < 0.05, `loss ${loss}`);
});

test('a 2-64-64-3 MLP learns the 3-arm spiral to > 95 %', () => {
  // The classic CS231n spiral: 3 interleaved arms, 100 points each, with noise.
  const rng = new Rng(5);
  const N = 100, K = 3, n = N * K;
  const x = new Float32Array(n * 2), y = new Uint8Array(n);
  for (let c = 0; c < K; c++) {
    for (let i = 0; i < N; i++) {
      const r = i / N;
      const t = c * 4 + (4 * i) / N + rng.gaussian() * 0.2;
      const j = c * N + i;
      x[2 * j] = r * Math.sin(t);
      x[2 * j + 1] = r * Math.cos(t);
      y[j] = c;
    }
  }
  const net = new Sequential([
    new Dense(2, 64, { rng }), new ReLU(), new Dense(64, 64, { rng }), new ReLU(), new Dense(64, 3, { rng, init: 'xavier' }),
  ]);
  const opt = new Adam({ lr: 0.01 });
  for (let i = 0; i < 1500; i++) net.trainBatch(x, y, n, opt);
  const acc = accuracy(net, x, y, n);
  assert.ok(acc > 0.95, `spiral accuracy ${acc}`);
});
