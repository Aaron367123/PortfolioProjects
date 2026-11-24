import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportModel, loadModel, floatToHalf, halfToFloat, quantizeInt8, dequantizeInt8,
} from '../src/serialize.js';
import { buildMLP } from '../src/network.js';
import { Rng } from '../src/prng.js';

function smallNet() {
  const net = buildMLP({ input: 20, hidden: [12, 8], classes: 4, dropout: 0.2, seed: 3, inputNorm: { mean: 0.1, std: 0.3 } });
  const rng = new Rng(9);
  for (const p of net.params()) for (let i = 0; i < p.value.length; i++) p.value[i] += rng.uniform(-0.05, 0.05);
  return net;
}
const input = () => { const r = new Rng(1); return Float32Array.from({ length: 5 * 20 }, () => r.next()); };

test('f32 round-trip reproduces weights and predictions exactly', () => {
  const net = smallNet();
  const { manifest, bin } = exportModel(net, 'f32', { note: 'hi' });
  const json = JSON.parse(JSON.stringify(manifest)); // survives a real JSON trip
  const back = loadModel(json, bin.buffer.slice(0));
  assert.equal(back.paramCount(), net.paramCount());
  net.params().forEach((p, i) => assert.deepEqual([...back.params()[i].value], [...p.value]));
  assert.deepEqual([...back.predict(input(), 5)], [...net.predict(input(), 5)]);
  assert.equal(json.meta.note, 'hi');
  assert.equal(json.layers[0].inputNorm.std, 0.3);
  assert.equal(bin.length, manifest.bytes);
  assert.equal(bin.length % 4, 0);
});

test('loader rejects a truncated blob and a foreign manifest', () => {
  const { manifest, bin } = exportModel(smallNet(), 'int8');
  assert.throws(() => loadModel(manifest, bin.slice(0, bin.length - 4)), /bytes/);
  assert.throws(() => loadModel({ ...manifest, format: 'x' }, bin), /manifest/);
});

test('float16 conversion: exact values, rounding, specials', () => {
  for (const v of [0, 1, -2, 0.5, 65504, 2 ** -14, 2 ** -24, 1.5]) assert.equal(halfToFloat(floatToHalf(v)), v);
  assert.equal(halfToFloat(floatToHalf(1e6)), Infinity);
  assert.ok(Number.isNaN(halfToFloat(floatToHalf(NaN))));
  assert.equal(halfToFloat(floatToHalf(2 ** -26)), 0);
  const rng = new Rng(2);
  for (let i = 0; i < 2000; i++) {
    const v = rng.uniform(-4, 4);
    const back = halfToFloat(floatToHalf(v));
    // 10 mantissa bits → relative error ≤ 2^-11 for normal numbers
    assert.ok(Math.abs(back - v) <= Math.abs(v) * 2 ** -11 + 2 ** -25, `${v} → ${back}`);
  }
});

test('int8 per-neuron quantisation error is bounded by half a step', () => {
  const rng = new Rng(4);
  const rows = 50, cols = 7;
  const W = Float32Array.from({ length: rows * cols }, (_, i) => rng.gaussian() * (1 + (i % cols))); // columns of different scale
  const { q, scales } = quantizeInt8(W, rows, cols);
  const back = dequantizeInt8(q, scales, rows, cols);
  for (let k = 0; k < rows; k++) {
    for (let j = 0; j < cols; j++) {
      const err = Math.abs(back[k * cols + j] - W[k * cols + j]);
      assert.ok(err <= scales[j] / 2 + 1e-6, `err ${err} > step/2 ${scales[j] / 2}`);
    }
  }
  // each column's largest weight maps to ±127 exactly
  for (let j = 0; j < cols; j++) {
    let m = 0;
    for (let k = 0; k < rows; k++) m = Math.max(m, Math.abs(q[k * cols + j]));
    assert.equal(m, 127);
  }
});

test('int8 and f16 models are ~4× / 2× smaller and predict nearly the same', () => {
  const net = smallNet();
  const f32 = exportModel(net, 'f32'), f16 = exportModel(net, 'f16'), i8 = exportModel(net, 'int8');
  assert.ok(f16.bin.length < 0.55 * f32.bin.length);
  // (this toy net has a high bias:weight ratio; the real 235k-parameter model is 0.25×)
  assert.ok(i8.bin.length < 0.4 * f32.bin.length);
  const ref = net.predict(input(), 5);
  for (const m of [f16, i8]) {
    const p = loadModel(m.manifest, m.bin).predict(input(), 5);
    p.forEach((v, i) => assert.ok(Math.abs(v - ref[i]) < 0.02));
  }
});
