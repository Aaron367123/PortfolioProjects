// Checks the trained artefacts in model/ against the real MNIST test set.
// Skipped (with a message) when the model or the dataset is not present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModel } from '../src/serialize.js';
import { parseIDX } from '../src/idx.js';
import { loadMnist, mnistAvailable } from '../node/mnist.js';

const dir = fileURLToPath(new URL('../model/', import.meta.url));
const have = existsSync(dir + 'model.json') && existsSync(dir + 'metrics.json');
const skip = !have ? 'model/ not found — run `npm run train` first'
  : !mnistAvailable() ? 'MNIST not in data/ — run `npm run download` first' : false;

const load = (name) => loadModel(JSON.parse(readFileSync(dir + `${name}.json`, 'utf8')), readFileSync(dir + `${name}.bin`));

test('shipped int8 and fp32 models reach the recorded test accuracy (−0.1 % tolerance)', { skip }, () => {
  const metrics = JSON.parse(readFileSync(dir + 'metrics.json', 'utf8'));
  const { test: t } = loadMnist();
  const fp = load('model-f32').evaluate(t.images, t.labels, t.count);
  const q = load('model').evaluate(t.images, t.labels, t.count);
  assert.ok(100 * fp.accuracy >= metrics.testAccuracy - 0.1, `fp32 ${100 * fp.accuracy} vs recorded ${metrics.testAccuracy}`);
  assert.ok(100 * q.accuracy >= metrics.testAccuracyInt8 - 0.1, `int8 ${100 * q.accuracy} vs recorded ${metrics.testAccuracyInt8}`);
  assert.ok(100 * (fp.accuracy - q.accuracy) < 0.3, 'quantisation costs < 0.3 points');
  assert.ok(metrics.testAccuracy >= 98, `target ≥ 98 % (got ${metrics.testAccuracy})`);
});

test('model manifest and demo samples are consistent', { skip: have ? false : 'model/ not found' }, () => {
  const manifest = JSON.parse(readFileSync(dir + 'model.json', 'utf8'));
  assert.equal(manifest.weights, 'int8');
  assert.equal(readFileSync(dir + 'model.bin').length, manifest.bytes);
  assert.ok(manifest.bytes < 300 * 1024, 'browser download under 300 KB');
  const imgs = parseIDX(readFileSync(dir + 'samples-images.idx'));
  const labels = parseIDX(readFileSync(dir + 'samples-labels.idx'));
  const list = JSON.parse(readFileSync(dir + 'samples.json', 'utf8'));
  assert.deepEqual(imgs.dims, [50, 28, 28]);
  assert.equal(labels.dims[0], 50);
  // the samples' recorded predictions are what the shipped model actually says
  const net = load('model');
  const x = new Float32Array(784);
  list.forEach((s, i) => {
    for (let p = 0; p < 784; p++) x[p] = imgs.data[i * 784 + p] / 255;
    const probs = net.predict(x, 1);
    assert.equal(probs.indexOf(Math.max(...probs)), s.pred);
    assert.equal(labels.data[i], s.label);
  });
  assert.equal(list.filter((s) => s.pred !== s.label).length, 10);
});
