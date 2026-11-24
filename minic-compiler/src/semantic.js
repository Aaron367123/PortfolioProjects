// semantic.js - name resolution and checks.
//
// The parser only knows the shape of the program. This pass works out what
// every name means and whether the program makes sense:
//
//   * builds the symbol tables: one global scope (builtins, functions, global
//     variables and arrays) and a stack of nested block scopes per function,
//   * attaches a `symbol` to every Identifier / Index / Call node,
//   * gives every local variable and parameter a slot in the stack frame,
//   * collects string literals into a table for the .data section,
//   * reports errors (unknown name, redeclaration, wrong argument count,
//     break outside a loop, ...) and warnings (unreachable code, division by
//     a constant zero, unused results).
//
// Unlike the parser it keeps going after an error, so one compile shows every
// semantic problem at once.

import { diagnostic } from './diagnostics.js';
import { constValue, terminates, isPure } from './optimizer.js';

export const MAX_PARAMS = 4;        // arguments travel in $a0-$a3
export const MAX_DATA_BYTES = 0xffff - 0x2000 + 1; // `la` can only address up to 0xFFFF
export const FRAME_HEADER = 8;      // saved $ra and $fp at the top of every frame

/** Built-in functions. They are statements only (they do not return a value). */
export const BUILTINS = {
  print_int: { syscall: 1, arg: 'int', summary: 'print a signed integer' },
  print_char: { syscall: 11, arg: 'int', summary: 'print the character with this code' },
  print: { syscall: 4, arg: 'string', summary: 'print a string literal' },
};

/**
 * @param {object} program the Program node from the parser (annotated in place)
 * @returns {{ diagnostics: object[], strings: {label: string, value: string}[], dataBytes: number }}
 */
export function analyze(program) {
  return new Analyzer(program).run();
}

class Analyzer {
  constructor(program) {
    this.program = program;
    this.diagnostics = [];
    this.globals = new Map();  // name -> symbol
    this.scopes = [];          // block scopes of the current function, innermost last
    this.strings = [];         // { label, value } for print("...")
    this.fn = null;            // function being checked
    this.loopDepth = 0;
  }

  error(message, where) {
    this.diagnostics.push(diagnostic('error', message, where));
  }

  warning(message, where) {
    this.diagnostics.push(diagnostic('warning', message, where));
  }

  run() {
    const p = this.program;
    for (const [name, info] of Object.entries(BUILTINS)) {
      this.globals.set(name, { kind: 'builtin', name, ...info });
    }

    // Pass 1: declare every global and function first, so functions can call
    // each other (and themselves) in any order without forward declarations.
    let dataBytes = 0;
    for (const g of p.globals) {
      dataBytes += this.declareGlobal(g);
    }
    for (const fn of p.functions) this.declareFunction(fn);

    // Pass 2: check function bodies.
    for (const fn of p.functions) this.checkFunction(fn);

    const main = this.globals.get('main');
    if (!main || main.kind !== 'function') {
      this.error("the program has no 'main' function (add: int main() { ... })", { line: 1, col: 1 });
    } else if (main.params !== 0) {
      this.error("'main' must not take parameters", main.node);
    }

    dataBytes += this.strings.reduce((sum, s) => sum + new TextEncoder().encode(s.value).length + 1, 0);
    if (dataBytes > MAX_DATA_BYTES) {
      this.error(`global data is ${dataBytes} bytes, but the emulator's 'la' can only reach ${MAX_DATA_BYTES} bytes of data (0x2000-0xFFFF)`, { line: 1, col: 1 });
    }
    p.strings = this.strings;
    p.dataBytes = dataBytes;
    return { diagnostics: this.diagnostics, strings: this.strings, dataBytes };
  }

  // -------------------------------------------------------------------------
  // Globals and functions
  // -------------------------------------------------------------------------
  declareName(name, symbol, node) {
    const previous = this.globals.get(name);
    if (previous) {
      if (previous.kind === 'builtin') this.error(`'${name}' is a built-in function and cannot be redefined`, node);
      else this.error(`redeclaration of '${name}' (first declared at line ${previous.node.line})`, node);
      return false;
    }
    this.globals.set(name, symbol);
    return true;
  }

  /** Declare a global variable or array. Returns its size in bytes. */
  declareGlobal(g) {
    if (g.kind === 'ArrayDecl') {
      const size = constValue(g.size);
      if (size === null) {
        this.error(`the size of array '${g.name}' must be a constant`, g.size);
      } else if (size <= 0) {
        this.error(`the size of array '${g.name}' must be positive (got ${size})`, g.size);
      }
      const length = size !== null && size > 0 ? size : 1;
      const values = [];
      if (g.init) {
        if (g.init.length > length) this.error(`too many initialisers for '${g.name}[${length}]' (${g.init.length})`, g.init[length] ?? g);
        for (const e of g.init) values.push(this.constInit(e, g.name));
      }
      g.symbol = { kind: 'array', name: g.name, label: `g_${g.name}`, size: length, node: pos(g) };
      g.values = values;
      this.declareName(g.name, g.symbol, g);
      return Math.min(length, MAX_DATA_BYTES) * 4;
    }

    g.symbol = { kind: 'global', name: g.name, label: `g_${g.name}`, node: pos(g) };
    g.initValue = g.init ? this.constInit(g.init, g.name) : 0;
    this.declareName(g.name, g.symbol, g);
    return 4;
  }

  /** Global initialisers go into the .data section, so they must be known at compile time. */
  constInit(e, name) {
    const value = constValue(e);
    if (value === null) {
      this.error(`the initialiser of global '${name}' must be a constant expression`, e);
      return 0;
    }
    return value;
  }

  declareFunction(fn) {
    fn.symbol = { kind: 'function', name: fn.name, label: `f_${fn.name}`, params: fn.params.length, node: pos(fn) };
    this.declareName(fn.name, fn.symbol, fn);
    if (fn.params.length > MAX_PARAMS) {
      const extra = fn.params[MAX_PARAMS];
      this.error(`function '${fn.name}' has ${fn.params.length} parameters; Mini-C allows at most ${MAX_PARAMS} (they are passed in $a0-$a3)`, extra);
    }
  }

  checkFunction(fn) {
    this.fn = fn;
    this.slot = 0;     // next free stack slot (4 bytes each) below the saved $ra / $fp
    this.maxSlot = 0;
    this.loopDepth = 0;

    // Parameters and the outermost block of the body share one scope (as in C,
    // `int f(int x) { int x; }` is a redeclaration).
    this.scopes = [new Map()];
    fn.paramSymbols = fn.params.map((p) => this.declareLocal(p.name, p, true));
    this.checkStatements(fn.body.body);
    this.scopes = [];

    fn.frameSize = FRAME_HEADER + 4 * this.maxSlot;
    this.fn = null;
  }

  // -------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------
  /** Give a local variable the next free 4-byte slot below $fp. */
  declareLocal(name, node, isParam = false) {
    const scope = this.scopes[this.scopes.length - 1];
    const previous = scope.get(name);
    if (previous) {
      this.error(`redeclaration of '${name}' in the same scope (first declared at line ${previous.node.line})`, node);
      return previous;
    }
    const global = this.globals.get(name);
    if (global && global.kind !== 'global' && global.kind !== 'array') {
      this.error(`'${name}' is already the name of a ${global.kind === 'builtin' ? 'built-in function' : 'function'}`, node);
    }
    const offset = -(FRAME_HEADER + 4 * (this.slot + 1)); // -12, -16, -20, ... relative to $fp
    this.slot++;
    this.maxSlot = Math.max(this.maxSlot, this.slot);
    const symbol = { kind: 'local', name, offset, isParam, node: pos(node) };
    scope.set(name, symbol);
    return symbol;
  }

  /** Run `body` in a new block scope. Slots are reused once the scope ends. */
  withScope(body) {
    const savedSlot = this.slot;
    this.scopes.push(new Map());
    body();
    this.scopes.pop();
    this.slot = savedSlot;
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const symbol = this.scopes[i].get(name);
      if (symbol) return symbol;
    }
    return this.globals.get(name) ?? null;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------
  checkStatements(list) {
    let warned = false;
    list.forEach((s, i) => {
      this.statement(s);
      if (!warned && i < list.length - 1 && terminates(s)) {
        const next = list[i + 1];
        this.warning('unreachable code (it comes after a return, break or continue)', next);
        warned = true;
      }
    });
  }

  /** A statement that is the body of if/while/for gets its own scope. */
  nested(s) {
    this.withScope(() => this.statement(s));
  }

  statement(s) {
    switch (s.kind) {
      case 'Block':
        this.withScope(() => this.checkStatements(s.body));
        break;
      case 'DeclStmt':
        for (const d of s.decls) {
          if (d.init) this.expr(d.init);
          // Declared after its initialiser: in `int x = x;` the right x is the outer one.
          d.symbol = this.declareLocal(d.name, d);
        }
        break;
      case 'Assign':
        this.assignTarget(s.target);
        this.expr(s.value);
        if ((s.op === '/=' || s.op === '%=') && constValue(s.value) === 0) {
          this.warning('division by zero (this will stop the program at run time)', s.value);
        }
        break;
      case 'ExprStmt':
        if (s.expr.kind === 'Call') {
          this.call(s.expr, true);
        } else {
          this.expr(s.expr);
          if (isPure(s.expr)) this.warning('expression result is unused', s);
        }
        break;
      case 'If':
        this.condition(s.cond);
        this.nested(s.then);
        if (s.else) this.nested(s.else);
        break;
      case 'While':
        this.condition(s.cond);
        this.loop(() => this.nested(s.body));
        break;
      case 'For':
        // The for-loop has its own scope, so `for (int i = 0; ...)` keeps i local to the loop.
        this.withScope(() => {
          if (s.init) this.statement(s.init);
          if (s.cond) this.condition(s.cond);
          this.loop(() => {
            this.nested(s.body);
            if (s.update) this.statement(s.update);
          });
        });
        break;
      case 'Break':
      case 'Continue':
        if (this.loopDepth === 0) this.error(`'${s.kind.toLowerCase()}' outside of a loop`, s);
        break;
      case 'Return':
        this.expr(s.value);
        break;
      case 'Empty':
        break;
      default:
        throw new Error(`unknown statement kind ${s.kind}`);
    }
  }

  loop(body) {
    this.loopDepth++;
    body();
    this.loopDepth--;
  }

  condition(e) {
    this.expr(e);
  }

  assignTarget(t) {
    const symbol = this.lookup(t.name);
    if (!symbol) {
      this.error(`unknown identifier '${t.name}'`, t);
      return;
    }
    t.symbol = symbol;
    if (t.kind === 'Index') {
      if (symbol.kind !== 'array') this.error(`'${t.name}' is not an array, so it cannot be indexed`, t);
      else this.checkIndex(t, symbol);
      this.expr(t.index);
      return;
    }
    if (symbol.kind === 'array') this.error(`cannot assign to the array '${t.name}' itself; assign to an element like ${t.name}[i]`, t);
    else if (symbol.kind === 'function' || symbol.kind === 'builtin') this.error(`cannot assign to '${t.name}': it is a function`, t);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------
  expr(e) {
    switch (e.kind) {
      case 'Number':
        break;
      case 'String':
        this.error('string literals can only be used as the argument of print("...")', e);
        break;
      case 'Identifier': {
        const symbol = this.lookup(e.name);
        if (!symbol) {
          this.error(`unknown identifier '${e.name}'`, e);
        } else if (symbol.kind === 'function' || symbol.kind === 'builtin') {
          this.error(`'${e.name}' is a function; call it with ${e.name}(...)`, e);
        } else if (symbol.kind === 'array') {
          this.error(`'${e.name}' is an array; use an element like ${e.name}[i]`, e);
        }
        e.symbol = symbol;
        break;
      }
      case 'Index': {
        const symbol = this.lookup(e.name);
        if (!symbol) this.error(`unknown identifier '${e.name}'`, e);
        else if (symbol.kind !== 'array') this.error(`'${e.name}' is not an array, so it cannot be indexed`, e);
        else this.checkIndex(e, symbol);
        e.symbol = symbol;
        this.expr(e.index);
        break;
      }
      case 'Call':
        this.call(e, false);
        break;
      case 'Unary':
        this.expr(e.operand);
        break;
      case 'Binary':
        this.expr(e.left);
        this.expr(e.right);
        if ((e.op === '/' || e.op === '%') && constValue(e.right) === 0) {
          this.warning('division by zero (this will stop the program at run time)', e);
        }
        break;
      default:
        throw new Error(`unknown expression kind ${e.kind}`);
    }
  }

  /** A constant index can be checked against the array size at compile time. */
  checkIndex(e, symbol) {
    const index = constValue(e.index);
    if (index !== null && (index < 0 || index >= symbol.size)) {
      this.error(`index ${index} is out of bounds for '${e.name}' (size ${symbol.size}, valid 0..${symbol.size - 1})`, e.index);
    }
  }

  call(e, isStatement) {
    const symbol = this.lookup(e.name);
    e.symbol = symbol;
    if (!symbol) {
      this.error(`unknown function '${e.name}'`, e);
      e.args.forEach((a) => this.expr(a));
      return;
    }
    if (symbol.kind === 'builtin') {
      this.builtinCall(e, symbol, isStatement);
      return;
    }
    if (symbol.kind !== 'function') {
      this.error(`'${e.name}' is not a function`, e);
      e.args.forEach((a) => this.expr(a));
      return;
    }
    if (e.args.length !== symbol.params) {
      const n = symbol.params;
      this.error(`function '${e.name}' expects ${n} argument${n === 1 ? '' : 's'} but got ${e.args.length}`, e);
    }
    e.args.forEach((a) => this.expr(a));
  }

  builtinCall(e, symbol, isStatement) {
    if (!isStatement) {
      this.error(`${e.name}(...) does not return a value, so it can only be used as a statement`, e);
    }
    if (e.args.length !== 1) {
      this.error(`${e.name} expects 1 argument but got ${e.args.length}`, e);
      e.args.forEach((a) => (a.kind === 'String' ? null : this.expr(a)));
      return;
    }
    const arg = e.args[0];
    if (symbol.arg === 'string') {
      if (arg.kind !== 'String') {
        this.error('print expects a string literal like print("hi\\n"); use print_int(x) for numbers', arg);
        this.expr(arg);
        return;
      }
      // Identical strings share one .asciiz label.
      let entry = this.strings.find((s) => s.value === arg.value);
      if (!entry) {
        entry = { label: `s_${this.strings.length}`, value: arg.value };
        this.strings.push(entry);
      }
      arg.label = entry.label;
    } else if (arg.kind === 'String') {
      this.error(`${e.name} expects an int; use print("...") for strings`, arg);
    } else {
      this.expr(arg);
    }
  }
}

/** Symbols keep only a position, not the node itself, so the AST has no cycles (it can be JSON-encoded). */
function pos(node) {
  return { line: node.line, col: node.col, length: node.length };
}
