/**
 * Regenerate firmware/tests/golden/*.csv from the JS reference controller.
 *   node scripts/gen-golden.mjs
 * test/golden.test.js fails if the committed files are out of date.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, scenarioCSV } from './golden.js';

const dir = fileURLToPath(new URL('../firmware/tests/golden/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const sc of SCENARIOS) {
  const csv = scenarioCSV(sc);
  writeFileSync(dir + sc.name + '.csv', csv);
  console.log(`wrote ${sc.name}.csv (${csv.split('\n').length - 5} samples)`);
}
