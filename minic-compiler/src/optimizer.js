// optimizer.js - AST-level optimisations (used at -O1).
//
//   * Constant folding: 2 * 3 + 1 -> 7, with exact 32-bit int semantics
//     (wrap-around, truncating division), so a folded program prints exactly
//     what the unoptimised one prints.
//   * Algebraic simplification: x + 0 -> x, x * 1 -> x, x * 8 -> x << 3,
//     (x + 1) + 2 -> x + 3, 0 && f() -> 0, ...
//   * Dead code: statements after return / break / continue, if (0) {...},
//     while (0) {...}, and expression statements without side effects.
//
// The optimiser never changes what a program prints. Anything that would
// remove a function call (a side effect) is only done when the expression is
// "pure" (contains no call). Division by a constant zero is never folded; it
// is left in so the program fails at run time just like at -O0.
//
// The semantic pass also uses foldBinary/foldUnary/constValue to evaluate
// global initialisers and array sizes, so there is one definition of the
// arithmetic for the whole compiler.

const BOOLEAN_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', '&&', '||']);

/** Fold a binary operator on two 32-bit ints. Returns null if it cannot be folded (x / 0). */
export function foldBinary(op, a, b) {
  switch (op) {
    case '+': return (a + b) | 0;
    case '-': return (a - b) | 0;
    case '*': return Math.imul(a, b);
    case '/': return b === 0 ? null : (a / b) | 0;  // truncates toward zero, like MIPS div
    case '%': return b === 0 ? null : (a % b) | 0;  // sign follows the dividend, like MIPS div
    case '<<': return a << b;                       // JS masks the shift count to 5 bits, like sllv
    case '>>': return a >> b;                       // arithmetic shift, like srav
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '&&': return a !== 0 && b !== 0 ? 1 : 0;
    case '||': return a !== 0 || b !== 0 ? 1 : 0;
    default: throw new Error(`unknown binary operator ${op}`);
  }
}

export function foldUnary(op, a) {
  switch (op) {
    case '-': return (-a) | 0;
    case '~': return ~a;
    case '!': return a === 0 ? 1 : 0;
    default: throw new Error(`unknown unary operator ${op}`);
  }
}

/** Value of a constant expression (numbers and operators only), or null. */
export function constValue(e) {
  switch (e.kind) {
    case 'Number': return e.value;
    case 'Unary': {
      const v = constValue(e.operand);
      return v === null ? null : foldUnary(e.op, v);
    }
    case 'Binary': {
      const a = constValue(e.left);
      const b = constValue(e.right);
      return a === null || b === null ? null : foldBinary(e.op, a, b);
    }
    default: return null;
  }
}

/** True if evaluating `e` has no side effects (no function call inside it). */
export function isPure(e) {
  switch (e.kind) {
    case 'Number':
    case 'Identifier':
    case 'String':
      return true;
    case 'Index': return isPure(e.index);
    case 'Unary': return isPure(e.operand);
    case 'Binary': return isPure(e.left) && isPure(e.right);
    default: return false; // Call
  }
}

/** Does this statement always leave the current block (so what follows is dead)? */
export function terminates(s) {
  if (!s) return false;
  switch (s.kind) {
    case 'Return':
    case 'Break':
    case 'Continue':
      return true;
    case 'Block': return s.body.some(terminates);
    case 'If': return s.else !== null && terminates(s.then) && terminates(s.else);
    default: return false;
  }
}

/**
 * Optimise a (semantically checked) program. The input is not modified.
 * @returns {{ ast: object, stats: { folded: number, simplified: number, removed: number } }}
 */
export function optimize(program) {
  // structuredClone keeps shared references (symbols) shared inside the copy.
  const ast = structuredClone(program);
  const stats = { folded: 0, simplified: 0, removed: 0 };
  const opt = new Optimizer(stats);
  for (const fn of ast.functions) fn.body = opt.statement(fn.body);
  return { ast, stats };
}

class Optimizer {
  constructor(stats) {
    this.stats = stats;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------
  statement(s) {
    switch (s.kind) {
      case 'Block': return this.block(s);
      case 'DeclStmt':
        for (const d of s.decls) if (d.init) d.init = this.expr(d.init);
        return s;
      case 'Assign': return this.assign(s);
      case 'ExprStmt':
        s.expr = this.expr(s.expr);
        if (isPure(s.expr)) return this.removed(s); // `x + 1;` does nothing
        return s;
      case 'If': return this.ifStatement(s);
      case 'While': {
        s.cond = this.expr(s.cond);
        if (isZero(s.cond)) return this.removed(s); // while (0) never runs
        s.body = this.statement(s.body);
        return s;
      }
      case 'For': {
        if (s.init) s.init = this.statement(s.init);
        if (s.cond) s.cond = this.expr(s.cond);
        if (s.cond && isZero(s.cond)) {
          // for (init; 0; ...) only runs its initialiser.
          this.stats.removed++;
          return s.init ?? empty(s);
        }
        if (s.cond && s.cond.kind === 'Number') s.cond = null; // for (; 1; ) == for (;;)
        if (s.update) s.update = this.statement(s.update);
        s.body = this.statement(s.body);
        return s;
      }
      case 'Return':
        s.value = this.expr(s.value);
        return s;
      default: // Break, Continue, Empty
        return s;
    }
  }

  block(b) {
    const body = [];
    for (const s of b.body) {
      const out = this.statement(s);
      if (out.kind !== 'Empty') body.push(out);
      if (terminates(out)) {
        // Everything after return / break / continue in this block is unreachable.
        const dead = b.body.length - b.body.indexOf(s) - 1;
        this.stats.removed += dead;
        break;
      }
    }
    b.body = body;
    return b;
  }

  ifStatement(s) {
    s.cond = this.expr(s.cond);
    if (s.cond.kind === 'Number') {
      // The condition is known at compile time: keep only the branch that runs.
      this.stats.removed++;
      const taken = s.cond.value !== 0 ? s.then : s.else;
      return taken ? this.statement(taken) : empty(s);
    }
    s.then = this.statement(s.then);
    if (s.else) {
      s.else = this.statement(s.else);
      if (s.else.kind === 'Empty') s.else = null;
    }
    return s;
  }

  assign(s) {
    if (s.target.kind === 'Index') s.target.index = this.expr(s.target.index);
    s.value = this.expr(s.value);
    // x += 0, x *= 1, ... on a plain variable change nothing.
    const v = s.value.kind === 'Number' ? s.value.value : null;
    const noOp = (v === 0 && ['+=', '-=', '|=', '^=', '<<=', '>>='].includes(s.op))
      || (v === 1 && ['*=', '/='].includes(s.op));
    if (noOp && s.target.kind === 'Identifier') return this.removed(s);
    return s;
  }

  removed(s) {
    this.stats.removed++;
    return empty(s);
  }

  // -------------------------------------------------------------------------
  // Expressions (bottom-up: simplify the children first, then the node)
  // -------------------------------------------------------------------------
  expr(e) {
    switch (e.kind) {
      case 'Index':
        e.index = this.expr(e.index);
        return e;
      case 'Call':
        e.args = e.args.map((a) => this.expr(a));
        return e;
      case 'Unary': return this.unary(e);
      case 'Binary': return this.binary(e);
      default: // Number, Identifier, String
        return e;
    }
  }

  unary(e) {
    e.operand = this.expr(e.operand);
    const x = e.operand;
    if (x.kind === 'Number') return this.fold(e, foldUnary(e.op, x.value));
    // -(-x) -> x and ~~x -> x
    if ((e.op === '-' || e.op === '~') && x.kind === 'Unary' && x.op === e.op) return this.simplified(x.operand);
    // !(a < b) -> a >= b, and so on (ints have no NaN, so this is exact)
    const inverse = { '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!=', '!=': '==' };
    if (e.op === '!' && x.kind === 'Binary' && inverse[x.op]) {
      x.op = inverse[x.op];
      return this.simplified(x);
    }
    return e;
  }

  binary(e) {
    e.left = this.expr(e.left);
    e.right = this.expr(e.right);
    const { op, left: l, right: r } = e;
    const lc = l.kind === 'Number' ? l.value : null;
    const rc = r.kind === 'Number' ? r.value : null;

    // 1. Both sides constant: fold (except x / 0, which must still fail at run time).
    if (lc !== null && rc !== null) {
      const value = foldBinary(op, lc, rc);
      if (value !== null) return this.fold(e, value);
      return e;
    }

    // 2. Short-circuit operators with one constant side.
    if (op === '&&' || op === '||') return this.logical(e, lc, rc);

    // 3. Algebraic identities. `pure(x)` guards rules that would drop x.
    const same = l.kind === 'Identifier' && r.kind === 'Identifier' && l.name === r.name;
    switch (op) {
      case '+':
        if (rc === 0) return this.simplified(l);
        if (lc === 0) return this.simplified(r);
        return this.reassociate(e) ?? e;
      case '-':
        if (rc === 0) return this.simplified(l);
        if (lc === 0) return this.simplified(unaryNode('-', r, e));
        if (same) return this.fold(e, 0);
        return this.reassociate(e) ?? e;
      case '*':
        if (rc === 1) return this.simplified(l);
        if (lc === 1) return this.simplified(r);
        if ((rc === 0 && isPure(l)) || (lc === 0 && isPure(r))) return this.fold(e, 0);
        if (rc === -1) return this.simplified(unaryNode('-', l, e));
        // Strength reduction: multiplying by 2^k is a left shift by k (exact
        // for 32-bit wrap-around arithmetic, negative numbers included).
        if (isPowerOfTwo(rc)) return this.simplified(shiftNode(l, rc, e));
        if (isPowerOfTwo(lc)) return this.simplified(shiftNode(r, lc, e));
        return e;
      case '/':
        if (rc === 1) return this.simplified(l);
        return e; // x / 2^k is NOT x >> k for negative x, so no shift here
      case '%':
        if ((rc === 1 || rc === -1) && isPure(l)) return this.fold(e, 0);
        return e;
      case '|':
      case '^':
        if (rc === 0) return this.simplified(l);
        if (lc === 0) return this.simplified(r);
        if (op === '^' && same) return this.fold(e, 0);
        return e;
      case '&':
        if (rc === -1) return this.simplified(l);
        if (lc === -1) return this.simplified(r);
        if ((rc === 0 && isPure(l)) || (lc === 0 && isPure(r))) return this.fold(e, 0);
        return e;
      case '<<':
      case '>>':
        if (rc === 0) return this.simplified(l);
        return e;
      case '==':
      case '<=':
      case '>=':
        if (same) return this.fold(e, 1);
        return e;
      case '!=':
      case '<':
      case '>':
        if (same) return this.fold(e, 0);
        return e;
      default:
        return e;
    }
  }

  /** && and || where one side is a constant. The result must still be 0 or 1. */
  logical(e, lc, rc) {
    const { op, left, right } = e;
    if (lc !== null) {
      // The left side is evaluated first, so it decides alone if it short-circuits.
      if (op === '&&') return lc === 0 ? this.fold(e, 0) : this.simplified(toBool(right));
      return lc !== 0 ? this.fold(e, 1) : this.simplified(toBool(right));
    }
    if (rc !== null) {
      // `x && 1` is just "x is true". `x && 0` is 0, but only drop x if it is pure.
      if (op === '&&') {
        if (rc !== 0) return this.simplified(toBool(left));
        if (isPure(left)) return this.fold(e, 0);
      } else {
        if (rc === 0) return this.simplified(toBool(left));
        if (isPure(left)) return this.fold(e, 1);
      }
    }
    return e;
  }

  /**
   * (x + c1) + c2 -> x + (c1 + c2), and the same with minus signs.
   * Wrap-around addition is associative, so this is exact.
   */
  reassociate(e) {
    const { op, left: inner, right } = e;
    if (right.kind !== 'Number' || inner.kind !== 'Binary' || inner.right.kind !== 'Number') return null;
    if (inner.op !== '+' && inner.op !== '-') return null;
    const c1 = inner.op === '+' ? inner.right.value : -inner.right.value;
    const c2 = op === '+' ? right.value : -right.value;
    const total = (c1 + c2) | 0;
    this.stats.folded++;
    if (total === 0) return this.simplified(inner.left);
    return this.simplified({
      ...e,
      op: total < 0 && total !== -2147483648 ? '-' : '+',
      left: inner.left,
      right: numberNode(total < 0 && total !== -2147483648 ? -total : total, e),
    });
  }

  fold(e, value) {
    this.stats.folded++;
    return numberNode(value, e);
  }

  simplified(e) {
    this.stats.simplified++;
    return e;
  }
}

// ---------------------------------------------------------------------------
// Small AST builders
// ---------------------------------------------------------------------------
function numberNode(value, pos) {
  return { kind: 'Number', value, text: String(value), line: pos.line, col: pos.col, length: pos.length };
}

function unaryNode(op, operand, pos) {
  return { kind: 'Unary', op, operand, line: pos.line, col: pos.col, length: pos.length };
}

function shiftNode(x, power, pos) {
  return { kind: 'Binary', op: '<<', left: x, right: numberNode(Math.log2(power), pos), line: pos.line, col: pos.col, length: pos.length };
}

/** `e` as 0/1: comparisons already are, anything else becomes e != 0. */
function toBool(e) {
  if ((e.kind === 'Binary' && BOOLEAN_OPS.has(e.op)) || (e.kind === 'Unary' && e.op === '!')) return e;
  if (e.kind === 'Number') return numberNode(e.value !== 0 ? 1 : 0, e);
  return { kind: 'Binary', op: '!=', left: e, right: numberNode(0, e), line: e.line, col: e.col, length: e.length };
}

function empty(pos) {
  return { kind: 'Empty', line: pos.line, col: pos.col, length: pos.length };
}

function isZero(e) {
  return e.kind === 'Number' && e.value === 0;
}

function isPowerOfTwo(c) {
  return c !== null && c > 1 && c <= 0x40000000 && (c & (c - 1)) === 0;
}
