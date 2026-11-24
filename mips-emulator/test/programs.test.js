// End-to-end tests: assemble and run the example programs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, example, R } from './helpers.js';

/** Read n little-endian words starting at address. */
function words(cpu, address, n) {
  return Array.from({ length: n }, (_, i) => cpu.memory.readWord(address + i * 4));
}

test('swap.asm (the original course program) swaps testdata1 and testdata2', () => {
  const testdata1 = [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x08, 0x09];
  const testdata2 = [0xaaaa, 0x5555, 0xcccc, 0xdddd, 0xfefe, 0xefef, 0x9898, 0x8989];

  const cpu = run(example('swap.asm'));

  assert.deepEqual(words(cpu, 0x2004, 8), testdata2); // testdata1 now holds the old testdata2
  assert.deepEqual(words(cpu, 0x2024, 8), testdata1); // and the other way round
  assert.equal(cpu.memory.readByte(0x2000), 32);      // counter untouched

  // Final register values
  assert.equal(cpu.regs[R.s0], 32);                   // loop counter reached 32
  assert.equal(cpu.regs[R.a1], 32);                   // value loaded by lb
  assert.equal(cpu.regs[R.t1], 0x2024);               // pointer walked past testdata1
  assert.equal(cpu.regs[R.t2], 0x2044);
  assert.equal(cpu.regs[R.t3], 0x2000);
  assert.equal(cpu.regs[R.t4], 0x09);                 // last pair swapped
  assert.equal(cpu.regs[R.t5], 0x8989);

  // 5 setup instructions + 8 loop iterations * 9 + final bge + syscall
  assert.equal(cpu.steps, 5 + 8 * 9 + 2);
  assert.equal(cpu.pc, 0x3c);
  assert.match(cpu.haltReason, /\$v0 = 0/);
});

test('sum.asm prints the sum of the array', () => {
  const cpu = run(example('sum.asm'));
  assert.equal(cpu.output, 'Sum = 200');
  assert.equal(cpu.regs[R.s0], 200);
});

test('factorial.asm computes 6! recursively and restores the stack', () => {
  const cpu = run(example('factorial.asm'));
  assert.equal(cpu.output, '6! = 720');
  assert.equal(cpu.regs[R.sp], 0x000ffffc); // every push was popped again
});

test('strlen.asm upper-cases the string in memory and prints its length', () => {
  const cpu = run(example('strlen.asm'));
  assert.equal(cpu.output, 'HELLO, MIPS!\nlength = 12');
  assert.equal(cpu.regs[R.t1], 12);
});
