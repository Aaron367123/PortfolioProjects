// bench-matmul.js — measures the matmul kernels on the shapes the MNIST MLP
// actually uses (batch 128, 784→256) and writes docs/bench.json.
//
//   node scripts/bench-matmul.js
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  matmulNaive, matmulSparseA, gemmTiled, matmul, matmulTransA, matmulTransB, zeroFraction,
} from '../src/tensor.js';
import { Rng } from '../src/prng.js';
import { loadMnist } from '../node/mnist.js';

const rng = new Rng(42);
const rand = (n) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = rng.uniform(-1, 1);
  return a;
};

/** Median wall time (ms) of fn over `reps` runs after a warm-up. */
function time(fn, reps = 15) {
  for (let i = 0; i < 3; i++) fn();
  const t = [];
  for (let i = 0; i < reps; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}

function transpose(A, R, C) {
  const T = new Float32Array(R * C);
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) T[c * R + r] = A[r * C + c];
  return T;
}

const B = 128, IN = 784, OUT = 256;
const X = rand(B * IN);  // dense operand: measures loop order / tiling alone
const W = rand(IN * OUT);
const dY = rand(B * OUT);
const Y = new Float32Array(B * OUT);
const dW = new Float32Array(IN * OUT);
const dX = new Float32Array(B * IN);

// A real batch of raw MNIST pixels in [0, 1] (the first layer's actual input).
let Xm = null;
try {
  const { train } = loadMnist();
  Xm = new Float32Array(B * IN);
  for (let i = 0; i < B * IN; i++) Xm[i] = train.images[i] / 255;
} catch { /* data not downloaded: skip the sparse rows */ }

const gflop = (2 * B * IN * OUT) / 1e9;
const results = {};
const row = (key, label, ms) => {
  results[key] = { label, ms: +ms.toFixed(2), gflops: +(gflop / (ms / 1000)).toFixed(2) };
  console.log(`${label.padEnd(52)} ${ms.toFixed(2).padStart(7)} ms  ${(gflop / (ms / 1000)).toFixed(2)} GFLOP/s`);
};

console.log(`node ${process.version} — X[${B}×${IN}] · W[${IN}×${OUT}] = ${(gflop * 1e3).toFixed(1)} MFLOP per product\n`);
row('fwdNaive', 'forward  naive i-j-k', time(() => matmulNaive(X, W, Y, B, IN, OUT), 7));
row('fwdIKJ', 'forward  i-k-j row streaming', time(() => matmulSparseA(X, W, Y, B, IN, OUT)));
row('fwdTiled', 'forward  4×4 register tile', time(() => gemmTiled(X, W, Y, B, OUT, IN, IN, 1, OUT, 1)));
if (Xm) {
  console.log(`\nraw MNIST batch: ${(100 * zeroFraction(Xm)).toFixed(1)} % zeros`);
  row('mnistNaive', 'forward  naive, MNIST pixels', time(() => matmulNaive(Xm, W, Y, B, IN, OUT), 7));
  row('mnistTiled', 'forward  4×4 tile, MNIST pixels', time(() => gemmTiled(Xm, W, Y, B, OUT, IN, IN, 1, OUT, 1)));
  row('mnistSparse', 'forward  zero-skipping i-k-j, MNIST pixels', time(() => matmulSparseA(Xm, W, Y, B, IN, OUT)));
  row('mnistDispatch', 'forward  matmul() auto-dispatch, MNIST pixels', time(() => matmul(Xm, W, Y, B, IN, OUT)));
}
console.log('');
row('dWNaive', 'dW naive: transpose X, then i-j-k', time(() => matmulNaive(transpose(X, B, IN), dY, dW, IN, B, OUT), 7));
row('dWTiled', 'dW matmulTransA (Xᵀ·dY via strides)', time(() => matmulTransA(X, dY, dW, IN, B, OUT)));
row('dXNaive', 'dX naive: transpose W, then i-j-k', time(() => matmulNaive(dY, transpose(W, IN, OUT), dX, B, OUT, IN), 7));
row('dXTiled', 'dX matmulTransB (dY·Wᵀ via strides)', time(() => matmulTransB(dY, W, dX, B, OUT, IN)));

const r2 = (a, b) => +(results[a].ms / results[b].ms).toFixed(2);
const speedup = {
  forwardTiledVsNaive: r2('fwdNaive', 'fwdTiled'),
  forwardIKJVsNaive: r2('fwdNaive', 'fwdIKJ'),
  dWVsNaive: r2('dWNaive', 'dWTiled'),
  dXVsNaive: r2('dXNaive', 'dXTiled'),
  ...(Xm ? { mnistDispatchVsNaive: r2('mnistNaive', 'mnistDispatch'), mnistSparseVsTiled: r2('mnistTiled', 'mnistSparse') } : {}),
};
console.log('\nspeed-up:', speedup);

mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/bench.json', import.meta.url), JSON.stringify({
  node: process.version, shapes: { batch: B, in: IN, out: OUT }, results, speedup,
}, null, 2) + '\n');
