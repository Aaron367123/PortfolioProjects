/**
 * The live demo (portfolio repo: demos/logic-sim/) ships copies of src/ and
 * examples/. They must be byte-identical; run `npm run sync-demo` after
 * changing either. Skipped when this folder is checked out on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.js';

const DEMO = join(ROOT, '..', '..', 'demos', 'logic-sim');
const PAIRS = [['src', 'engine'], ['examples', 'examples']];

test('demo engine/ and examples/ are byte-identical copies of src/ and examples/', { skip: !existsSync(DEMO) && 'demo folder not present' }, () => {
  for (const [from, to] of PAIRS) {
    const src = readdirSync(join(ROOT, from)).sort();
    const dst = readdirSync(join(DEMO, to)).sort();
    assert.deepEqual(dst, src, `${to}/ has the same files as ${from}/`);
    for (const f of src) {
      assert.ok(readFileSync(join(ROOT, from, f)).equals(readFileSync(join(DEMO, to, f))), `${to}/${f} differs from ${from}/${f}`);
    }
  }
});
