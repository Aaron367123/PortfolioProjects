/**
 * Copy src/*.js byte-for-byte into the live demo's engine folder
 * (../../demos/pid-lab/engine when this project sits inside the portfolio repo).
 *   node scripts/sync-demo.mjs [targetDir]
 */
import { readdirSync, copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const dst = process.argv[2] ?? fileURLToPath(new URL('../../../demos/pid-lab/engine/', import.meta.url));
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(dst)) if (f.endsWith('.js') && !existsSync(src + f)) rmSync(dst + '/' + f);
for (const f of readdirSync(src)) if (f.endsWith('.js')) copyFileSync(src + f, dst + '/' + f);
console.log(`synced ${src} -> ${dst}`);
