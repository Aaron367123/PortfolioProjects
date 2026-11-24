// sync-demo.js — copy src/ → <portfolio>/demos/digit-recognizer/engine/ and the
// shipped model files → …/model/. The demo-sync test checks the copies.
//
//   node scripts/sync-demo.js [demoDir]
import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEMO_DIR = fileURLToPath(new URL('../../../demos/digit-recognizer/', import.meta.url));
export const MODEL_FILES = ['model.json', 'model.bin', 'samples-images.idx', 'samples-labels.idx', 'samples.json'];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const demo = process.argv[2] ?? DEMO_DIR;
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const model = fileURLToPath(new URL('../model/', import.meta.url));
  rmSync(demo + 'engine', { recursive: true, force: true });
  mkdirSync(demo + 'engine', { recursive: true });
  mkdirSync(demo + 'model', { recursive: true });
  for (const f of readdirSync(src).filter((f) => f.endsWith('.js'))) copyFileSync(src + f, demo + 'engine/' + f);
  for (const f of MODEL_FILES) {
    if (existsSync(model + f)) copyFileSync(model + f, demo + 'model/' + f);
    else console.warn(`missing model/${f} (train first)`);
  }
  console.log(`synced engine/ and model/ into ${demo}`);
}
