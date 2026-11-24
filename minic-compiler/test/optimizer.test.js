import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/index.js';
import { foldBinary, foldUnary } from '../src/optimizer.js';

/** Optimise `return <expr>;` in a function with locals x, y and return the expression back as text. */
function optimized(expr) {
  const source = `int f(int x, int y) { return ${expr}; }\nint main() { return f(1, 2); }`;
  const result = compile(source, { optimize: true });
  assert.ok(result.ok, result.diagnostics.map((d) => d.text).join('\n'));
  const body = result.optimizedAst.functions[0].body.body;
  return show(body[0].value);
}

function show(e) {
  switch (e.kind) {
    case 'Number': return String(e.value);
    case 'Identifier': return e.name;
    case 'Unary': return `${e.op}${show(e.operand)}`;
    case 'Binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case 'Call': return `${e.name}(${e.args.map(show).join(', ')})`;
    default: return e.kind;
  }
}

test('fold helpers use 32-bit C semantics', () => {
  assert.equal(foldBinary('+', 2147483647, 1), -2147483648);
  assert.equal(foldBinary('*', 65536, 65536), 0);
  assert.equal(foldBinary('*', 123456789, 987654321), Math.imul(123456789, 987654321));
  assert.equal(foldBinary('/', -7, 2), -3);
  assert.equal(foldBinary('%', -7, 2), -1);
  assert.equal(foldBinary('/', -2147483648, -1), -2147483648);
  assert.equal(foldBinary('/', 1, 0), null);
  assert.equal(foldBinary('<<', 1, 33), 2); // shift count is masked to 5 bits, like sllv
  assert.equal(foldBinary('>>', -16, 2), -4);
  assert.equal(foldUnary('-', -2147483648), -2147483648);
  assert.equal(foldUnary('!', 5), 0);
  assert.equal(foldUnary('~', 0), -1);
});

test('constant folding', () => {
  assert.equal(optimized('2 + 3 * 4'), '14');
  assert.equal(optimized('(1 << 4) | 3 & 6'), '18');
  assert.equal(optimized('-7 / 2 + -7 % 2'), '-4');
  assert.equal(optimized('2147483647 + 1'), '-2147483648');
  assert.equal(optimized('!(3 < 2) && 7'), '1');
  assert.equal(optimized('~0 == -1'), '1');
  assert.equal(optimized("'a' + 1"), '98');
});

test('division by a constant zero is left for run time', () => {
  assert.equal(optimized('x / 0'), '(x / 0)');
  assert.equal(optimized('6 / 0'), '(6 / 0)');
});

test('algebraic identities', () => {
  assert.equal(optimized('x + 0'), 'x');
  assert.equal(optimized('0 + x'), 'x');
  assert.equal(optimized('x - 0'), 'x');
  assert.equal(optimized('0 - x'), '-x');
  assert.equal(optimized('x * 1'), 'x');
  assert.equal(optimized('x * 0'), '0');
  assert.equal(optimized('x / 1'), 'x');
  assert.equal(optimized('x | 0'), 'x');
  assert.equal(optimized('x & 0'), '0');
  assert.equal(optimized('x - x'), '0');
  assert.equal(optimized('x ^ x'), '0');
  assert.equal(optimized('- -x'), 'x');
  assert.equal(optimized('!(x < y)'), '(x >= y)');
});

test('strength reduction and reassociation', () => {
  assert.equal(optimized('x * 8'), '(x << 3)');
  assert.equal(optimized('16 * y'), '(y << 4)');
  assert.equal(optimized('x / 8'), '(x / 8)'); // not a shift: -1 / 8 is 0 but -1 >> 3 is -1
  assert.equal(optimized('x + 1 + 2'), '(x + 3)');
  assert.equal(optimized('x - 1 - 2'), '(x - 3)');
  assert.equal(optimized('x + 5 - 5'), 'x');
});

test('short-circuit operators with constants', () => {
  assert.equal(optimized('0 && x'), '0');
  assert.equal(optimized('1 || x'), '1');
  assert.equal(optimized('1 && x'), '(x != 0)');
  assert.equal(optimized('0 || x < y'), '(x < y)');
  assert.equal(optimized('x && 1'), '(x != 0)');
  assert.equal(optimized('x || 0'), '(x != 0)');
});

test('calls are never removed', () => {
  assert.equal(optimized('f(x, y) * 0'), '(f(x, y) * 0)');
  assert.equal(optimized('f(x, y) && 0'), '(f(x, y) && 0)');
  assert.equal(optimized('0 && f(x, y)'), '0'); // f is never called anyway (short-circuit)
});

function bodyKinds(body) {
  const src = `int g;\nint main() {\n${body}\nreturn 0;\n}`;
  const result = compile(src, { optimize: true });
  assert.ok(result.ok, result.diagnostics.map((d) => d.text).join('\n'));
  return result.optimizedAst.functions[0].body.body.map((s) => s.kind);
}

test('dead code elimination', () => {
  assert.deepEqual(bodyKinds('if (0) g = 1;'), ['Return']);
  assert.deepEqual(bodyKinds('if (1) g = 1; else g = 2;'), ['Assign', 'Return']);
  assert.deepEqual(bodyKinds('while (0) g = 1;'), ['Return']);
  assert.deepEqual(bodyKinds('for (g = 0; 0; g++) {}'), ['Assign', 'Return']);
  assert.deepEqual(bodyKinds('g += 0; g *= 1;'), ['Return']);
  assert.deepEqual(bodyKinds('g + 1;'), ['Return']);
  assert.deepEqual(bodyKinds('return 1;\ng = 2;\ng = 3;'), ['Return']);
});

test('the optimiser can be turned off', () => {
  const result = compile('int main() { return 2 + 3; }', { optimize: false });
  const value = result.optimizedAst.functions[0].body.body[0].value;
  assert.equal(value.kind, 'Binary');
  assert.match(result.asm, /addu/);
  assert.doesNotMatch(compile('int main() { return 2 + 3; }').asm, /addu/);
});
