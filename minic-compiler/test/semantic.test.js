import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/index.js';
import { errorsOf, warningsOf, mainWith } from './helpers.js';

/** Expect exactly one error matching `pattern`, at line:col if given. */
function expectError(source, pattern, line, col) {
  const errors = errorsOf(source);
  assert.equal(errors.length, 1, `expected one error, got:\n${errors.map((e) => e.text).join('\n')}`);
  assert.match(errors[0].message, pattern);
  if (line !== undefined) assert.deepEqual([errors[0].line, errors[0].col], [line, col]);
  return errors[0];
}

test('unknown identifiers and functions', () => {
  expectError('int main() {\n  int x = y + 1;\n  return x;\n}', /unknown identifier 'y'/, 2, 11);
  expectError(mainWith('foo(1);'), /unknown function 'foo'/);
  expectError(mainWith('z = 3;'), /unknown identifier 'z'/);
});

test('the formatted diagnostic has the source line and a caret', () => {
  const [error] = compile('int main() {\n  int x = y + 1;\n  return x;\n}').diagnostics;
  assert.equal(error.text, [
    "error 2:11: unknown identifier 'y'",
    '  2 |   int x = y + 1;',
    '    |           ^',
  ].join('\n'));
});

test('redeclarations', () => {
  expectError(mainWith('int a = 1;\nint a = 2;'), /redeclaration of 'a' in the same scope \(first declared at line 3\)/);
  expectError('int g;\nint g;\nint main() { return 0; }', /redeclaration of 'g'/);
  expectError('int f() { return 0; }\nint f() { return 1; }\nint main() { return 0; }', /redeclaration of 'f'/);
  expectError('int f(int a, int a) { return a; }\nint main() { return 0; }', /redeclaration of 'a'/);
  expectError('int f(int a) { int a = 1; return a; }\nint main() { return 0; }', /redeclaration of 'a'/);
  expectError('int print_int(int x) { return x; }\nint main() { return 0; }', /built-in function and cannot be redefined/);
});

test('shadowing in an inner block is allowed', () => {
  assert.deepEqual(errorsOf(mainWith('int a = 1;\n{ int a = 2; print_int(a); }\nprint_int(a);')), []);
  assert.deepEqual(errorsOf(mainWith('for (int i = 0; i < 2; i++) {}\nfor (int i = 0; i < 2; i++) {}')), []);
});

test('variables are not visible outside their block', () => {
  expectError(mainWith('{ int inner = 1; }\nprint_int(inner);'), /unknown identifier 'inner'/);
  expectError(mainWith('for (int i = 0; i < 3; i++) {}\nprint_int(i);'), /unknown identifier 'i'/);
});

test('wrong argument counts', () => {
  expectError('int add(int a, int b) { return a + b; }\nint main() { return add(1); }', /function 'add' expects 2 arguments but got 1/);
  expectError('int one() { return 1; }\nint main() { return one(5); }', /expects 0 arguments but got 1/);
  expectError(mainWith('print_int(1, 2);'), /print_int expects 1 argument but got 2/);
});

test('too many parameters', () => {
  expectError('int f(int a, int b, int c, int d, int e) { return a; }\nint main() { return 0; }',
    /has 5 parameters; Mini-C allows at most 4/, 1, 39);
});

test('break and continue outside a loop', () => {
  expectError(mainWith('break;'), /'break' outside of a loop/);
  expectError(mainWith('if (1) { continue; }'), /'continue' outside of a loop/);
  assert.deepEqual(errorsOf(mainWith('while (1) { if (1) break; continue; }')), []);
});

test('main is required and takes no parameters', () => {
  expectError('int f() { return 0; }', /no 'main' function/);
  expectError('int main(int argc) { return 0; }', /'main' must not take parameters/);
});

test('misusing names', () => {
  expectError('int f() { return 1; }\nint main() { return f + 1; }', /'f' is a function; call it with f\(\.\.\.\)/);
  expectError(mainWith('int x = 1; x(2);'), /'x' is not a function/);
  expectError('int a[3];\nint main() { return a; }', /'a' is an array; use an element/);
  expectError(mainWith('int x = 1; x[0] = 2;'), /'x' is not an array/);
  expectError('int a[3];\nint main() { a = 1; return 0; }', /cannot assign to the array 'a' itself/);
  expectError('int f() { return 1; }\nint main() { f = 1; return 0; }', /cannot assign to 'f': it is a function/);
});

test('builtins', () => {
  expectError(mainWith('int x = print_int(3);'), /print_int\(\.\.\.\) does not return a value/);
  expectError(mainWith('print(42);'), /print expects a string literal/);
  expectError(mainWith('print_int("hi");'), /print_int expects an int/);
  expectError(mainWith('int x = "hi";'), /string literals can only be used as the argument of print/);
});

test('global initialisers and array sizes must be constants', () => {
  expectError('int a = 1;\nint b = a + 1;\nint main() { return 0; }', /initialiser of global 'b' must be a constant expression/);
  expectError('int n = 3;\nint arr[n];\nint main() { return 0; }', /size of array 'arr' must be a constant/);
  expectError('int arr[0];\nint main() { return 0; }', /must be positive/);
  expectError('int arr[2] = {1, 2, 3};\nint main() { return 0; }', /too many initialisers/);
  assert.deepEqual(errorsOf('int arr[2 * 8 + 1] = {1, -2, 3 << 2};\nint g = -(5 * 5);\nint main() { return 0; }'), []);
});

test('constant array indexes are bounds-checked', () => {
  expectError('int a[10];\nint main() { return a[10]; }', /index 10 is out of bounds for 'a' \(size 10, valid 0\.\.9\)/);
  expectError('int a[10];\nint main() { a[-1] = 0; return 0; }', /index -1 is out of bounds/);
});

test('too much global data for la', () => {
  expectError('int big[20000];\nint main() { return 0; }', /can only reach/);
});

test('several semantic errors are reported at once', () => {
  const errors = errorsOf('int main() {\n  a = 1;\n  b = 2;\n  break;\n}');
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4]);
});

test('warnings: unreachable code, division by zero, unused results', () => {
  const warnings = warningsOf('int main() {\n  return 1;\n  print_int(2);\n}');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /unreachable code/);
  assert.equal(warnings[0].line, 3);

  assert.match(warningsOf(mainWith('int x = 5 / 0;'))[0].message, /division by zero/);
  assert.match(warningsOf(mainWith('int x = 1; x %= 0;'))[0].message, /division by zero/);
  assert.match(warningsOf(mainWith('int x = 1; x + 1;'))[0].message, /expression result is unused/);
  // Warnings do not stop compilation.
  assert.equal(compile(mainWith('int x = 1; x + 1;')).ok, true);
});
