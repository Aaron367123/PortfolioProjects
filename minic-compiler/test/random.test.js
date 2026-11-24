// Property-style test: random expressions must print exactly what a JS
// reference evaluator with 32-bit C semantics computes.
//
// The expressions are printed with the *minimum* parentheses that precedence
// and left-associativity require, so this also checks the parser. They use
// literals, locals, a global and calls (so the register stack has to save
// and restore temporaries around jal), at both -O0 and -O1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from './helpers.js';
import { PRECEDENCE } from '../src/parser.js';

const COUNT = 200;
const PER_PROGRAM = 20;

/** mulberry32: a tiny seeded PRNG, so failures are reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VARS = { a: 7, b: -13, c: 100000, g: -2147483647 };
const BINARY = Object.keys(PRECEDENCE);
const UNARY = ['-', '!', '~'];

// ---------------------------------------------------------------------------
// Reference evaluator (independent of the compiler's optimizer.js)
// ---------------------------------------------------------------------------
class DivByZero extends Error {}

function evaluate(e, strict) {
  switch (e.kind) {
    case 'num': return e.value;
    case 'var': return VARS[e.name];
    case 'id': return evaluate(e.arg, strict);                                 // id(x) = x
    case 'sub2': return (evaluate(e.left, strict) - evaluate(e.right, strict)) | 0; // sub2(x, y) = x - y
    case 'un': {
      const v = evaluate(e.arg, strict);
      return e.op === '-' ? (-v | 0) : e.op === '~' ? ~v : (v === 0 ? 1 : 0);
    }
    case 'bin': {
      const l = evaluate(e.left, strict);
      // && and || only evaluate the right side when needed (strict mode always does,
      // to reject any expression that contains a division by zero anywhere).
      if (!strict && e.op === '&&' && l === 0) return 0;
      if (!strict && e.op === '||' && l !== 0) return 1;
      const r = evaluate(e.right, strict);
      switch (e.op) {
        case '+': return (l + r) | 0;
        case '-': return (l - r) | 0;
        case '*': return Math.imul(l, r);
        case '/': if (r === 0) throw new DivByZero(); return (l / r) | 0;
        case '%': if (r === 0) throw new DivByZero(); return (l % r) | 0;
        case '<<': return l << r;
        case '>>': return l >> r;
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        case '==': return +(l === r);
        case '!=': return +(l !== r);
        case '<': return +(l < r);
        case '<=': return +(l <= r);
        case '>': return +(l > r);
        case '>=': return +(l >= r);
        case '&&': return +(l !== 0 && r !== 0);
        case '||': return +(l !== 0 || r !== 0);
        default: throw new Error(e.op);
      }
    }
    default: throw new Error(e.kind);
  }
}

// ---------------------------------------------------------------------------
// Generator and printer
// ---------------------------------------------------------------------------
function generator(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const literal = () => {
    const r = random();
    if (r < 0.5) return Math.floor(random() * 20);
    if (r < 0.7) return Math.floor(random() * 32);                // good shift counts
    if (r < 0.9) return Math.floor(random() * 70000);             // beyond 16-bit immediates
    return pick([2147483647, 65535, 65536, 32767, 32768, 0x7fff0000, 1 << 30]);
  };

  function gen(depth) {
    const r = random();
    if (depth <= 0 || r < 0.15) {
      return random() < 0.6 ? { kind: 'num', value: literal() } : { kind: 'var', name: pick(Object.keys(VARS)) };
    }
    if (r < 0.25) return { kind: 'un', op: pick(UNARY), arg: gen(depth - 1) };
    if (r < 0.30) return { kind: 'id', arg: gen(depth - 1) };
    if (r < 0.34) return { kind: 'sub2', left: gen(depth - 1), right: gen(depth - 1) };
    return { kind: 'bin', op: pick(BINARY), left: gen(depth - 1), right: gen(depth - 1) };
  }
  return gen;
}

/** Print with the fewest parentheses: a child needs them only if it binds more loosely. */
function print(e) {
  switch (e.kind) {
    case 'num': return String(e.value);
    case 'var': return e.name;
    case 'id': return `id(${print(e.arg)})`;
    case 'sub2': return `sub2(${print(e.left)}, ${print(e.right)})`;
    case 'un': {
      const inner = print(e.arg);
      const atomic = e.arg.kind === 'num' || e.arg.kind === 'var' || e.arg.kind === 'id' || e.arg.kind === 'sub2';
      return atomic ? `${e.op}${inner}` : `${e.op}(${inner})`;
    }
    case 'bin': {
      const p = PRECEDENCE[e.op];
      const side = (child, isRight) => {
        const text = print(child);
        if (child.kind !== 'bin') return text;
        const cp = PRECEDENCE[child.op];
        // Left-associative: an equal-precedence child on the right needs parentheses.
        return cp < p || (isRight && cp === p) ? `(${text})` : text;
      };
      return `${side(e.left, false)} ${e.op} ${side(e.right, true)}`;
    }
    default: throw new Error(e.kind);
  }
}

function makeCases() {
  const random = prng(0xC0FFEE);
  const gen = generator(random);
  const cases = [];
  while (cases.length < COUNT) {
    const e = gen(1 + Math.floor(random() * 5));
    try {
      evaluate(e, true); // reject anything with a division by zero anywhere
    } catch (err) {
      if (err instanceof DivByZero) continue;
      throw err;
    }
    cases.push({ text: print(e), expected: evaluate(e, false) });
  }
  return cases;
}

const CASES = makeCases();

function programFor(cases) {
  const prints = cases.map((c) => `  print_int(${c.text});\n  print_char('\\n');`).join('\n');
  return `int g = ${VARS.g};
int id(int x) { return x; }
int sub2(int x, int y) { return x - y; }
int main() {
  int a = ${VARS.a}, b = ${VARS.b}, c = ${VARS.c};
${prints}
  return 0;
}
`;
}

for (const optimize of [false, true]) {
  test(`${COUNT} random expressions match the 32-bit reference at -O${optimize ? 1 : 0}`, () => {
    let checked = 0;
    for (let start = 0; start < CASES.length; start += PER_PROGRAM) {
      const batch = CASES.slice(start, start + PER_PROGRAM);
      const { output } = runProgram(programFor(batch), { optimize });
      const lines = output.split('\n');
      batch.forEach((c, i) => {
        assert.equal(lines[i], String(c.expected), `expression #${start + i}: ${c.text}`);
        checked++;
      });
    }
    assert.equal(checked, COUNT);
  });
}

test('the random expressions exercise every operator', () => {
  const all = CASES.map((c) => c.text).join(' ');
  for (const op of [...BINARY, '~', '!', 'id(', 'sub2(']) {
    assert.ok(all.includes(op), `no expression uses ${op}`);
  }
});
