import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matmulNaive, matmul, matmulTransA, matmulTransB, gemmTiled, matmulSparseA, matmulTransASparse,
  addRowVector, sumRows, argmax, zeroFraction,
} from '../src/tensor.js';
import { Rng } from '../src/prng.js';

const rng = new Rng(123);
const rand = (n, zeros = 0) => Float64Array.from({ length: n }, () => (rng.next() < zeros ? 0 : rng.uniform(-1, 1)));
const transpose = (A, R, C) => {
  const T = new Float64Array(R * C);
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) T[c * R + r] = A[r * C + c];
  return T;
};
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

// Odd sizes exercise the ragged-edge code of the 4×4 tile kernel.
const SHAPES = [[1, 1, 1], [3, 5, 2], [4, 4, 4], [7, 13, 10], [16, 33, 9], [32, 64, 48]];

test('matmul (tiled and sparse paths) matches the naive reference', () => {
  for (const [M, K, N] of SHAPES) {
    for (const zeros of [0, 0.9]) {
      const A = rand(M * K, zeros), B = rand(K * N);
      const ref = matmulNaive(A, B, new Float64Array(M * N), M, K, N);
      assert.ok(maxDiff(matmul(A, B, new Float64Array(M * N), M, K, N), ref) < 1e-12, `matmul ${M}x${K}x${N} zeros=${zeros}`);
      assert.ok(maxDiff(gemmTiled(A, B, new Float64Array(M * N), M, N, K, K, 1, N, 1), ref) < 1e-12);
      assert.ok(maxDiff(matmulSparseA(A, B, new Float64Array(M * N), M, K, N), ref) < 1e-12);
    }
  }
});

test('matmulTransA computes Aᵀ·B without an explicit transpose', () => {
  for (const [M, K, N] of SHAPES) {
    for (const zeros of [0, 0.9]) {
      const A = rand(K * M, zeros), B = rand(K * N); // A stored K×M
      const ref = matmulNaive(transpose(A, K, M), B, new Float64Array(M * N), M, K, N);
      assert.ok(maxDiff(matmulTransA(A, B, new Float64Array(M * N), M, K, N), ref) < 1e-12);
      assert.ok(maxDiff(matmulTransASparse(A, B, new Float64Array(M * N), M, K, N), ref) < 1e-12);
    }
  }
});

test('matmulTransB computes A·Bᵀ without an explicit transpose', () => {
  for (const [M, K, N] of SHAPES) {
    const A = rand(M * K), B = rand(N * K); // B stored N×K
    const ref = matmulNaive(A, transpose(B, N, K), new Float64Array(M * N), M, K, N);
    assert.ok(maxDiff(matmulTransB(A, B, new Float64Array(M * N), M, K, N), ref) < 1e-12);
  }
});

test('matmul overwrites (does not accumulate into) a dirty output buffer', () => {
  const A = rand(4 * 6), B = rand(6 * 5);
  const C = new Float64Array(20).fill(99);
  const ref = matmulNaive(A, B, new Float64Array(20), 4, 6, 5);
  assert.ok(maxDiff(matmul(A, B, C, 4, 6, 5), ref) < 1e-12);
  C.fill(99);
  assert.ok(maxDiff(matmul(A.map((v, i) => (i % 3 ? 0 : v)), B, C, 4, 6, 5),
    matmulNaive(A.map((v, i) => (i % 3 ? 0 : v)), B, new Float64Array(20), 4, 6, 5)) < 1e-12);
});

test('Float32 matmul agrees with Float64 to single precision', () => {
  const M = 64, K = 784, N = 32;
  const A = rand(M * K, 0.8), B = rand(K * N);
  const ref = matmulNaive(A, B, new Float64Array(M * N), M, K, N);
  const got = matmul(Float32Array.from(A), Float32Array.from(B), new Float32Array(M * N), M, K, N);
  assert.ok(maxDiff(got, ref) < 1e-4);
});

test('bias helpers, argmax and zeroFraction', () => {
  const Y = Float64Array.from([1, 2, 3, 4, 5, 6]);
  addRowVector(Y, [10, 20, 30], 2, 3);
  assert.deepEqual([...Y], [11, 22, 33, 14, 25, 36]);
  assert.deepEqual([...sumRows(Y, new Float64Array(3), 2, 3)], [25, 47, 69]);
  assert.equal(argmax([0.1, 0.7, 0.2]), 1);
  assert.equal(argmax([5, 1, 9, 2], 2, 2), 0);
  assert.equal(zeroFraction([0, 1, 0, 0]), 0.75);
});
