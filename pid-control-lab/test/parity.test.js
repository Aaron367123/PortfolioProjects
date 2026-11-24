/**
 * Consistency checks across the repo:
 *  - the C golden files are up to date with the JS controller (regenerate with
 *    `node scripts/gen-golden.mjs`), so the C test really compares against current JS;
 *  - the live demo's engine/ folder is a byte-identical copy of src/ (when the demo
 *    checkout exists next to this project, as in the portfolio repo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, scenarioCSV } from '../scripts/golden.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('golden CSVs for the C parity test match the current JS implementation', () => {
  for (const sc of SCENARIOS) {
    const onDisk = readFileSync(`${root}firmware/tests/golden/${sc.name}.csv`, 'utf8');
    assert.equal(onDisk, scenarioCSV(sc), `${sc.name}.csv is stale - run node scripts/gen-golden.mjs`);
  }
});

const demoEngine = fileURLToPath(new URL('../../../demos/pid-lab/engine/', import.meta.url));

test('demos/pid-lab/engine is a byte-identical copy of src/', { skip: !existsSync(demoEngine) && 'demo folder not present' }, () => {
  const src = readdirSync(`${root}src`).filter((f) => f.endsWith('.js')).sort();
  const demo = readdirSync(demoEngine).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(demo, src, 'same file list');
  for (const f of src) {
    assert.ok(readFileSync(`${root}src/${f}`).equals(readFileSync(demoEngine + f)), `${f} differs - run npm run sync-demo`);
  }
});
