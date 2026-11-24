// Shared helpers for the tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/assembler.js';
import { CPU } from '../src/cpu.js';

/** Assemble and load a program, without running it. */
export function load(source) {
  const program = assemble(source);
  const cpu = new CPU();
  cpu.load(program);
  return { cpu, program };
}

/** Assemble, load and run a program to completion. Returns the CPU. */
export function run(source, maxSteps = 100_000) {
  const { cpu } = load(source);
  cpu.run(maxSteps);
  return cpu;
}

/** Run a snippet of code (wrapped in .text, ending with exit) and return the CPU. */
export function runCode(code, data = '') {
  return run(`.data\n${data}\n.text\n${code}\nli $v0, 10\nsyscall\n`);
}

/** Read a file from examples/. */
export function example(name) {
  return readFileSync(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), 'utf8');
}

/** Register number by name, for readable assertions. */
export const R = {
  zero: 0, at: 1, v0: 2, v1: 3, a0: 4, a1: 5, a2: 6, a3: 7,
  t0: 8, t1: 9, t2: 10, t3: 11, t4: 12, t5: 13, t6: 14, t7: 15,
  s0: 16, s1: 17, s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23,
  t8: 24, t9: 25, k0: 26, k1: 27, gp: 28, sp: 29, fp: 30, ra: 31,
};
