// tensor.js — the handful of dense linear-algebra kernels a multilayer
// perceptron needs, written over flat typed arrays (Float32Array for speed,
// Float64Array for gradient checking). Every matrix is row-major:
// element (r, c) of an R×C matrix lives at index r*C + c.
//
// Training spends >95 % of its time in three matrix products:
//
//   * matmul        C = A·B      forward pass        (Y  = X·W)
//   * matmulTransA  C = Aᵀ·B     weight gradients    (dW = Xᵀ·dY)
//   * matmulTransB  C = A·Bᵀ     input gradients     (dX = dY·Wᵀ)
//
// None of them materialises a transpose. All three are one strided kernel,
// gemmTiled(), which computes a 4×4 block of C in sixteen local variables
// (registers) so each value loaded from A or B is reused four times. When the
// left operand is mostly zeros (raw MNIST pixels are ~81 % zeros), a
// row-streaming kernel that skips zero scalars wins instead, so the public
// functions pick a kernel from a cheap sparsity count. scripts/bench-matmul.js
// measures every variant.

/**
 * Reference matrix product, the textbook i-j-k loop. The innermost loop walks
 * B down a column (stride N) and keeps one running sum, so it is bound by
 * memory latency and the add-dependency chain. Ground truth for tests and the
 * baseline in the benchmark.
 */
export function matmulNaive(A, B, C, M, K, N) {
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let k = 0; k < K; k++) s += A[i * K + k] * B[k * N + j];
      C[i * N + j] = s;
    }
  }
  return C;
}

/**
 * Register-tiled general product with arbitrary strides:
 *
 *   C[i,j] = Σ_k A[i·ars + k·aks] · B[k·bks + j·bjs]       (C is M×N, row-major)
 *
 * Choosing the strides gives A·B, Aᵀ·B or A·Bᵀ without moving any data.
 * Each pass of the k loop loads 4 values of A and 4 of B and performs 16
 * multiply-adds into independent accumulators: 2 FLOPs per load instead of
 * the naive loop's 1, and no loop-carried dependency longer than one add.
 */
export function gemmTiled(A, B, C, M, N, K, ars, aks, bks, bjs) {
  const M4 = M - (M % 4);
  const N4 = N - (N % 4);
  const a1o = ars, a2o = 2 * ars, a3o = 3 * ars;
  const b1o = bjs, b2o = 2 * bjs, b3o = 3 * bjs;
  for (let i = 0; i < M4; i += 4) {
    for (let j = 0; j < N4; j += 4) {
      let s00 = 0, s01 = 0, s02 = 0, s03 = 0;
      let s10 = 0, s11 = 0, s12 = 0, s13 = 0;
      let s20 = 0, s21 = 0, s22 = 0, s23 = 0;
      let s30 = 0, s31 = 0, s32 = 0, s33 = 0;
      let ap = i * ars;
      let bp = j * bjs;
      for (let k = 0; k < K; k++) {
        const a0 = A[ap], a1 = A[ap + a1o], a2 = A[ap + a2o], a3 = A[ap + a3o];
        const b0 = B[bp], b1 = B[bp + b1o], b2 = B[bp + b2o], b3 = B[bp + b3o];
        ap += aks;
        bp += bks;
        s00 += a0 * b0; s01 += a0 * b1; s02 += a0 * b2; s03 += a0 * b3;
        s10 += a1 * b0; s11 += a1 * b1; s12 += a1 * b2; s13 += a1 * b3;
        s20 += a2 * b0; s21 += a2 * b1; s22 += a2 * b2; s23 += a2 * b3;
        s30 += a3 * b0; s31 += a3 * b1; s32 += a3 * b2; s33 += a3 * b3;
      }
      let c = i * N + j;
      C[c] = s00; C[c + 1] = s01; C[c + 2] = s02; C[c + 3] = s03; c += N;
      C[c] = s10; C[c + 1] = s11; C[c + 2] = s12; C[c + 3] = s13; c += N;
      C[c] = s20; C[c + 1] = s21; C[c + 2] = s22; C[c + 3] = s23; c += N;
      C[c] = s30; C[c + 1] = s31; C[c + 2] = s32; C[c + 3] = s33;
    }
  }
  // Ragged edges (M or N not a multiple of 4): plain strided dot products.
  for (let i = 0; i < M; i++) {
    for (let j = i < M4 ? N4 : 0; j < N; j++) {
      let s = 0;
      let ap = i * ars;
      let bp = j * bjs;
      for (let k = 0; k < K; k++) { s += A[ap] * B[bp]; ap += aks; bp += bks; }
      C[i * N + j] = s;
    }
  }
  return C;
}

/**
 * Sparse-friendly C[M×N] = A[M×K]·B[K×N] in i-k-j order: for each scalar
 * a = A[i,k] add a·B[k,:] to C[i,:]. Both rows are contiguous and a zero
 * scalar skips a whole row of work, so the cost is proportional to the
 * number of non-zeros in A.
 */
export function matmulSparseA(A, B, C, M, K, N) {
  C.fill(0, 0, M * N);
  for (let i = 0; i < M; i++) {
    const aRow = i * K;
    const cRow = i * N;
    for (let k = 0; k < K; k++) {
      const a = A[aRow + k];
      if (a === 0) continue;
      const bRow = k * N;
      for (let j = 0; j < N; j++) C[cRow + j] += a * B[bRow + j];
    }
  }
  return C;
}

/** Sparse-friendly C[M×N] = Aᵀ·B with A stored [K×M]: skips zero A[k,i]. */
export function matmulTransASparse(A, B, C, M, K, N) {
  C.fill(0, 0, M * N);
  for (let i = 0; i < M; i++) {
    const cRow = i * N;
    for (let k = 0; k < K; k++) {
      const a = A[k * M + i];
      if (a === 0) continue;
      const bRow = k * N;
      for (let j = 0; j < N; j++) C[cRow + j] += a * B[bRow + j];
    }
  }
  return C;
}

/** Fraction of exact zeros in the first n elements of v. */
export function zeroFraction(v, n = v.length) {
  let z = 0;
  for (let i = 0; i < n; i++) if (v[i] === 0) z++;
  return n === 0 ? 0 : z / n;
}

// Measured break-even (scripts/bench-matmul.js): the zero-skipping kernel
// beats the tiled one once roughly two thirds of A is zeros.
const SPARSE_THRESHOLD = 0.65;

/** C[M×N] = A[M×K] · B[K×N]. */
export function matmul(A, B, C, M, K, N) {
  // Fewer than 4 rows (e.g. inference on one digit): no 4×4 tiles fit, and
  // row streaming reads B contiguously instead of down its columns.
  if (M < 4) return matmulSparseA(A, B, C, M, K, N);
  if (M * K >= 64 && zeroFraction(A, M * K) > SPARSE_THRESHOLD) return matmulSparseA(A, B, C, M, K, N);
  return gemmTiled(A, B, C, M, N, K, K, 1, N, 1);
}

/** C[M×N] = Aᵀ · B, with A stored as [K×M] and B as [K×N] (e.g. dW = Xᵀ·dY). */
export function matmulTransA(A, B, C, M, K, N) {
  if (M * K >= 64 && zeroFraction(A, M * K) > SPARSE_THRESHOLD) return matmulTransASparse(A, B, C, M, K, N);
  return gemmTiled(A, B, C, M, N, K, 1, M, N, 1);
}

/** C[M×N] = A · Bᵀ, with A stored as [M×K] and B as [N×K] (e.g. dX = dY·Wᵀ). */
export function matmulTransB(A, B, C, M, K, N) {
  return gemmTiled(A, B, C, M, N, K, K, 1, 1, K);
}

/** Y[M×N] += b[N] broadcast to every row (adds the bias vector). */
export function addRowVector(Y, b, M, N) {
  for (let i = 0; i < M; i++) {
    const r = i * N;
    for (let j = 0; j < N; j++) Y[r + j] += b[j];
  }
  return Y;
}

/** out[N] = Σ_i X[i,:] — column sums, i.e. the bias gradient Σ_batch dY. */
export function sumRows(X, out, M, N) {
  out.fill(0, 0, N);
  for (let i = 0; i < M; i++) {
    const r = i * N;
    for (let j = 0; j < N; j++) out[j] += X[r + j];
  }
  return out;
}

/** Index of the largest element of v[offset .. offset+n). */
export function argmax(v, offset = 0, n = v.length - offset) {
  let best = 0;
  let bestV = -Infinity;
  for (let j = 0; j < n; j++) {
    if (v[offset + j] > bestV) { bestV = v[offset + j]; best = j; }
  }
  return best;
}

/**
 * Growable scratch buffer: returns a view of exactly `size` elements backed by
 * an allocation that only grows. Layers use this so that alternating batch
 * sizes (128 for training, 1000 for evaluation) do not allocate on every call.
 */
export class Scratch {
  constructor(Type = Float32Array) {
    this.Type = Type;
    this.buf = new Type(0);
  }
  get(size) {
    if (this.buf.length < size) this.buf = new this.Type(size);
    return this.buf.subarray(0, size);
  }
}
