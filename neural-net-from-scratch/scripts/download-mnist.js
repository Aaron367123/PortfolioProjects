// download-mnist.js — fetch the four gzipped MNIST IDX files into data/ and
// verify them (size, IDX magic, element counts 60 000 / 10 000).
//
//   node scripts/download-mnist.js
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { DATA_DIR, FILES, loadMnist } from '../node/mnist.js';

const MIRRORS = [
  'https://storage.googleapis.com/cvdf-datasets/mnist/',
  'https://ossci-datasets.s3.amazonaws.com/mnist/',
];
const SIZES = { // bytes of the canonical .gz files
  'train-images-idx3-ubyte.gz': 9912422,
  'train-labels-idx1-ubyte.gz': 28881,
  't10k-images-idx3-ubyte.gz': 1648877,
  't10k-labels-idx1-ubyte.gz': 4542,
};

mkdirSync(DATA_DIR, { recursive: true });
for (const file of Object.values(FILES)) {
  const path = DATA_DIR + file;
  if (existsSync(path) && statSync(path).size === SIZES[file]) { console.log(`ok   ${file} (cached)`); continue; }
  let done = false;
  for (const base of MIRRORS) {
    try {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== SIZES[file]) throw new Error(`size ${buf.length}, expected ${SIZES[file]}`);
      writeFileSync(path, buf);
      console.log(`got  ${file} from ${base} (${buf.length} B)`);
      done = true;
      break;
    } catch (e) {
      console.warn(`fail ${base}${file}: ${e.message}`);
    }
  }
  if (!done) throw new Error(`could not download ${file}`);
}
const { train, test } = loadMnist(); // parses + checks magic and dimensions
console.log(`verified: ${train.count} training and ${test.count} test images`);
