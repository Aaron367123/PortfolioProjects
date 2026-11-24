import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  preprocessInk, centerOfMass, strokeWidth, boundingBox, resizeArea, inkFromRGBA, morph,
} from '../src/preprocess.js';
import { drawStrokes, arc } from '../node/raster.js';

const W = 280, H = 280;
const seven = (dx = 0, dy = 0, s = 1) => [[[30, 30], [130, 30], [70, 160]].map(([x, y]) => [dx + x * s, dy + y * s])];
const zero = (cx, cy, r) => [arc(cx, cy, r * 0.7, r, 0, 2 * Math.PI, 40)];
const two = [[[60, 80], ...arc(120, 90, 60, 50, Math.PI, 2 * Math.PI + 0.6, 16).slice(1), [60, 230], [190, 230]]];

test('centre of mass lands at (14, 14) ± 0.5 wherever the digit is drawn', () => {
  const cases = [
    drawStrokes(W, H, seven(), 18),               // top-left corner
    drawStrokes(W, H, seven(120, 100, 0.8), 18),  // bottom-right, smaller
    drawStrokes(W, H, zero(200, 90, 50), 20),
    drawStrokes(W, H, two, 22),
    drawStrokes(W, H, [[[140, 20], [140, 260]]], 16), // a "1"
  ];
  for (const ink of cases) {
    const r = preprocessInk(ink, W, H);
    const c = centerOfMass(r.input, 28, 28);
    assert.ok(Math.abs(c.x - 14) <= 0.5 && Math.abs(c.y - 14) <= 0.5, `COM (${c.x.toFixed(2)}, ${c.y.toFixed(2)})`);
  }
});

test('aspect ratio is preserved: longest side → 20 px', () => {
  const rect = new Float32Array(W * H);
  for (let y = 100; y < 160; y++) for (let x = 40; x < 160; x++) rect[y * W + x] = 1; // 120 × 60
  const r = preprocessInk(rect, W, H, { normalizeStroke: false });
  assert.deepEqual([r.stages.box.w, r.stages.box.h], [20, 10]);
  const bb = boundingBox(r.input, 28, 28, 0.5);
  assert.ok(Math.abs(bb.w - 20) <= 1 && Math.abs(bb.h - 10) <= 1, `bbox ${bb.w}×${bb.h}`);

  const one = preprocessInk(drawStrokes(W, H, [[[100, 30], [110, 250]]], 18), W, H);
  assert.equal(one.stages.box.h, 20);
  assert.ok(one.stages.box.w <= 4, `a "1" stays narrow (w=${one.stages.box.w})`);
});

test('output is in [0, 1] with peak ink 1, and an empty canvas gives null', () => {
  const r = preprocessInk(drawStrokes(W, H, two, 20), W, H);
  assert.equal(r.input.length, 784);
  assert.ok(r.input.every((v) => v >= 0 && v <= 1));
  assert.ok(Math.max(...r.input) > 0.95);
  assert.equal(preprocessInk(new Float32Array(W * H), W, H), null);
  const faint = new Float32Array(W * H).fill(0.01);
  assert.equal(preprocessInk(faint, W, H), null, 'below threshold = nothing drawn');
});

test('stroke-width normalisation maps thin and thick pens to MNIST-like ≈2 px strokes', () => {
  const widths = [6, 14, 40].map((pen) => {
    const r = preprocessInk(drawStrokes(W, H, seven(), pen), W, H);
    return strokeWidth(r.input, 28, 28);
  });
  const raw = [6, 14, 40].map((pen) => {
    const r = preprocessInk(drawStrokes(W, H, seven(), pen), W, H, { normalizeStroke: false });
    return strokeWidth(r.input, 28, 28);
  });
  for (const w of widths) assert.ok(w > 1.4 && w < 3.0, `normalised width ${w.toFixed(2)}`);
  assert.ok(Math.max(...widths) - Math.min(...widths) < Math.max(...raw) - Math.min(...raw));
});

test('building blocks: area resize conserves mean, morph grows/shrinks, alpha → ink', () => {
  const src = Float32Array.from({ length: 30 * 30 }, (_, i) => (i * 7919) % 13 / 13);
  const out = resizeArea(src, 30, 30, 20, 20);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(Math.abs(mean(out) - mean(src)) < 1e-6);

  const dot = new Float32Array(9 * 9); dot[40] = 1;
  assert.equal(morph(dot, 9, 9, 1).reduce((s, v) => s + v, 0), 9);
  assert.equal(morph(morph(dot, 9, 9, 1), 9, 9, -1).reduce((s, v) => s + v, 0), 1);

  const rgba = Uint8ClampedArray.of(0, 0, 0, 0, 255, 255, 255, 255, 9, 9, 9, 51);
  assert.deepEqual([...inkFromRGBA(rgba, 3, 1)].map((v) => +v.toFixed(2)), [0, 1, 0.2]);
});
