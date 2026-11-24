import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warpAffine, randomAffine, augmentBatch } from '../src/augment.js';
import { centerOfMass } from '../src/preprocess.js';
import { Rng } from '../src/prng.js';

function blob() {
  const img = new Uint8Array(784);
  for (let y = 10; y < 18; y++) for (let x = 11; x < 16; x++) img[y * 28 + x] = 255;
  return img;
}

test('identity warp reproduces the image; a shift moves the centre of mass', () => {
  const src = blob();
  const id = warpAffine(src, new Float32Array(784), 28, 28, { gain: 1 / 255 });
  id.forEach((v, i) => assert.ok(Math.abs(v - src[i] / 255) < 1e-6));
  const c0 = centerOfMass(id, 28, 28);
  const sh = warpAffine(src, new Float32Array(784), 28, 28, { tx: 1.5, ty: -2, gain: 1 / 255 });
  const c1 = centerOfMass(sh, 28, 28);
  assert.ok(Math.abs(c1.x - c0.x - 1.5) < 1e-6 && Math.abs(c1.y - c0.y + 2) < 1e-6);
});

test('a 90° rotation about the centre maps a horizontal bar to a vertical one', () => {
  const bar = new Uint8Array(784);
  for (let x = 6; x < 22; x++) bar[13 * 28 + x] = 255;
  const r = warpAffine(bar, new Float32Array(784), 28, 28, { angle: Math.PI / 2, gain: 1 / 255 });
  let vertical = 0;
  for (let y = 6; y < 22; y++) vertical += r[y * 28 + 14] + r[y * 28 + 13];
  assert.ok(vertical > 10, `ink along the vertical axis: ${vertical}`);
});

test('random augmentation stays within its ranges and preserves most ink', () => {
  const rng = new Rng(3);
  for (let i = 0; i < 200; i++) {
    const t = randomAffine(rng);
    assert.ok(Math.abs(t.tx) <= 2 && Math.abs(t.ty) <= 2);
    assert.ok(Math.abs(t.angle) <= (10 * Math.PI) / 180 + 1e-12);
  }
  const images = new Uint8Array(784 * 4);
  for (let k = 0; k < 4; k++) images.set(blob(), k * 784);
  const out = augmentBatch(images, [3, 2, 1, 0], 0, 4, new Float32Array(4 * 784), rng);
  const mass = out.reduce((s, v) => s + v, 0) / 4;
  assert.ok(Math.abs(mass - 40) < 6, `mean ink ${mass} vs 40`);
});
