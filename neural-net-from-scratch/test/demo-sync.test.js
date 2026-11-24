// The live demo (portfolio repo, demos/digit-recognizer/) runs a copy of
// src/ and of the shipped model. They must be byte-identical to the source
// here — re-sync with `npm run sync-demo`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_DIR, MODEL_FILES } from '../scripts/sync-demo.js';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const model = fileURLToPath(new URL('../model/', import.meta.url));
const skip = existsSync(DEMO_DIR) ? false : `demo folder not found at ${DEMO_DIR}`;

test('demo engine/ is a byte-identical copy of src/', { skip }, () => {
  const files = readdirSync(src).filter((f) => f.endsWith('.js')).sort();
  const copies = readdirSync(DEMO_DIR + 'engine/').filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(copies, files);
  for (const f of files) assert.ok(readFileSync(src + f).equals(readFileSync(DEMO_DIR + 'engine/' + f)), `engine/${f} differs`);
});

test('demo model/ matches the trained model', { skip: skip || (existsSync(model + 'model.json') ? false : 'no trained model') }, () => {
  for (const f of MODEL_FILES) {
    assert.ok(readFileSync(model + f).equals(readFileSync(DEMO_DIR + 'model/' + f)), `model/${f} differs`);
  }
});
