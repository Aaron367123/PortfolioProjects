// train.js — train the MNIST MLP from scratch, then quantise, evaluate and
// export everything the README and the browser demo need.
//
//   node train.js [--epochs 30] [--hidden 256,128] [--seed 1] [--batch 128]
//                 [--lr 0.001] [--dropout 0.2] [--wd 0.02] [--no-aug]
//
// Outputs (model/):
//   model.json + model.bin           int8-quantised weights (shipped to the browser)
//   model-f32.json + model-f32.bin   full-precision weights
//   metrics.json                     curves, test accuracy, confusion matrix, sizes, timings
//   samples-images.idx / samples-labels.idx / samples.json   50 test digits for the demo
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadMnist } from './node/mnist.js';
import { buildMLP, defaultToInput } from './src/network.js';
import { Adam, cosineLR } from './src/optim.js';
import { Rng } from './src/prng.js';
import { augmentBatch } from './src/augment.js';
import { exportModel, loadModel } from './src/serialize.js';
import { perClassAccuracy, topConfusions } from './src/metrics.js';
import { encodeIDXUint8 } from './src/idx.js';

const { values: opt } = parseArgs({
  options: {
    epochs: { type: 'string', default: '30' },
    hidden: { type: 'string', default: '256,128' },
    seed: { type: 'string', default: '1' },
    batch: { type: 'string', default: '128' },
    lr: { type: 'string', default: '0.001' },
    dropout: { type: 'string', default: '0.2' },
    wd: { type: 'string', default: '0.02' },
    'no-aug': { type: 'boolean', default: false },
    out: { type: 'string', default: 'model' },
  },
});
const cfg = {
  epochs: +opt.epochs,
  hidden: opt.hidden.split(',').map(Number),
  seed: +opt.seed,
  batch: +opt.batch,
  lr: +opt.lr,
  dropout: +opt.dropout,
  weightDecay: +opt.wd,
  augment: !opt['no-aug'],
  validation: 5000,
};
const OUT = new URL(`./${opt.out}/`, import.meta.url);
mkdirSync(OUT, { recursive: true });
const D = 784, K = 10;

// ------------------------------------------------------------------ data
const t0 = performance.now();
const { train, test } = loadMnist();
console.log(`loaded MNIST in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${train.count} train, ${test.count} test`);

// Hold out 5 000 training images for validation (model selection), chosen
// by a seeded shuffle so the split is reproducible.
const rng = new Rng(cfg.seed);
const order = rng.shuffle(Uint32Array.from({ length: train.count }, (_, i) => i));
const valIdx = order.subarray(0, cfg.validation);
const trIdx = order.slice(cfg.validation);
const gather = (idx) => {
  const im = new Uint8Array(idx.length * D), lb = new Uint8Array(idx.length);
  idx.forEach((s, i) => { im.set(train.images.subarray(s * D, s * D + D), i * D); lb[i] = train.labels[s]; });
  return { images: im, labels: lb, count: idx.length };
};
const val = gather(valIdx);
const tr = gather(trIdx);

// Standardisation statistics from the training split only (no peeking at val/test).
let s1 = 0, s2 = 0;
for (let i = 0; i < tr.images.length; i++) { const v = tr.images[i] / 255; s1 += v; s2 += v * v; }
const mean = s1 / tr.images.length;
const std = Math.sqrt(s2 / tr.images.length - mean * mean);
console.log(`pixel mean ${mean.toFixed(4)}, std ${std.toFixed(4)}`);

// ------------------------------------------------------------------ model
const net = buildMLP({
  hidden: cfg.hidden, dropout: cfg.dropout, seed: cfg.seed, inputNorm: { mean: +mean.toFixed(6), std: +std.toFixed(6) },
});
const params = net.paramCount();
console.log(`MLP 784-${cfg.hidden.join('-')}-10, ${params.toLocaleString()} parameters, config`, cfg);

const optimizer = new Adam({ lr: cfg.lr, weightDecay: cfg.weightDecay, decoupled: true });
const stepsPerEpoch = Math.ceil(tr.count / cfg.batch);
const totalSteps = stepsPerEpoch * cfg.epochs;
const warmup = Math.min(500, stepsPerEpoch);
const xBuf = new Float32Array(cfg.batch * D);
const yBuf = new Uint8Array(cfg.batch);
const augRng = new Rng(cfg.seed + 101);
const trainOrder = Uint32Array.from({ length: tr.count }, (_, i) => i);

// clean (un-augmented, dropout off) accuracy on a fixed 10k slice of the training split
const trainEvalCount = 10000;

const curves = [];
let best = { valAcc: -1, epoch: -1, weights: null };
const tTrain = performance.now();
let step = 0;

for (let epoch = 1; epoch <= cfg.epochs; epoch++) {
  const te = performance.now();
  rng.shuffle(trainOrder);
  let lossSum = 0, correct = 0, seen = 0, lr = cfg.lr;
  for (let s = 0; s < tr.count; s += cfg.batch) {
    const n = Math.min(cfg.batch, tr.count - s);
    const x = xBuf.subarray(0, n * D);
    if (cfg.augment) {
      augmentBatch(tr.images, trainOrder, s, n, x, augRng);
    } else {
      for (let i = 0; i < n; i++) {
        const src = trainOrder[s + i] * D;
        for (let p = 0; p < D; p++) x[i * D + p] = tr.images[src + p] / 255;
      }
    }
    for (let i = 0; i < n; i++) yBuf[i] = tr.labels[trainOrder[s + i]];
    lr = cosineLR(cfg.lr, step, totalSteps, { min: cfg.lr * 0.01, warmup });
    const r = net.trainBatch(x, yBuf.subarray(0, n), n, optimizer, lr);
    lossSum += r.loss * n; correct += r.correct; seen += n; step++;
  }
  const v = net.evaluate(val.images, val.labels, val.count);
  const tclean = net.evaluate(tr.images, tr.labels, trainEvalCount);
  const sec = (performance.now() - te) / 1000;
  const row = {
    epoch, lr: +lr.toExponential(3),
    trainLoss: +(lossSum / seen).toFixed(5), trainAccAug: +(correct / seen).toFixed(5),
    trainLossClean: +tclean.loss.toFixed(5), trainAcc: +tclean.accuracy.toFixed(5),
    valLoss: +v.loss.toFixed(5), valAcc: +v.accuracy.toFixed(5), seconds: +sec.toFixed(1),
  };
  curves.push(row);
  console.log(`epoch ${String(epoch).padStart(2)}  loss ${row.trainLoss.toFixed(4)}  train ${(100 * row.trainAcc).toFixed(2)}% (aug ${(100 * row.trainAccAug).toFixed(2)}%)  val ${(100 * row.valAcc).toFixed(2)}% (loss ${row.valLoss.toFixed(4)})  lr ${row.lr}  ${sec.toFixed(1)} s`);
  if (v.accuracy > best.valAcc) {
    best = { valAcc: v.accuracy, epoch, weights: net.params().map((p) => p.value.slice()) };
  }
}
const trainSeconds = (performance.now() - tTrain) / 1000;
net.params().forEach((p, i) => p.value.set(best.weights[i]));
net.invalidate(); // weights were changed directly: drop cached values
console.log(`\ntrained in ${(trainSeconds / 60).toFixed(1)} min; best val ${(100 * best.valAcc).toFixed(2)}% at epoch ${best.epoch}`);

// ------------------------------------------------------------------ test + quantisation
const evalTest = (m) => m.evaluate(test.images, test.labels, test.count);
const fp = evalTest(net);
console.log(`test accuracy fp32: ${(100 * fp.accuracy).toFixed(2)}%`);

const exported = {};
for (const fmt of ['f32', 'f16', 'int8']) {
  const { manifest, bin } = exportModel(net, fmt);
  const reloaded = loadModel(manifest, bin);
  const r = evalTest(reloaded);
  exported[fmt] = { manifest, bin, net: reloaded, result: r };
  console.log(`  ${fmt.padEnd(4)} ${String(bin.length).padStart(8)} bytes  test ${(100 * r.accuracy).toFixed(2)}%`);
}
const q = exported.int8;

// ------------------------------------------------------------------ inference timing
function timeInference(model, reps = 3000) {
  const x = new Float32Array(D);
  for (let w = 0; w < 300; w++) { defaultToInput(test.images, w % 1000, 1, D, x); model.predict(x, 1); }
  const s = performance.now();
  for (let r = 0; r < reps; r++) { defaultToInput(test.images, r % test.count, 1, D, x); model.predict(x, 1); }
  return (performance.now() - s) / reps;
}
const inferMs = timeInference(q.net);
const tb = performance.now();
q.net.evaluate(test.images, test.labels, test.count, { batch: 1000 });
const batchedUs = ((performance.now() - tb) / test.count) * 1000;
console.log(`inference: ${(inferMs * 1000).toFixed(0)} µs per digit (batch 1), ${batchedUs.toFixed(0)} µs per digit (batch 1000)`);

// ------------------------------------------------------------------ write model + metrics
const pct = (x) => +(100 * x).toFixed(2);
const summary = {
  testAccuracy: pct(fp.accuracy),
  testAccuracyInt8: pct(q.result.accuracy),
  testAccuracyF16: pct(exported.f16.result.accuracy),
  params,
  architecture: `784-${cfg.hidden.join('-')}-10`,
  modelBytesInt8: q.bin.length,
  modelBytesF32: exported.f32.bin.length,
  inferenceMs: +inferMs.toFixed(4),
};
const meta = { ...summary, bin: 'model.bin', trainedAt: new Date().toISOString() };
const writeModel = (name, e, m) => {
  e.manifest.meta = { ...e.manifest.meta, ...m, bin: `${name}.bin` };
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(e.manifest, null, 1) + '\n');
  writeFileSync(new URL(`${name}.bin`, OUT), e.bin);
};
writeModel('model', q, meta);
writeModel('model-f32', exported.f32, meta);

const perClass = perClassAccuracy(fp.confusion).map(pct);
const metrics = {
  config: { ...cfg, inputNorm: { mean, std }, optimizer: 'AdamW', schedule: 'cosine with linear warm-up', warmupSteps: warmup, stepsPerEpoch },
  ...summary,
  testLoss: +fp.loss.toFixed(5),
  bestEpoch: best.epoch,
  bestValAccuracy: pct(best.valAcc),
  trainMinutes: +(trainSeconds / 60).toFixed(2),
  secondsPerEpoch: +(trainSeconds / cfg.epochs).toFixed(1),
  inferenceUsBatched: +batchedUs.toFixed(1),
  quantization: {
    f32: { bytes: exported.f32.bin.length, testAccuracy: pct(exported.f32.result.accuracy) },
    f16: { bytes: exported.f16.bin.length, testAccuracy: pct(exported.f16.result.accuracy) },
    int8: { bytes: q.bin.length, testAccuracy: pct(q.result.accuracy) },
    int8DropPoints: +(100 * (fp.accuracy - q.result.accuracy)).toFixed(3),
  },
  perClassAccuracy: perClass,
  weakestClasses: perClass.map((a, c) => ({ digit: c, accuracy: a })).sort((a, b) => a.accuracy - b.accuracy).slice(0, 3),
  topConfusions: topConfusions(fp.confusion, 8),
  confusion: fp.confusion,
  confusionInt8: q.result.confusion,
  curves,
  node: process.version,
};
writeFileSync(new URL('metrics.json', OUT), JSON.stringify(metrics, null, 1) + '\n');

// ------------------------------------------------------------------ demo samples
// 50 real test digits: 4 correctly classified per class, plus 10 the shipped
// model gets wrong, placed at every 5th slot so "Try a test image" shows both.
const sRng = new Rng(cfg.seed + 7);
const preds = q.result.preds;
const right = Array.from({ length: K }, () => []);
const wrong = [];
for (let i = 0; i < test.count; i++) (preds[i] === test.labels[i] ? right[test.labels[i]] : wrong).push(i);
right.forEach((list) => sRng.shuffle(list));
sRng.shuffle(wrong);
const picksRight = [];
for (let r = 0; r < 4; r++) for (let c = 0; c < K; c++) picksRight.push(right[(c + r) % K][r]);
const picksWrong = wrong.slice(0, 10);
const samples = [];
for (let i = 0, a = 0, b = 0; i < 50; i++) samples.push(i % 5 === 4 ? picksWrong[b++] : picksRight[a++]);
const sImages = new Uint8Array(samples.length * D);
const sLabels = new Uint8Array(samples.length);
samples.forEach((ti, i) => { sImages.set(test.images.subarray(ti * D, ti * D + D), i * D); sLabels[i] = test.labels[ti]; });
writeFileSync(new URL('samples-images.idx', OUT), encodeIDXUint8([samples.length, 28, 28], sImages));
writeFileSync(new URL('samples-labels.idx', OUT), encodeIDXUint8([samples.length], sLabels));
writeFileSync(new URL('samples.json', OUT), JSON.stringify(samples.map((ti, i) => ({
  slot: i, testIndex: ti, label: sLabels[i], pred: preds[ti],
}))) + '\n');

console.log(`\nwrote ${new URL('.', OUT).pathname}: model.bin ${q.bin.length} B, metrics.json, 50 demo samples`);
console.log(`weakest digits: ${metrics.weakestClasses.map((w) => `${w.digit} (${w.accuracy}%)`).join(', ')}`);
