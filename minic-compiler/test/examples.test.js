// Every example program, compiled at -O0 and -O1 and run on the real emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { runProgram, example } from './helpers.js';

const EXPECTED = {
  'hello.mc': 'Hello, MIPS!\n',
  'fibonacci.mc': '0 1 1 2 3 5 8 13 21 34 55 \nfib_iter(40) = 102334155\n',
  'factorial.mc': [
    '0! = 1', '1! = 1', '2! = 2', '3! = 6', '4! = 24', '5! = 120', '6! = 720', '7! = 5040',
    '8! = 40320', '9! = 362880', '10! = 3628800', '11! = 39916800', '12! = 479001600',
    '13! wraps to 1932053504', '',
  ].join('\n'),
  'primes.mc': '2 3 5 7 11 13 17 19 23 29 31 37 41 43 47 53 59 61 67 71 73 79 83 89 97 \n25 primes up to 100\n',
  'bubblesort.mc': 'before: 64, 25, 12, 22, 11, 90, 3, 47, 75, 38\nafter:  3, 11, 12, 22, 25, 38, 47, 64, 75, 90\nswaps:  22\n',
  'gcd.mc': 'gcd(1071, 462) = 21\ngcd_loop(270, 192) = 6\nlcm(21, 6) = 42\n',
  'collatz.mc': 'steps(6) = 8\nlongest below 30: n = 27 (111 steps)\n',
  'fizzbuzz.mc': '1 2 Fizz 4 Buzz Fizz 7 8 Fizz Buzz 11 Fizz 13 14 FizzBuzz\nAFKPUZ\n',
  'hanoi.mc': [
    'disk 1: A -> C', 'disk 2: A -> B', 'disk 1: C -> B', 'disk 3: A -> C',
    'disk 1: B -> A', 'disk 2: B -> C', 'disk 1: A -> C',
    ...Array.from({ length: 10 }, (_, i) => `${i + 1} disks: ${2 ** (i + 1) - 1} moves`), '',
  ].join('\n'),
  'expressions.mc': '14 89 18 -3 -1 56\nshort-circuit: 0\n',
};

// Cross-check two expected values with plain JavaScript.
test('expected outputs agree with JavaScript', () => {
  const data = [64, 25, 12, 22, 11, 90, 3, 47, 75, 38];
  let inversions = 0;
  for (let i = 0; i < data.length; i++) for (let j = i + 1; j < data.length; j++) if (data[i] > data[j]) inversions++;
  assert.match(EXPECTED['bubblesort.mc'], new RegExp(`swaps:  ${inversions}\\n`));
  let f = 1;
  for (let n = 2; n <= 13; n++) f = Math.imul(f, n);
  assert.match(EXPECTED['factorial.mc'], new RegExp(`13! wraps to ${f}`));
});

test('every example has an expected output', () => {
  const files = readdirSync(new URL('../examples/', import.meta.url)).filter((f) => f.endsWith('.mc'));
  assert.deepEqual(files.sort(), Object.keys(EXPECTED).sort());
});

for (const [file, expected] of Object.entries(EXPECTED)) {
  test(`examples/${file} prints the right output at -O0 and -O1`, () => {
    const source = example(file);
    const o0 = runProgram(source, { optimize: false });
    const o1 = runProgram(source, { optimize: true });
    assert.equal(o0.output, expected, '-O0 output');
    assert.equal(o1.output, expected, '-O1 output');
    assert.ok(o1.steps <= o0.steps, `-O1 (${o1.steps}) should not execute more than -O0 (${o0.steps})`);
    assert.ok(o1.words <= o0.words, '-O1 code should not be bigger');
    assert.equal(o1.cpu.regs[29], 0xffffc, 'stack pointer is restored');
  });
}
