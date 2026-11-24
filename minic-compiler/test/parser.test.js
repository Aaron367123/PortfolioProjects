import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { CompileError } from '../src/diagnostics.js';

/** Parse `int main() { return <expr>; }` and print the expression fully parenthesised. */
function shape(expr) {
  const program = parse(tokenize(`int main() { return ${expr}; }`));
  return show(program.functions[0].body.body[0].value);
}

function show(e) {
  switch (e.kind) {
    case 'Number': return String(e.value);
    case 'Identifier': return e.name;
    case 'Unary': return `(${e.op}${show(e.operand)})`;
    case 'Binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case 'Call': return `${e.name}(${e.args.map(show).join(', ')})`;
    case 'Index': return `${e.name}[${show(e.index)}]`;
    default: return `?${e.kind}`;
  }
}

test('multiplication binds tighter than addition', () => {
  assert.equal(shape('a + b * c'), '(a + (b * c))');
  assert.equal(shape('a * b + c'), '((a * b) + c)');
});

test('binary operators are left-associative', () => {
  assert.equal(shape('a - b - c'), '((a - b) - c)');
  assert.equal(shape('a / b / c'), '((a / b) / c)');
  assert.equal(shape('a << b << c'), '((a << b) << c)');
  assert.equal(shape('a || b || c'), '((a || b) || c)');
});

test('the full C precedence ladder', () => {
  assert.equal(shape('a || b && c'), '(a || (b && c))');
  assert.equal(shape('a && b | c'), '(a && (b | c))');
  assert.equal(shape('a | b ^ c'), '(a | (b ^ c))');
  assert.equal(shape('a ^ b & c'), '(a ^ (b & c))');
  assert.equal(shape('a & b == c'), '(a & (b == c))');
  assert.equal(shape('a == b < c'), '(a == (b < c))');
  assert.equal(shape('a < b << c'), '(a < (b << c))');
  assert.equal(shape('a << b + c'), '(a << (b + c))');
  assert.equal(shape('a + b % c'), '(a + (b % c))');
  assert.equal(shape('a != b >= c'), '(a != (b >= c))');
  assert.equal(shape('a * b - c / d % e'), '((a * b) - ((c / d) % e))');
});

test('unary operators bind tightest and nest', () => {
  assert.equal(shape('-a * b'), '((-a) * b)');
  assert.equal(shape('!a == b'), '((!a) == b)');
  assert.equal(shape('~-!a'), '(~(-(!a)))');
  assert.equal(shape('- -a'), '(-(-a))');
});

test('parentheses, calls and indexing', () => {
  assert.equal(shape('(a + b) * c'), '((a + b) * c)');
  assert.equal(shape('f(a, b + 1) * g()'), '(f(a, (b + 1)) * g())');
  assert.equal(shape('arr[i + 1] - 1'), '(arr[(i + 1)] - 1)');
});

test('-2147483648 is a single literal', () => {
  assert.equal(shape('-2147483648'), '-2147483648');
  assert.equal(shape('-2147483647 - 1'), '((-2147483647) - 1)');
});

test('statements: dangling else, for with a declaration, ++ and --', () => {
  const program = parse(tokenize(`
    int g = 1, arr[4];
    int main() {
      if (a) if (b) x = 1; else x = 2;
      for (int i = 0; i < 3; i++) { x += i; --y; }
      while (1) break;
      return 0;
    }`));
  assert.deepEqual(program.globals.map((g) => g.kind), ['VarDecl', 'ArrayDecl']);
  const [outer, loop, w] = program.functions[0].body.body;
  assert.equal(outer.else, null);            // the else belongs to the inner if
  assert.equal(outer.then.kind, 'If');
  assert.notEqual(outer.then.else, null);
  assert.equal(loop.kind, 'For');
  assert.equal(loop.init.kind, 'DeclStmt');
  assert.equal(loop.update.op, '+=');
  assert.equal(loop.update.form, '++');
  assert.equal(loop.body.body[1].op, '-=');
  assert.equal(w.body.kind, 'Break');
});

function syntaxError(src) {
  try {
    parse(tokenize(src));
  } catch (err) {
    assert.ok(err instanceof CompileError, String(err));
    return err;
  }
  return assert.fail(`expected a syntax error for: ${src}`);
}

test('syntax errors say what was expected and where', () => {
  let e = syntaxError('int main() { x = 1 }');
  assert.match(e.message, /expected ';' at the end of the statement but found '}'/);
  assert.deepEqual([e.line, e.col], [1, 20]);

  e = syntaxError('int main() {\n  return (1 + 2;\n}');
  assert.match(e.message, /expected '\)' to close the parenthesis/);
  assert.equal(e.line, 2);

  assert.match(syntaxError('int main() { return; }').message, /'return' needs a value/);
  assert.match(syntaxError('int main() { int a[3]; }').message, /local arrays are not supported/);
  assert.match(syntaxError('int main() { y = x++; }').message, /'\+\+' can only be used as a statement/);
  assert.match(syntaxError('int main() { else x = 1; }').message, /'else' without a matching 'if'/);
  assert.match(syntaxError('int main() { x = ; }').message, /expected an expression but found ';'/);
  assert.match(syntaxError('int main() {').message, /missing '}'/);
  assert.match(syntaxError('x = 1;').message, /expected 'int' to start a global variable or function/);
  assert.match(syntaxError('int f(a) { return 0; }').message, /expected 'int' before the parameter name/);
  assert.match(syntaxError('int main() { return 2147483648; }').message, /out of range/);
});

test('assigning to something that is not a variable is an error', () => {
  let e = syntaxError('int main() { 1 + 2 = 3; }');
  assert.match(e.message, /left side is not a variable or array element/);
  assert.deepEqual([e.line, e.col, e.length], [1, 14, 5]); // underlines "1 + 2"

  assert.match(syntaxError('int main() { f() = 3; }').message, /not a variable/);
  assert.match(syntaxError('int main() { (a + 1)++; }').message, /cannot use '\+\+' here/);
});

test('assignment is a statement, not an expression', () => {
  const e = syntaxError('int main() { if (x = 1) return 1; return 0; }');
  assert.match(e.message, /expected '\)' after the condition but found '='/);
});
