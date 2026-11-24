// node/mnist.js — Node-only loader for the four gzipped MNIST IDX files in
// data/ (download them with `npm run download`). Kept out of src/ because it
// needs node:fs and node:zlib; src/ must also run in the browser.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseIDX } from '../src/idx.js';

export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

export const FILES = {
  trainImages: 'train-images-idx3-ubyte.gz',
  trainLabels: 'train-labels-idx1-ubyte.gz',
  testImages: 't10k-images-idx3-ubyte.gz',
  testLabels: 't10k-labels-idx1-ubyte.gz',
};

export function mnistAvailable(dir = DATA_DIR) {
  return Object.values(FILES).every((f) => existsSync(dir + f));
}

function load(dir, file, expectDims) {
  const idx = parseIDX(gunzipSync(readFileSync(dir + file)));
  if (idx.type !== 'uint8' || idx.dims.join() !== expectDims.join()) {
    throw new Error(`${file}: expected uint8 [${expectDims}], got ${idx.type} [${idx.dims}]`);
  }
  return idx.data;
}

/**
 * @returns {{train: {images: Uint8Array, labels: Uint8Array, count: number},
 *            test:  {images: Uint8Array, labels: Uint8Array, count: number}}}
 * images are n×784 uint8 (0 = background, 255 = full ink), labels 0-9.
 */
export function loadMnist(dir = DATA_DIR) {
  return {
    train: {
      images: load(dir, FILES.trainImages, [60000, 28, 28]),
      labels: load(dir, FILES.trainLabels, [60000]),
      count: 60000,
    },
    test: {
      images: load(dir, FILES.testImages, [10000, 28, 28]),
      labels: load(dir, FILES.testLabels, [10000]),
      count: 10000,
    },
  };
}
