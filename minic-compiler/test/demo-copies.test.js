// The live web demo uses copies of the compiler and the emulator engine.
// They must stay byte-identical to the sources, so the demo runs exactly the
// code that these tests check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const here = new URL('..', import.meta.url);                       // code/minic-compiler/
const COMPILER_SRC = new URL('src/', here);
const EMULATOR_SRC = new URL('../mips-emulator/src/', here);
const DEMO = new URL('../../demos/minic-compiler/', here);

function compareFolders(source, copy, ext = '.js') {
  const files = readdirSync(source).filter((f) => f.endsWith(ext)).sort();
  assert.ok(files.length > 0);
  const copied = readdirSync(copy).filter((f) => f.endsWith(ext)).sort();
  assert.deepEqual(copied, files, `${copy.pathname} should contain exactly the files of ${source.pathname}`);
  for (const file of files) {
    const a = readFileSync(new URL(file, source));
    const b = readFileSync(new URL(file, copy));
    assert.ok(a.equals(b), `${file} differs from its copy in the demo`);
  }
}

const demoExists = existsSync(DEMO);

test('demo compiler/ is a byte-identical copy of src/', { skip: !demoExists && 'demo folder not present' }, () => {
  compareFolders(COMPILER_SRC, new URL('compiler/', DEMO));
});

test('demo engine/ is a byte-identical copy of the emulator src/', { skip: !demoExists && 'demo folder not present' }, () => {
  compareFolders(EMULATOR_SRC, new URL('engine/', DEMO));
});

test('demo examples are the same as examples/', { skip: !demoExists && 'demo folder not present' }, () => {
  compareFolders(new URL('examples/', here), new URL('examples/', DEMO), '.mc');
});
