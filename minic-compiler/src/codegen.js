// codegen.js - turn the checked AST into MIPS assembly for the emulator.
//
// Output is a list of items, so the peephole optimiser can work on structure
// instead of text:
//   { type: 'ins', op, args, line, note }   one instruction (line = Mini-C source line)
//   { type: 'label', name }
//   { type: 'comment', text, line }          "# line 12: x = y + 1;"
// printAsm() turns the list into text.
//
// Calling convention (a simplified MIPS O32):
//   * arguments in $a0-$a3 (at most 4), result in $v0
//   * jal saves the return address in $ra; every function saves $ra and the
//     caller's $fp in its frame, so recursion works
//   * $fp points at the top of the current frame; parameters and locals live
//     at fixed negative offsets from it (-12, -16, ...)
//   * $t0-$t7 are caller-saved: live temporaries are pushed on the stack
//     before a call (see RegisterStack.flush)
//
//   higher addresses
//        +----------------------+ <- $fp  (= caller's $sp)
//        | saved $ra            |  -4($fp)
//        | saved caller $fp     |  -8($fp)
//        | param 0 (from $a0)   | -12($fp)
//        | param 1 / locals ... | -16($fp) ...
//        +----------------------+ <- $sp after the prologue
//        | spilled temporaries  |  (pushed/popped while evaluating expressions)
//   lower addresses
//
// Only instructions the emulator supports are generated; add/sub/addi are
// avoided because they trap on overflow (Mini-C ints wrap around, like C on
// real hardware), so addu/subu/addiu are used instead.


const TEMP_REGISTERS = 8; // $t0-$t7 hold the expression stack
const ARG_REGISTERS = ['$a0', '$a1', '$a2', '$a3'];

const BRANCH_FOR = { '==': 'beq', '!=': 'bne', '<': 'blt', '<=': 'ble', '>': 'bgt', '>=': 'bge' };
const NEGATED = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const COMPOUND = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>' };

/**
 * Expression values are kept on a "register stack": the k-th live value lives
 * in $t(k mod 8). Pushing a 9th value spills the deepest register value to the
 * memory stack (it uses the same register), and ensure() reloads spilled
 * values when an operation needs them again. Because operators only ever use
 * the top one or two values, the values that get spilled are the ones needed
 * last - the same idea as the stack cache in a stack machine.
 *
 *   depth   = number of live values
 *   inRegs  = how many of the top values are in registers (the rest are in memory)
 */
class RegisterStack {
  constructor(gen) {
    this.gen = gen;
    this.depth = 0;
    this.inRegs = 0;
    this.maxDepth = 0;
    this.spills = 0;
  }

  reg(slot) {
    return `$t${slot % TEMP_REGISTERS}`;
  }

  /** Register of the value `k` places below the top (0 = top). Call ensure() first. */
  top(k = 0) {
    return this.reg(this.depth - 1 - k);
  }

  /** Reserve a register for a new value and return its name. */
  push() {
    if (this.inRegs === TEMP_REGISTERS) {
      // All 8 registers are busy: spill the deepest one (it shares our register).
      this.gen.pushReg(this.reg(this.depth - TEMP_REGISTERS), 'spill');
      this.inRegs--;
      this.spills++;
    }
    const r = this.reg(this.depth);
    this.depth++;
    this.inRegs++;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    return r;
  }

  /** Make sure the top `n` values are in registers, reloading spilled ones. */
  ensure(n) {
    while (this.inRegs < n) {
      const slot = this.depth - this.inRegs - 1; // the most recently spilled value
      this.gen.popReg(this.reg(slot), 'reload');
      this.inRegs++;
    }
  }

  pop(n = 1) {
    if (this.inRegs < n) throw new Error('register stack: pop of a value that is not in a register');
    this.depth -= n;
    this.inRegs -= n;
  }

  /** Save every value that is in a register (before a call, or before branches inside an expression). */
  flush() {
    for (let slot = this.depth - this.inRegs; slot < this.depth; slot++) {
      this.gen.pushReg(this.reg(slot), 'save');
    }
    this.inRegs = 0;
  }
}

/**
 * @param {object} program checked (and maybe optimised) Program node
 * @param {string} source  the Mini-C source, for the line comments
 * @returns {{ code: object[], data: object[], maxDepth: number, spills: number }}
 */
export function generate(program, source) {
  const gen = new CodeGenerator(source);
  return gen.program(program);
}

class CodeGenerator {
  constructor(source) {
    this.sourceLines = source.split(/\r?\n/);
    this.code = [];
    this.labelCount = 0;
    this.line = null;          // current source line, stored on every instruction
    this.commentedLine = null; // last line that got a "# line N:" comment
    this.loops = [];           // { breakLabel, continueLabel } for break / continue
    this.fn = null;
    this.rs = new RegisterStack(this);
  }

  // -------------------------------------------------------------------------
  // Emitting
  // -------------------------------------------------------------------------
  emit(op, args = [], note = '') {
    this.code.push({ type: 'ins', op, args, line: this.line, note });
  }

  label(name) {
    this.code.push({ type: 'label', name });
  }

  newLabel(what) {
    return `L${++this.labelCount}.${what}`;
  }

  pushReg(reg, why) {
    this.emit('addiu', ['$sp', '$sp', '-4'], `push ${reg} (${why})`);
    this.emit('sw', [reg, '0($sp)']);
  }

  popReg(reg, why) {
    this.emit('lw', [reg, '0($sp)'], `pop ${reg} (${why})`);
    this.emit('addiu', ['$sp', '$sp', '4']);
  }

  /** "# line 12: x = y + 1;" before the code of each new source line. */
  sourceComment(line, prefix = '') {
    this.line = line;
    if (line === this.commentedLine && !prefix) return;
    this.commentedLine = line;
    const text = (this.sourceLines[line - 1] ?? '').trim();
    this.code.push({ type: 'comment', text: `line ${line}: ${prefix}${text}`, line });
  }

  // -------------------------------------------------------------------------
  // Program, data and functions
  // -------------------------------------------------------------------------
  program(p) {
    const data = [];
    for (const g of p.globals) {
      if (g.kind === 'ArrayDecl') {
        data.push({ label: g.symbol.label, values: g.values, size: g.symbol.size, comment: `int ${g.name}[${g.symbol.size}]` });
      } else {
        data.push({ label: g.symbol.label, values: [g.initValue], size: 1, comment: `int ${g.name}` });
      }
    }
    for (const s of p.strings) data.push({ label: s.label, string: s.value });

    // Start-up code: the emulator starts executing at address 0.
    this.label('_start');
    this.emit('jal', ['f_main'], 'call main()');
    this.emit('li', ['$v0', '10'], 'exit');
    this.emit('syscall');

    for (const fn of p.functions) this.function(fn);
    return { code: this.code, data, maxDepth: this.rs.maxDepth, spills: this.rs.spills };
  }

  function(fn) {
    this.fn = fn;
    const frame = fn.frameSize;
    const params = fn.params.map((x) => `int ${x.name}`).join(', ');
    this.line = fn.line;
    this.commentedLine = fn.line;
    this.code.push({ type: 'comment', text: '', line: null });
    this.code.push({ type: 'comment', text: `int ${fn.name}(${params})   frame: ${frame} bytes`, line: fn.line });
    this.label(fn.symbol.label);

    // Prologue: make the frame, save $ra and the caller's $fp, set up our $fp.
    this.emit('addiu', ['$sp', '$sp', String(-frame)], 'prologue: allocate frame');
    this.emit('sw', ['$ra', `${frame - 4}($sp)`], 'save return address');
    this.emit('sw', ['$fp', `${frame - 8}($sp)`], "save caller's frame pointer");
    this.emit('addiu', ['$fp', '$sp', String(frame)], '$fp = top of this frame');
    fn.paramSymbols.forEach((symbol, i) => {
      this.emit('sw', [ARG_REGISTERS[i], `${symbol.offset}($fp)`], `parameter ${symbol.name}`);
    });

    for (const s of fn.body.body) this.statement(s);

    // Falling off the end of a function returns 0. The epilogue belongs to
    // the function's own line (where the closing } of the body would be).
    this.line = fn.line;
    this.emit('li', ['$v0', '0'], 'no return: result is 0');
    this.label(`${fn.symbol.label}.ret`);
    // Epilogue: the mirror image of the prologue. $sp is back at the frame
    // bottom here, because every expression push has been popped.
    this.emit('lw', ['$ra', `${frame - 4}($sp)`], 'epilogue: restore $ra');
    this.emit('lw', ['$fp', `${frame - 8}($sp)`], "restore caller's $fp");
    this.emit('addiu', ['$sp', '$sp', String(frame)], 'free the frame');
    this.emit('jr', ['$ra'], 'return');
    this.fn = null;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------
  statement(s) {
    if (s.kind !== 'Block' && s.kind !== 'Empty') this.sourceComment(s.line);
    switch (s.kind) {
      case 'Block':
        for (const inner of s.body) this.statement(inner);
        break;
      case 'Empty':
        break;
      case 'DeclStmt':
        for (const d of s.decls) {
          if (d.init) {
            const r = this.value(d.init);
            this.emit('sw', [r, `${d.symbol.offset}($fp)`], d.name);
            this.rs.pop();
          } else {
            this.emit('sw', ['$zero', `${d.symbol.offset}($fp)`], `${d.name} = 0`);
          }
        }
        break;
      case 'Assign':
        this.assign(s);
        break;
      case 'ExprStmt':
        this.exprStatement(s.expr);
        break;
      case 'If':
        this.ifStatement(s);
        break;
      case 'While':
        this.loop(s, null, s.cond, null, s.body);
        break;
      case 'For':
        this.loop(s, s.init, s.cond, s.update, s.body);
        break;
      case 'Break':
        this.emit('j', [this.loops[this.loops.length - 1].breakLabel], 'break');
        break;
      case 'Continue':
        this.emit('j', [this.loops[this.loops.length - 1].continueLabel], 'continue');
        break;
      case 'Return': {
        const r = this.value(s.value);
        this.emit('move', ['$v0', r], 'return value');
        this.rs.pop();
        this.emit('j', [`${this.fn.symbol.label}.ret`]);
        break;
      }
      default:
        throw new Error(`codegen: unknown statement ${s.kind}`);
    }
  }

  ifStatement(s) {
    const elseLabel = s.else ? this.newLabel('else') : null;
    const endLabel = this.newLabel('endif');
    this.branch(s.cond, elseLabel ?? endLabel, false); // skip the then-part when false
    this.statement(s.then);
    if (s.else) {
      this.emit('j', [endLabel]);
      this.label(elseLabel);
      this.statement(s.else);
    }
    this.label(endLabel);
  }

  /**
   * while and for loops use the "test at the bottom" layout, so each
   * iteration runs one conditional branch instead of a branch plus a jump:
   *
   *         init
   *         j     cond
   *   body: ...loop body...
   *   cont: update            (continue jumps here)
   *   cond: if (cond) goto body
   *   end:                    (break jumps here)
   */
  loop(s, init, cond, update, body) {
    if (init) this.statement(init);
    const bodyLabel = this.newLabel('loop');
    const contLabel = this.newLabel('next');
    const condLabel = this.newLabel('cond');
    const endLabel = this.newLabel('endloop');
    this.line = s.line;
    this.emit('j', [condLabel], 'test the condition first');
    this.label(bodyLabel);
    this.loops.push({ breakLabel: endLabel, continueLabel: contLabel });
    this.statement(body);
    this.loops.pop();
    this.label(contLabel);
    if (update) {
      this.sourceComment(s.line, '(update) ');
      this.statement(update);
    }
    this.label(condLabel);
    this.sourceComment(s.line, '(condition) ');
    if (cond) this.branch(cond, bodyLabel, true);
    else this.emit('j', [bodyLabel], 'no condition: loop forever');
    this.label(endLabel);
  }

  assign(s) {
    const t = s.target;
    const op = COMPOUND[s.op] ?? null;
    if (t.kind === 'Identifier') {
      if (op === null) {
        this.expr(s.value);
      } else {
        this.loadVariable(t);          // current value
        this.expr(s.value);
        this.rs.ensure(2);
        this.binaryOp(op, this.rs.top(1), this.rs.top(0));
        this.rs.pop();
      }
      this.rs.ensure(1);
      this.storeVariable(t, this.rs.top());
      this.rs.pop();
      return;
    }

    // Array element: compute the address once, then load/modify/store through it.
    this.elementAddress(t);
    if (op === null) {
      this.expr(s.value);
      this.rs.ensure(2);
      this.emit('sw', [this.rs.top(0), `0(${this.rs.top(1)})`], `${t.name}[...] = value`);
      this.rs.pop(2);
      return;
    }
    const old = this.rs.push();
    this.rs.ensure(2);
    this.emit('lw', [old, `0(${this.rs.top(1)})`], `${t.name}[...]`);
    this.expr(s.value);
    this.rs.ensure(3);
    this.binaryOp(op, this.rs.top(1), this.rs.top(0));
    this.rs.pop();
    this.emit('sw', [this.rs.top(0), `0(${this.rs.top(1)})`], `store ${t.name}[...]`);
    this.rs.pop(2);
  }

  exprStatement(e) {
    if (e.kind === 'Call' && e.symbol.kind === 'builtin') {
      this.builtin(e);
      return;
    }
    this.expr(e);   // evaluate for its side effects (a call), then drop the value
    this.rs.ensure(1);
    this.rs.pop();
  }

  /** print_int / print_char / print: a syscall, which does not touch $t registers. */
  builtin(e) {
    const { name, symbol } = e;
    const arg = e.args[0];
    if (name === 'print') {
      this.emit('la', ['$a0', arg.label], JSON.stringify(arg.value));
    } else {
      const r = this.value(arg);
      this.emit('move', ['$a0', r]);
      this.rs.pop();
    }
    this.emit('li', ['$v0', String(symbol.syscall)], `syscall ${symbol.syscall}: ${name}`);
    this.emit('syscall');
  }

  // -------------------------------------------------------------------------
  // Variables
  // -------------------------------------------------------------------------
  loadVariable(e) {
    const symbol = e.symbol;
    const r = this.rs.push();
    if (symbol.kind === 'local') {
      this.emit('lw', [r, `${symbol.offset}($fp)`], e.name);
    } else {
      this.emit('la', [r, symbol.label], `&${e.name}`);
      this.emit('lw', [r, `0(${r})`], e.name);
    }
  }

  storeVariable(e, r) {
    const symbol = e.symbol;
    if (symbol.kind === 'local') {
      this.emit('sw', [r, `${symbol.offset}($fp)`], `${e.name} = ...`);
    } else {
      const addr = this.rs.push();
      this.emit('la', [addr, symbol.label], `&${e.name}`);
      this.emit('sw', [r, `0(${addr})`], `${e.name} = ...`);
      this.rs.pop();
    }
  }

  /** Push the address of a[i]: &a + 4 * i. */
  elementAddress(e) {
    this.expr(e.index);
    this.rs.ensure(1);
    const index = this.rs.top();
    this.emit('sll', [index, index, '2'], 'index * 4 (bytes per int)');
    const base = this.rs.push();
    this.rs.ensure(2);
    this.emit('la', [base, e.symbol.label], `&${e.name}`);
    this.emit('addu', [this.rs.top(1), this.rs.top(1), base], `&${e.name}[...]`);
    this.rs.pop();
  }

  // -------------------------------------------------------------------------
  // Expressions: each one pushes exactly one value on the register stack
  // -------------------------------------------------------------------------
  /** Evaluate `e` and return the register holding the result (still on the stack). */
  value(e) {
    this.expr(e);
    this.rs.ensure(1);
    return this.rs.top();
  }

  expr(e) {
    switch (e.kind) {
      case 'Number': {
        const r = this.rs.push();
        const note = e.text && e.text !== String(e.value) ? e.text : '';
        this.emit('li', [r, String(e.value)], note);
        return;
      }
      case 'Identifier':
        this.loadVariable(e);
        return;
      case 'Index': {
        const offset = e.index.kind === 'Number' ? e.index.value * 4 : null;
        if (offset !== null && offset <= 32767) {
          // Constant index: fold it into the load's offset.
          const r = this.rs.push();
          this.emit('la', [r, e.symbol.label], `&${e.name}`);
          this.emit('lw', [r, `${offset}(${r})`], `${e.name}[${e.index.value}]`);
          return;
        }
        this.elementAddress(e);
        this.rs.ensure(1);
        this.emit('lw', [this.rs.top(), `0(${this.rs.top()})`], `${e.name}[...]`);
        return;
      }
      case 'Unary': {
        const r = this.value(e.operand);
        if (e.op === '-') this.emit('subu', [r, '$zero', r], 'negate');
        else if (e.op === '~') this.emit('nor', [r, r, '$zero'], 'bitwise not');
        else this.emit('sltiu', [r, r, '1'], 'logical not: r == 0');
        return;
      }
      case 'Binary':
        if (e.op === '&&' || e.op === '||') {
          this.logicalValue(e);
          return;
        }
        this.expr(e.left);
        this.expr(e.right);
        this.rs.ensure(2);
        this.binaryOp(e.op, this.rs.top(1), this.rs.top(0));
        this.rs.pop();
        return;
      case 'Call':
        this.call(e);
        return;
      default:
        throw new Error(`codegen: unknown expression ${e.kind}`);
    }
  }

  /** a = a OP b for every Mini-C binary operator (a and b are registers). */
  binaryOp(op, a, b) {
    switch (op) {
      case '+': this.emit('addu', [a, a, b]); break;
      case '-': this.emit('subu', [a, a, b]); break;
      case '*': this.emit('mul', [a, a, b]); break;
      case '/': this.emit('div', [a, b]); this.emit('mflo', [a], 'quotient'); break;
      case '%': this.emit('div', [a, b]); this.emit('mfhi', [a], 'remainder'); break;
      case '<<': this.emit('sllv', [a, a, b]); break;
      case '>>': this.emit('srav', [a, a, b], 'arithmetic shift (int is signed)'); break;
      case '&': this.emit('and', [a, a, b]); break;
      case '|': this.emit('or', [a, a, b]); break;
      case '^': this.emit('xor', [a, a, b]); break;
      case '<': this.emit('slt', [a, a, b]); break;
      case '>': this.emit('slt', [a, b, a]); break;
      case '<=': this.emit('slt', [a, b, a]); this.emit('xori', [a, a, '1'], 'a <= b  is  !(b < a)'); break;
      case '>=': this.emit('slt', [a, a, b]); this.emit('xori', [a, a, '1'], 'a >= b  is  !(a < b)'); break;
      case '==': this.emit('xor', [a, a, b]); this.emit('sltiu', [a, a, '1'], 'equal: (a ^ b) == 0'); break;
      case '!=': this.emit('xor', [a, a, b]); this.emit('sltu', [a, '$zero', a], 'not equal: (a ^ b) != 0'); break;
      default: throw new Error(`codegen: unknown operator ${op}`);
    }
  }

  /**
   * && / || as a value (0 or 1). The branches must see the same register
   * stack state on every path, so live values are flushed to memory first.
   */
  logicalValue(e) {
    this.rs.flush();
    const falseLabel = this.newLabel('false');
    const endLabel = this.newLabel('bool');
    this.branch(e, falseLabel, false);
    const r = this.rs.push();
    this.emit('li', [r, '1']);
    this.emit('j', [endLabel]);
    this.label(falseLabel);
    this.emit('li', [r, '0']);
    this.label(endLabel);
  }

  /**
   * Jump to `target` if `e` is true (whenTrue) or false (!whenTrue).
   * Conditions compile straight to compare-and-branch instructions (blt, bge,
   * ...) and && / || short-circuit by jumping instead of computing 0/1.
   */
  branch(e, target, whenTrue) {
    if (e.kind === 'Number') {
      if ((e.value !== 0) === whenTrue) this.emit('j', [target], 'constant condition');
      return;
    }
    if (e.kind === 'Unary' && e.op === '!') {
      this.branch(e.operand, target, !whenTrue);
      return;
    }
    if (e.kind === 'Binary' && (e.op === '&&' || e.op === '||')) {
      // "jump if (a && b) is false" = jump if a is false, or if b is false.
      // "jump if (a && b) is true"  = skip if a is false, then jump if b is true.
      const and = e.op === '&&';
      if (and !== whenTrue) {
        this.branch(e.left, target, whenTrue);
        this.branch(e.right, target, whenTrue);
      } else {
        const skip = this.newLabel('skip');
        this.branch(e.left, skip, !whenTrue);
        this.branch(e.right, target, whenTrue);
        this.label(skip);
      }
      return;
    }
    if (e.kind === 'Binary' && BRANCH_FOR[e.op]) {
      const op = whenTrue ? e.op : NEGATED[e.op];
      this.expr(e.left);
      if (e.right.kind === 'Number' && e.right.value === 0) {
        // Comparing with 0: use $zero instead of loading the constant.
        this.rs.ensure(1);
        const a = this.rs.top();
        this.rs.pop();
        this.emit(BRANCH_FOR[op], [a, '$zero', target]);
        return;
      }
      this.expr(e.right);
      this.rs.ensure(2);
      const a = this.rs.top(1);
      const b = this.rs.top(0);
      this.rs.pop(2);
      this.emit(BRANCH_FOR[op], [a, b, target]);
      return;
    }
    const r = this.value(e);
    this.rs.pop();
    this.emit(whenTrue ? 'bnez' : 'beqz', [r, target]);
  }

  /**
   * Call a user function:
   *   1. save live temporaries ($t registers are caller-saved),
   *   2. evaluate the arguments left to right,
   *   3. move them into $a0-$a3 and jal,
   *   4. the result comes back in $v0.
   */
  call(e) {
    this.rs.flush();
    for (const arg of e.args) this.expr(arg);
    const n = e.args.length;
    this.rs.ensure(n);
    for (let i = 0; i < n; i++) {
      this.emit('move', [ARG_REGISTERS[i], this.rs.top(n - 1 - i)], `argument ${i + 1}`);
    }
    this.rs.pop(n);
    this.emit('jal', [e.symbol.label], `call ${e.name}()`);
    const r = this.rs.push();
    this.emit('move', [r, '$v0'], 'result');
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/**
 * Render items as assembly text.
 * @returns {{ asm: string, lineMap: (number|null)[] }} lineMap[i] = Mini-C line of asm line i
 */
export function printAsm(code, data, header = []) {
  const out = [];
  const map = [];
  const add = (text, line = null) => {
    out.push(text);
    map.push(line);
  };

  for (const h of header) add(`# ${h}`);
  add('');
  add('        .data');
  if (data.length === 0) add('        # (no global data)');
  for (const d of data) {
    const label = `${d.label}:`;
    const pad = label.length < 8 ? label.padEnd(8) : `${label} `;
    if (d.string !== undefined) {
      add(`${pad}.asciiz ${quote(d.string)}`);
      continue;
    }
    const comment = d.comment ? `   # ${d.comment}` : '';
    const values = d.values;
    if (values.length === d.size) {
      add(`${pad}.word   ${values.join(', ')}${comment}`);
    } else if (values.length === 0) {
      add(`${pad}.space  ${d.size * 4}${comment}`);
    } else {
      add(`${pad}.word   ${values.join(', ')}${comment}`);
      add(`        .space  ${(d.size - values.length) * 4}   # the rest are 0`);
    }
  }
  add('');
  add('        .text');

  for (const item of code) {
    if (item.type === 'label') {
      add(`${item.name}:`);
    } else if (item.type === 'comment') {
      add(item.text === '' ? '' : `    # ${item.text}`, item.line);
    } else {
      const text = `        ${item.op.padEnd(6)}${item.args.join(', ')}`;
      add(item.note ? `${text.padEnd(36)}# ${item.note}` : text, item.line);
    }
  }
  return { asm: out.join('\n') + '\n', lineMap: map };
}

/** A string as an .asciiz literal the emulator's assembler understands. */
function quote(value) {
  const escapes = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\0': '\\0', '\\': '\\\\', '"': '\\"' };
  return `"${value.replace(/[\n\t\r\0\\"]/g, (c) => escapes[c])}"`;
}

