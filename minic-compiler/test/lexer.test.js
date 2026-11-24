import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { CompileError } from '../src/diagnostics.js';

const kinds = (src) => tokenize(src).map((t) => `${t.type}:${t.text}`);

test('identifiers, keywords and numbers', () => {
  assert.deepEqual(kinds('int x_1 = 42;'), ['keyword:int', 'ident:x_1', 'op:=', 'int:42', 'op:;', 'eof:']);
  assert.deepEqual(kinds('while whilex return'), ['keyword:while', 'ident:whilex', 'keyword:return', 'eof:']);
});

test('operators are matched longest first', () => {
  assert.deepEqual(kinds('a<<=b<=c<d'), ['ident:a', 'op:<<=', 'ident:b', 'op:<=', 'ident:c', 'op:<', 'ident:d', 'eof:']);
  assert.deepEqual(kinds('i++ + ++j'), ['ident:i', 'op:++', 'op:+', 'op:++', 'ident:j', 'eof:']);
  assert.deepEqual(kinds('a&&b||!c&d|e^f~g'), [
    'ident:a', 'op:&&', 'ident:b', 'op:||', 'op:!', 'ident:c', 'op:&', 'ident:d',
    'op:|', 'ident:e', 'op:^', 'ident:f', 'op:~', 'ident:g', 'eof:',
  ]);
});

test('hex and char literals are ints', () => {
  const [hex, ffff, chr, nl, quote] = tokenize("0x1F 0xFFFFFFFF 'a' '\\n' '\\''");
  assert.equal(hex.value, 31);
  assert.equal(ffff.value, -1); // wraps like a 32-bit int
  assert.equal(chr.value, 97);
  assert.equal(chr.type, 'int');
  assert.equal(nl.value, 10);
  assert.equal(quote.value, 39);
});

test('string literals decode escapes', () => {
  const [s] = tokenize('"a\\tb\\n\\"q\\""');
  assert.equal(s.type, 'string');
  assert.equal(s.value, 'a\tb\n"q"');
});

test('comments are skipped and positions are 1-based line:col', () => {
  const tokens = tokenize('// first line\n  /* multi\n line */ x\n\ty');
  assert.deepEqual(tokens.map((t) => [t.text, t.line, t.col]), [['x', 3, 10], ['y', 4, 2], ['', 4, 3]]);
});

function lexError(src) {
  try {
    tokenize(src);
  } catch (err) {
    assert.ok(err instanceof CompileError);
    return err;
  }
  return assert.fail(`expected a lexer error for ${src}`);
}

test('lexical errors carry a message and a position', () => {
  let e = lexError('int x = 3 @ 4;');
  assert.match(e.message, /unexpected character '@'/);
  assert.deepEqual([e.line, e.col], [1, 11]);

  assert.match(lexError('x = 4294967296;').message, /out of range/);
  assert.match(lexError('x = 2147483649;').message, /out of range/);
  assert.match(lexError('x = 0x100000000;').message, /does not fit in 32 bits/);
  assert.match(lexError('print("abc\n");').message, /unterminated string/);
  assert.match(lexError("x = '';").message, /empty character literal/);
  assert.match(lexError("x = 'ab';").message, /unterminated character literal/);
  assert.match(lexError('/* never closed').message, /unterminated \/\* comment/);
  assert.match(lexError('x = 12ab;').message, /invalid character 'a' in number/);
  assert.match(lexError('"\\q"').message, /unknown escape/);

  e = lexError('int a;\n  int b = $;');
  assert.deepEqual([e.line, e.col], [2, 11]);
});
