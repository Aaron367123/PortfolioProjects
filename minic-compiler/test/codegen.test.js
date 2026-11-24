// End-to-end tests of language features: compile, assemble and run on the
// real emulator engine at -O0 and -O1, and compare the printed output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectOutput, mainWith, runProgram, compileOk } from './helpers.js';

test('arithmetic wraps around at 32 bits instead of trapping', () => {
  expectOutput(mainWith(`
    int big = 2147483647;
    print_int(big + 1); print_char(' ');
    int m = -2147483648;
    print_int(m - 1); print_char(' ');
    print_int(m / -1); print_char(' ');
    print_int(65536 * 65536 + big * 3);`), '-2147483648 2147483647 -2147483648 2147483645');
});

test('division truncates toward zero; % takes the sign of the dividend', () => {
  expectOutput(mainWith(`
    int a = -7; int b = 2;
    print_int(a / b); print_char(' '); print_int(a % b); print_char(' ');
    print_int(7 / -2); print_char(' '); print_int(7 % -2);`), '-3 -1 -3 1');
});

test('comparisons and logical operators produce 0 or 1', () => {
  expectOutput(mainWith(`
    int a = 3; int b = 5;
    print_int(a < b); print_int(a > b); print_int(a <= 3); print_int(b >= 6);
    print_int(a == 3); print_int(a != 3); print_int(!a); print_int(!!a);
    print_int(a && b); print_int(a && 0); print_int(0 || b); print_int(0 || 0);`), '101010011010');
});

test('bitwise operators and shifts', () => {
  expectOutput(mainWith(`
    int x = 0x0F0F;
    print_int(x & 0xFF); print_char(' ');
    print_int(x | 0xF000); print_char(' ');
    print_int(x ^ 0xFFFF); print_char(' ');
    print_int(~x); print_char(' ');
    print_int(1 << 31); print_char(' ');
    print_int(-64 >> 3); print_char(' ');
    int s = 35; print_int(1 << s);`), '15 65295 61680 -3856 -2147483648 -8 8');
});

test('&& and || short-circuit (the right side is not evaluated)', () => {
  expectOutput(`
    int count;
    int bump(int r) { count++; return r; }
    int main() {
      int a = 0;
      if (a && bump(1)) print("no");
      if (a || bump(0)) print("no");
      if (1 || bump(1)) print("A");
      int v = bump(1) && bump(0) || bump(1);
      print_int(v); print_int(count);
      return 0;
    }`, 'A14');
});

test('if / else chains, while, for, break and continue', () => {
  expectOutput(mainWith(`
    for (int i = 0; i < 10; i++) {
      if (i == 2) continue;
      if (i == 6) break;
      print_int(i);
    }
    int n = 0;
    while (1) { n += 3; if (n > 10) break; }
    print_char(' '); print_int(n);
    int k = 5;
    while (k) { k--; if (k % 2) continue; print_int(k); }
    for (;;) { break; }
    if (n > 100) print("big"); else if (n > 10) print(" medium"); else print(" small");`), '01345 12420 medium');
});

test('nested loops: break and continue apply to the innermost loop', () => {
  expectOutput(mainWith(`
    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < 3; j++) {
        if (j == 1) continue;
        if (j == 2) break;
        print_int(i * 10 + j); print_char(',');
      }
    }`), '0,10,20,');
});

test('compound assignment and ++ / -- on locals, globals and array elements', () => {
  expectOutput(`
    int g = 10;
    int a[3] = {1, 2, 3};
    int main() {
      int x = 7;
      x += 3; x -= 1; x *= 4; x /= 3; x %= 7; print_int(x); print_char(' ');
      x = 6; x <<= 2; x >>= 1; x |= 1; x &= 13; x ^= 3; print_int(x); print_char(' ');
      g++; g++; --g; g *= 2; print_int(g); print_char(' ');
      int i = 1;
      a[i] += 40; a[i + 1]--; a[0] <<= 4; ++a[0];
      print_int(a[0]); print_char(','); print_int(a[1]); print_char(','); print_int(a[2]);
      return 0;
    }`, '5 14 22 17,42,2');
});

test('block scoping and shadowing', () => {
  expectOutput(`
    int x = 1;
    int main() {
      print_int(x);
      int x = 2;
      print_int(x);
      { int x = 3; print_int(x); { x = 4; print_int(x); } }
      print_int(x);
      for (int x = 7; x < 8; x++) print_int(x);
      print_int(x);
      return 0;
    }`, '1234272');
});

test('uninitialised locals are 0, globals use their initialisers', () => {
  expectOutput(`
    int g = -5, h, arr[4] = {9};
    int main() { int a; int b = 1, c; print_int(a + c); print_int(g); print_int(h); print_int(arr[0] + arr[3]); return 0; }`,
  '0-509');
});

test('functions: four parameters, argument order and recursion', () => {
  expectOutput(`
    int f4(int a, int b, int c, int d) { return a * 1000 + b * 100 + c * 10 + d; }
    int ack(int m, int n) {
      if (m == 0) return n + 1;
      if (n == 0) return ack(m - 1, 1);
      return ack(m - 1, ack(m, n - 1));
    }
    int even(int n) { if (n == 0) return 1; return odd(n - 1); }
    int odd(int n) { if (n == 0) return 0; return even(n - 1); }
    int main() {
      print_int(f4(1, 2, 3, 4)); print_char(' ');
      print_int(ack(2, 3)); print_char(' ');
      print_int(even(10)); print_int(odd(7));
      return 0;
    }`, '1234 9 11');
});

test('falling off the end of a function returns 0', () => {
  expectOutput(`
    int nothing(int x) { if (x) return 5; }
    int main() { print_int(nothing(1)); print_int(nothing(0)); }`, '50');
});

test('calls inside expressions keep the caller\'s temporaries (caller-saved)', () => {
  expectOutput(`
    int sq(int x) { return x * x; }
    int add3(int a, int b, int c) { return a + b + c; }
    int main() {
      int a = 2;
      print_int(a + sq(a + 1) * sq(sq(2)) - add3(sq(1), sq(2), sq(3)));
      print_char(' ');
      print_int((a + 1) * (a + 2) * add3(a, a * 2, (a > 1) && (sq(a) == 4)));
      return 0;
    }`, '132 84');
});

test('deep expressions spill registers to the stack and reload them', () => {
  // 12 nested right operands need more than the 8 temporaries $t0-$t7.
  let expr = 'x';
  for (let i = 1; i <= 12; i++) expr = `(x + ${i} * (${expr}))`;
  const reference = (x) => {
    let v = x;
    for (let i = 1; i <= 12; i++) v = (x + Math.imul(i, v)) | 0;
    return v;
  };
  const source = mainWith(`int x = 3; print_int(${expr});`);
  for (const optimize of [false, true]) {
    const run = runProgram(source, { optimize });
    assert.equal(run.output, String(reference(3)));
    assert.ok(run.result.stats.spills > 0, 'expected spills');
    assert.equal(run.cpu.regs[29], 0xffffc, 'stack pointer restored');
  }
});

test('the stack is balanced after many calls', () => {
  const run = runProgram(`
    int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
    int main() { print_int(fib(15)); return 0; }`);
  assert.equal(run.output, '610');
  assert.equal(run.cpu.regs[29], 0xffffc);
});

test('strings: escapes and shared labels for identical literals', () => {
  const source = mainWith('print("a\\tb\\n"); print("say \\"hi\\"\\\\"); print("a\\tb\\n");');
  expectOutput(source, 'a\tb\nsay "hi"\\a\tb\n');
  const asm = compileOk(source).asm;
  assert.equal(asm.match(/\.asciiz/g).length, 2);
});

test('large constants need lui + ori and still work', () => {
  expectOutput(mainWith('int x = 123456789; print_int(x + 0x7FFF0000); print_char(\' \'); print_int(-100000);'),
    `${(123456789 + 0x7fff0000) | 0} -100000`);
});

test('the generated assembly has source-line comments and a line map', () => {
  const result = compileOk('int main() {\n  int x = 41;\n  print_int(x + 1);\n  return 0;\n}');
  assert.match(result.asm, /# line 2: int x = 41;/);
  assert.match(result.asm, /# line 3: print_int\(x \+ 1\);/);
  const asmLines = result.asm.split('\n');
  const forLine3 = asmLines.filter((_, i) => result.lineMap[i] === 3);
  assert.ok(forLine3.some((l) => /syscall/.test(l)));
});

test('-O1 executes fewer instructions than -O0 on the same program', () => {
  const source = `
    int sum(int n) { int s = 0; for (int i = 0; i < n; i++) s += i * 2 + 1; return s; }
    int main() { print_int(sum(100)); return 0; }`;
  const o0 = runProgram(source, { optimize: false });
  const o1 = runProgram(source, { optimize: true });
  assert.equal(o0.output, '10000');
  assert.equal(o1.output, '10000');
  assert.ok(o1.steps < o0.steps, `${o1.steps} < ${o0.steps}`);
});

test('only instructions supported by the emulator are generated', () => {
  const supported = new Set(('add addu sub subu and or xor nor slt sltu sll srl sra sllv srlv srav mult multu div divu '
    + 'mfhi mflo mul jr j jal addi addiu slti sltiu andi ori xori lui lw sw lb lbu sb beq bne bge blt bgt ble la syscall '
    + 'li move b beqz bnez nop').split(' '));
  const source = `
    int a[4];
    int f(int x, int y) { return x % y + (x << y) - (x >> 1) ^ ~y | !x & (x != y); }
    int main() { a[1] = f(7, 3); if (a[1] >= 2 && a[1] <= 99 || a[0] > 1) print_int(a[1]); return 0; }`;
  for (const optimize of [false, true]) {
    for (const line of compileOk(source, { optimize }).asm.split('\n')) {
      const m = /^\s+([a-z]+)\b/.exec(line);
      if (m && !line.trim().startsWith('#') && !line.trim().startsWith('.')) {
        assert.ok(supported.has(m[1]), `unsupported instruction ${m[1]}`);
      }
    }
  }
});
