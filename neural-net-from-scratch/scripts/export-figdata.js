// export-figdata.js — collect the real numbers the README figures are drawn
// from (training curves, confusion matrix, first-layer weights, one drawing
// pushed through the preprocessing pipeline) into docs/figdata.json, which
// scripts/make_figures.py renders with Pillow.
//
//   node scripts/export-figdata.js
import { readFileSync, writeFileSync } from 'node:fs';
import { loadModel } from '../src/serialize.js';
import { preprocessInk } from '../src/preprocess.js';
import { loadMnist } from '../node/mnist.js';
import { drawStrokes } from '../node/raster.js';
import { Rng } from '../src/prng.js';

const dir = new URL('../model/', import.meta.url);
const metrics = JSON.parse(readFileSync(new URL('metrics.json', dir), 'utf8'));
const load = (n) => loadModel(JSON.parse(readFileSync(new URL(`${n}.json`, dir), 'utf8')), readFileSync(new URL(`${n}.bin`, dir)));
const fp = load('model-f32');
const q = load('model');

// --- first-layer weights: the 32 hidden units with the largest weight norm
const d0 = fp.layers[0];
const units = [];
for (let j = 0; j < d0.outSize; j++) {
  let s = 0;
  for (let k = 0; k < d0.inSize; k++) s += d0.W[k * d0.outSize + j] ** 2;
  units.push({ j, s });
}
units.sort((a, b) => b.s - a.s);
const weights = units.slice(0, 32).map(({ j }) => ({
  unit: j,
  w: Array.from({ length: 784 }, (_, k) => +d0.W[k * d0.outSize + j].toFixed(5)),
}));

// --- preprocessing: a hand-drawn-looking "4" on a 448×448 pad (the demo's size),
// off-centre and small, with a little pen wobble.
const W = 448, H = 448;
const rng = new Rng(4);
const wobble = (pts) => pts.flatMap(([x, y], i) => {
  if (i === 0) return [[x, y]];
  const [px, py] = pts[i - 1];
  const out = [];
  for (let t = 1; t <= 8; t++) out.push([px + ((x - px) * t) / 8 + rng.gaussian() * 1.2, py + ((y - py) * t) / 8 + rng.gaussian() * 1.2]);
  return out;
});
const strokes = [
  wobble([[232, 70], [150, 215], [150, 222], [300, 214]]),
  wobble([[262, 128], [256, 330]]),
];
const ink = drawStrokes(W, H, strokes, 28);
const res = preprocessInk(ink, W, H);
const probs = Array.from(q.predict(res.input, 1));
const toU8 = (a) => Array.from(a, (v) => Math.round(255 * Math.min(1, Math.max(0, v))));

// real MNIST "4"s for comparison
const { test } = loadMnist();
const fours = [];
for (let i = 0; i < test.count && fours.length < 6; i += 37) {
  if (test.labels[i] === 4) fours.push(Array.from(test.images.subarray(i * 784, i * 784 + 784)));
}

const out = {
  metrics: {
    curves: metrics.curves, confusion: metrics.confusion, perClassAccuracy: metrics.perClassAccuracy,
    testAccuracy: metrics.testAccuracy, testAccuracyInt8: metrics.testAccuracyInt8, bestEpoch: metrics.bestEpoch,
    architecture: metrics.architecture,
  },
  weights,
  preprocess: {
    raw: { w: W, h: H, data: toU8(ink) },
    bbox: res.stages.bbox,
    crop: { w: res.stages.crop.w, h: res.stages.crop.h, data: toU8(res.stages.crop.data) },
    stroke: res.stages.stroke,
    box: { w: res.stages.box.w, h: res.stages.box.h, data: toU8(res.stages.box.data) },
    final: toU8(res.input),
    com: res.stages.com,
    probs,
    mnist: fours,
  },
};
writeFileSync(new URL('../docs/figdata.json', import.meta.url), JSON.stringify(out));
console.log(`docs/figdata.json written; sample drawing predicted ${probs.indexOf(Math.max(...probs))} (${(100 * Math.max(...probs)).toFixed(1)}%), stroke ${res.stages.stroke.before.toFixed(1)} → target ${res.stages.stroke.target.toFixed(1)} px (r=${res.stages.stroke.radius})`);
