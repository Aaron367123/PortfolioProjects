/** Copy src/ -> demos/logic-sim/engine/ and examples/ -> demos/logic-sim/examples/ (byte for byte). */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = join(root, '..', '..', 'demos', 'logic-sim');

for (const [from, to] of [['src', 'engine'], ['examples', 'examples']]) {
  const dst = join(demo, to);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(join(root, from))) copyFileSync(join(root, from, f), join(dst, f));
  console.log(`${from}/ -> ${dst}`);
}
