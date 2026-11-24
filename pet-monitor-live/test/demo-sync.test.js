/**
 * The static demo must run exactly the logic the server runs: its shared/ copy has to be
 * byte-identical to ours. Skipped when the demo has not been built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../server/settings.js';

const demoDir = path.join(ROOT_DIR, '..', '..', 'demos', 'pet-monitor-live');
const built = fs.existsSync(path.join(demoDir, 'index.html'));

test('demo build contains identical shared modules and UI', { skip: !built && 'demo not built (npm run build:demo)' }, () => {
  for (const [srcDir, dstDir] of [['shared', 'shared'], ['public', '.']]) {
    const src = path.join(ROOT_DIR, srcDir);
    for (const rel of fs.readdirSync(src, { recursive: true })) {
      const file = path.join(src, rel);
      if (!fs.statSync(file).isFile() || rel.replaceAll('\\', '/') === 'js/mode.js') continue;
      const copy = path.join(demoDir, dstDir, rel);
      assert.ok(fs.existsSync(copy), `missing in demo: ${dstDir}/${rel} - run npm run build:demo`);
      assert.ok(fs.readFileSync(file).equals(fs.readFileSync(copy)), `${dstDir}/${rel} differs - run npm run build:demo`);
    }
  }
  assert.match(fs.readFileSync(path.join(demoDir, 'js', 'mode.js'), 'utf8'), /MODE = 'demo'/);
});
