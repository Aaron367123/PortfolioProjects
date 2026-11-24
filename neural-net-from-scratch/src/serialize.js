// serialize.js — save a trained network as a small JSON manifest plus one
// binary blob, and load it back (Node or browser: the loader only needs an
// ArrayBuffer).
//
// Three weight encodings:
//   'f32'  4 bytes/weight, exact.
//   'f16'  2 bytes/weight, IEEE half precision (≈3 significant digits).
//   'int8' 1 byte/weight + one float32 scale per output neuron:
//            s_j = max_k |W_kj| / 127,   q_kj = round(W_kj / s_j) ∈ [−127, 127]
//          so W_kj ≈ s_j·q_kj with |error| ≤ s_j/2. Using a separate scale per
//          neuron (per column of W, i.e. per row of the usual out×in layout)
//          keeps neurons with small weights from being crushed by one neuron
//          with large weights.
// Biases (0.2 % of parameters) always stay float32.
//
// All multi-byte values are little-endian; tensors start on 4-byte
// boundaries so they can be viewed directly.

import { Dense, ReLU, LeakyReLU, Dropout } from './layers.js';
import { Sequential } from './network.js';

// ---------------------------------------------------------------- float16

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 → IEEE 754 binary16 bits, round-to-nearest-even. */
export function floatToHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);   // Inf / NaN
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;                           // overflow → Inf
  if (e <= 0) {                                                  // subnormal half
    if (e < -10) return sign;                                    // underflow → ±0
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;   // may carry into exponent: still correct
  return half;
}

/** IEEE 754 binary16 bits → number. */
export function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

// ---------------------------------------------------------------- int8

/**
 * Symmetric per-column int8 quantisation of a [rows × cols] matrix.
 * @returns {{q: Int8Array, scales: Float32Array}}
 */
export function quantizeInt8(W, rows, cols) {
  const scales = new Float32Array(cols);
  for (let k = 0; k < rows; k++) {
    for (let j = 0; j < cols; j++) {
      const a = Math.abs(W[k * cols + j]);
      if (a > scales[j]) scales[j] = a;
    }
  }
  for (let j = 0; j < cols; j++) scales[j] = scales[j] > 0 ? scales[j] / 127 : 1;
  const q = new Int8Array(rows * cols);
  for (let k = 0; k < rows; k++) {
    for (let j = 0; j < cols; j++) {
      const v = Math.round(W[k * cols + j] / scales[j]);
      q[k * cols + j] = Math.max(-127, Math.min(127, v));
    }
  }
  return { q, scales };
}

export function dequantizeInt8(q, scales, rows, cols, out = new Float32Array(rows * cols)) {
  for (let k = 0; k < rows; k++) {
    for (let j = 0; j < cols; j++) out[k * cols + j] = q[k * cols + j] * scales[j];
  }
  return out;
}

// ---------------------------------------------------------------- export

/**
 * @param {Sequential} net
 * @param {'f32'|'f16'|'int8'} format
 * @param {object} meta  extra information stored in the manifest (accuracy etc.)
 * @returns {{manifest: object, bin: Uint8Array}}
 */
export function exportModel(net, format = 'int8', meta = {}) {
  const chunks = [];
  let offset = 0;
  // Append a typed array's bytes, padded to 4-byte alignment; returns its record.
  const put = (arr, dtype) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).slice();
    const rec = { offset, length: arr.length, dtype };
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
    return rec;
  };

  const layers = net.layers.map((l) => {
    const cfg = l.config();
    if (l.type !== 'dense') return cfg;
    const { inSize: I, outSize: O } = l;
    if (format === 'f32') {
      cfg.W = put(Float32Array.from(l.W), 'f32');
    } else if (format === 'f16') {
      const h = new Uint16Array(l.W.length);
      for (let i = 0; i < h.length; i++) h[i] = floatToHalf(l.W[i]);
      cfg.W = put(h, 'f16');
    } else if (format === 'int8') {
      const { q, scales } = quantizeInt8(l.W, I, O);
      cfg.W = put(q, 'int8');
      cfg.scales = put(scales, 'f32');
    } else {
      throw new Error(`unknown format ${format}`);
    }
    cfg.b = put(Float32Array.from(l.b), 'f32');
    return cfg;
  });

  const bin = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) { bin.set(c, p); p += c.length; }
  const manifest = {
    format: 'nnfs-model',
    version: 1,
    weights: format,
    inputSize: net.inputSize,
    outputSize: net.outputSize,
    params: net.paramCount(),
    bytes: bin.length,
    layers,
    meta: { ...net.meta, ...meta },
  };
  return { manifest, bin };
}

// ---------------------------------------------------------------- import

function readTensor(buffer, rec) {
  const { offset, length, dtype } = rec;
  if (dtype === 'f32') return new Float32Array(buffer.slice(offset, offset + 4 * length));
  if (dtype === 'int8') return new Int8Array(buffer.slice(offset, offset + length));
  if (dtype === 'f16') {
    const h = new Uint16Array(buffer.slice(offset, offset + 2 * length));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = halfToFloat(h[i]);
    return out;
  }
  throw new Error(`unknown dtype ${dtype}`);
}

/**
 * Rebuild a Sequential network from a manifest and its binary blob.
 * Quantised weights are dequantised once at load time, so inference runs
 * the same float32 code path whatever the storage format.
 */
export function loadModel(manifest, arrayBuffer, { dtype = Float32Array } = {}) {
  if (manifest.format !== 'nnfs-model') throw new Error('not an nnfs-model manifest');
  const buffer = arrayBuffer instanceof ArrayBuffer
    ? arrayBuffer
    : arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength);
  if (buffer.byteLength !== manifest.bytes) {
    throw new Error(`model blob is ${buffer.byteLength} bytes, manifest says ${manifest.bytes}`);
  }
  const layers = manifest.layers.map((cfg, i) => {
    switch (cfg.type) {
      case 'dense': {
        const d = new Dense(cfg.in, cfg.out, { init: 'zeros', dtype, inputNorm: cfg.inputNorm ?? null, needInputGrad: i !== 0 });
        const W = readTensor(buffer, cfg.W);
        if (cfg.W.dtype === 'int8') dequantizeInt8(W, readTensor(buffer, cfg.scales), cfg.in, cfg.out, d.W);
        else d.W.set(W);
        d.b.set(readTensor(buffer, cfg.b));
        return d;
      }
      case 'relu': return new ReLU({ dtype });
      case 'leaky_relu': return new LeakyReLU({ alpha: cfg.alpha, dtype });
      case 'dropout': return new Dropout(cfg.p, { dtype });
      default: throw new Error(`unknown layer type ${cfg.type}`);
    }
  });
  const net = new Sequential(layers, { inputSize: manifest.inputSize, dtype });
  net.meta = manifest.meta ?? {};
  return net;
}

/** Browser (or any fetch-capable runtime): load `<base>.json` + the blob it names. */
export async function fetchModel(manifestUrl) {
  const manifest = await (await fetch(manifestUrl)).json();
  const binUrl = new URL(manifest.meta.bin ?? 'model.bin', new URL(manifestUrl, globalThis.location?.href)).href;
  const buf = await (await fetch(binUrl)).arrayBuffer();
  return { net: loadModel(manifest, buf), manifest, bytes: buf.byteLength };
}
