import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromJSON } from '../src/index.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load and validate examples/<name>.json. */
export function loadExample(name) {
  return fromJSON(readFileSync(join(ROOT, 'examples', `${name}.json`), 'utf8'));
}

export function exampleIndex() {
  return JSON.parse(readFileSync(join(ROOT, 'examples', 'index.json'), 'utf8'));
}

/** All 2^n bit vectors, MSB first. */
export function* combinations(n) {
  for (let r = 0; r < 2 ** n; r++) yield Array.from({ length: n }, (_, j) => (r >> (n - 1 - j)) & 1);
}

/** Step until `ref` goes 0 -> 1; returns the tick of the edge. */
export function runToRisingEdge(sim, ref, limit = 1000) {
  let prev = sim.read(ref);
  for (let i = 0; i < limit; i++) {
    sim.step();
    const v = sim.read(ref);
    if (prev === 0 && v === 1) return sim.time;
    prev = v;
  }
  throw new Error(`no rising edge on ${ref} within ${limit} ticks`);
}
