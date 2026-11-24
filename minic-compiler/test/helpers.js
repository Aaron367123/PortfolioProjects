// helpers.js - shared test utilities.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '../src/index.js';
import { runAsm } from '../run.js';

/** Compile and assert there are no errors. */
export function compileOk(source, options = {}) {
  const result = compile(source, options);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.equal(errors.length, 0, `unexpected errors:\n${errors.map((d) => d.text).join('\n')}`);
  return result;
}

/** Compile, assemble and run on the real emulator. Returns { output, steps, words, ... }. */
export function runProgram(source, options = {}) {
  const result = compileOk(source, options);
  const run = runAsm(result.asm);
  assert.equal(run.error, null, `run-time error: ${run.error}\n${result.asm}`);
  return { ...run, result };
}

/** Run at both -O0 and -O1 and check that both print `expected`. */
export function expectOutput(source, expected) {
  for (const optimize of [false, true]) {
    const { output } = runProgram(source, { optimize });
    assert.equal(output, expected, `wrong output at -O${optimize ? 1 : 0}`);
  }
}

/** Wrap statements in int main() { ... }. */
export function mainWith(body, globals = '') {
  return `${globals}\nint main() {\n${body}\nreturn 0;\n}\n`;
}

/** Compile and return the error diagnostics. */
export function errorsOf(source) {
  return compile(source).diagnostics.filter((d) => d.severity === 'error');
}

export function warningsOf(source) {
  return compile(source).diagnostics.filter((d) => d.severity === 'warning');
}

export function example(name) {
  return readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
}
