// run.js - assemble and execute generated assembly on the MIPS emulator.
//
// This is the only place (besides the tests) that imports the emulator, so the
// compiler in src/ stays independent of it and also runs in the browser.

import { assemble } from '../mips-emulator/src/assembler.js';
import { CPU } from '../mips-emulator/src/cpu.js';
import { MipsError } from '../mips-emulator/src/errors.js';

/**
 * @param {string} asm
 * @param {number} [maxSteps]
 * @returns {{ output: string, steps: number, words: number, haltReason: string, error: string|null, cpu: CPU }}
 */
export function runAsm(asm, maxSteps = 20_000_000) {
  const program = assemble(asm); // throws MipsError if the compiler produced bad assembly
  const cpu = new CPU();
  cpu.load(program);
  let error = null;
  try {
    cpu.run(maxSteps);
  } catch (err) {
    if (!(err instanceof MipsError)) throw err;
    error = err.describe();
  }
  return { output: cpu.output, steps: cpu.steps, words: program.text.length, haltReason: cpu.haltReason, error, cpu };
}
