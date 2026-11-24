// peephole.js - small, safe rewrites on the generated instruction list (-O1).
//
// A peephole optimiser looks at a few neighbouring instructions at a time and
// replaces patterns with something cheaper. Each rule below is local and easy
// to check by hand. Rules that delete or retarget a register write first ask
// isLive() whether anything can still read that register, so they never
// change what the program computes.
//
// The list is processed until no rule fires any more (a "fixpoint"), because
// one rewrite often exposes another (e.g. removing a dead jump makes two
// instructions adjacent).

// ---------------------------------------------------------------------------
// What each instruction reads and writes
// ---------------------------------------------------------------------------
const THREE_REG = new Set(['addu', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu', 'mul', 'add', 'sub', 'sllv', 'srlv', 'srav']);
const REG_IMM = new Set(['addiu', 'addi', 'slti', 'sltiu', 'andi', 'ori', 'xori', 'sll', 'srl', 'sra']);
const LOADS = new Set(['lw', 'lb', 'lbu']);
const STORES = new Set(['sw', 'sb']);
const BRANCH2 = new Set(['beq', 'bne', 'blt', 'bge', 'bgt', 'ble']);
const BRANCH1 = new Set(['beqz', 'bnez']);
// Instructions that only compute a value into their first operand (no memory
// access, no other effect). Deleting one whose result is never read is safe.
const PURE = new Set([...THREE_REG, ...REG_IMM, 'move', 'li', 'la', 'lui', 'mfhi', 'mflo']);
PURE.delete('add'); PURE.delete('sub'); PURE.delete('addi'); // these can trap on overflow

const TEMPS = ['$t0', '$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9'];
const ARGS = ['$a0', '$a1', '$a2', '$a3'];
const CALL_CLOBBERS = [...TEMPS, ...ARGS, '$v0', '$v1', '$ra'];

const INVERT = { beq: 'bne', bne: 'beq', blt: 'bge', bge: 'blt', bgt: 'ble', ble: 'bgt', beqz: 'bnez', bnez: 'beqz' };

/** Base register of a memory operand: "-12($fp)" -> "$fp". */
function baseOf(mem) {
  return /\((\$\w+)\)/.exec(mem)?.[1] ?? null;
}

/**
 * @returns {{reads: string[], writes: string[], flow: 'next'|'jump'|'branch'|'return'|'call', target?: string}}
 */
export function effects(ins) {
  const a = ins.args;
  const op = ins.op;
  if (THREE_REG.has(op)) return { reads: [a[1], a[2]], writes: [a[0]], flow: 'next' };
  if (REG_IMM.has(op)) return { reads: [a[1]], writes: [a[0]], flow: 'next' };
  if (op === 'move') return { reads: [a[1]], writes: [a[0]], flow: 'next' };
  if (op === 'li' || op === 'la' || op === 'lui') return { reads: [], writes: [a[0]], flow: 'next' };
  if (LOADS.has(op)) return { reads: [baseOf(a[1])], writes: [a[0]], flow: 'next' };
  if (STORES.has(op)) return { reads: [a[0], baseOf(a[1])], writes: [], flow: 'next' };
  if (['mult', 'multu', 'div', 'divu'].includes(op)) return { reads: [a[0], a[1]], writes: ['hi', 'lo'], flow: 'next' };
  if (op === 'mfhi') return { reads: ['hi'], writes: [a[0]], flow: 'next' };
  if (op === 'mflo') return { reads: ['lo'], writes: [a[0]], flow: 'next' };
  if (BRANCH2.has(op)) return { reads: [a[0], a[1]], writes: [], flow: 'branch', target: a[2] };
  if (BRANCH1.has(op)) return { reads: [a[0]], writes: [], flow: 'branch', target: a[1] };
  if (op === 'j' || op === 'b') return { reads: [], writes: [], flow: 'jump', target: a[0] };
  if (op === 'jal') return { reads: [...ARGS], writes: CALL_CLOBBERS, flow: 'call' };
  if (op === 'jr') return { reads: [a[0], '$v0'], writes: [], flow: 'return' }; // $v0 carries the result
  if (op === 'syscall') return { reads: ['$v0', '$a0'], writes: [], flow: 'next' };
  if (op === 'nop') return { reads: [], writes: [], flow: 'next' };
  throw new Error(`peephole: unknown instruction ${op}`);
}

/**
 * Can the value in `reg` just before code[start] still be read?
 * A depth-first walk along every control-flow path: a path that reads `reg`
 * makes it live; a path that overwrites it first (or returns) ends.
 * Unknown situations are answered "live", which is always safe.
 */
export function isLive(code, reg, start) {
  const visited = new Set();
  const work = [start];
  while (work.length > 0) {
    for (let i = work.pop(); i < code.length; i++) {
      if (visited.has(i)) break;
      visited.add(i);
      const item = code[i];
      if (item.type !== 'ins') continue; // labels and comments do not matter here
      const fx = effects(item);
      if (fx.reads.includes(reg)) return true;
      if (fx.writes.includes(reg)) break;
      if (fx.flow === 'return') break;
      if (fx.flow === 'jump' || fx.flow === 'branch') {
        const target = findLabel(code, fx.target);
        if (target < 0) return true; // jumping somewhere unknown: be safe
        work.push(target);
        if (fx.flow === 'jump') break;
      }
    }
  }
  return false;
}

function findLabel(code, name) {
  return code.findIndex((item) => item.type === 'label' && item.name === name);
}

/** Index of the next instruction after i, skipping comments; -1 if a label (or the end) comes first. */
function nextIns(code, i) {
  for (let j = i + 1; j < code.length; j++) {
    if (code[j].type === 'ins') return j;
    if (code[j].type === 'label') return -1;
  }
  return -1;
}

const isTemp = (reg) => TEMPS.includes(reg);
const fits16 = (n) => n >= -32768 && n <= 32767;
const fitsU16 = (n) => n >= 0 && n <= 65535;

// ---------------------------------------------------------------------------
// The rules. Each one tries to apply at position i and returns true if it
// changed the code.
// ---------------------------------------------------------------------------
const RULES = [
  {
    name: 'self-move',             // move $t0, $t0  ->  (nothing)
    apply(code, i) {
      const x = code[i];
      if (x.op !== 'move' || x.args[0] !== x.args[1]) return false;
      code.splice(i, 1);
      return true;
    },
  },
  {
    name: 'push-pop',              // push R; pop S  ->  move S, R
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'addiu' || a.args.join() !== '$sp,$sp,-4') return false;
      const j = nextIns(code, i);
      const k = j < 0 ? -1 : nextIns(code, j);
      const l = k < 0 ? -1 : nextIns(code, k);
      if (l < 0) return false;
      const [b, c, d] = [code[j], code[k], code[l]];
      if (b.op !== 'sw' || b.args[1] !== '0($sp)' || c.op !== 'lw' || c.args[1] !== '0($sp)') return false;
      if (d.op !== 'addiu' || d.args.join() !== '$sp,$sp,4') return false;
      const replacement = { ...c, op: 'move', args: [c.args[0], b.args[0]], note: 'push/pop pair removed' };
      code.splice(l, 1);
      code.splice(k, 1, replacement);
      code.splice(j, 1);
      code.splice(i, 1);
      return true;
    },
  },
  {
    name: 'store-load',            // sw R, X; lw S, X  ->  sw R, X; move S, R
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'sw') return false;
      const j = nextIns(code, i);
      if (j < 0) return false;
      const b = code[j];
      if (b.op !== 'lw' || b.args[1] !== a.args[1]) return false;
      if (b.args[0] === a.args[0]) code.splice(j, 1);
      else code[j] = { ...b, op: 'move', args: [b.args[0], a.args[0]], note: 'value is still in a register' };
      return true;
    },
  },
  {
    name: 'zero-register',         // li T, 0; op ..., T  ->  op ..., $zero
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'li' || a.args[1] !== '0' || !isTemp(a.args[0])) return false;
      const j = nextIns(code, i);
      if (j < 0) return false;
      const b = code[j];
      const T = a.args[0];
      // Only plain register source operands are replaced (not memory bases).
      let sources;
      if (THREE_REG.has(b.op)) sources = [1, 2];
      else if (REG_IMM.has(b.op) || b.op === 'move') sources = [1];
      else if (b.op === 'sw' || b.op === 'sb') sources = [0];
      else if (BRANCH2.has(b.op)) sources = [0, 1];
      else return false;
      if (!sources.some((s) => b.args[s] === T)) return false;
      const writesT = effects(b).writes.includes(T);
      if (!writesT && isLive(code, T, j + 1)) return false;
      const args = b.args.map((arg, s) => (sources.includes(s) && arg === T ? '$zero' : arg));
      code[j] = { ...b, args };
      code.splice(i, 1);
      return true;
    },
  },
  {
    name: 'immediate',             // li T, 5; addu D, A, T  ->  addiu D, A, 5
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'li' || !isTemp(a.args[0])) return false;
      const c = Number(a.args[1]);
      const T = a.args[0];
      const j = nextIns(code, i);
      if (j < 0) return false;
      const b = code[j];
      const [D, X, Y] = b.args;
      let other = null; // the non-constant operand
      if (Y === T && X !== T) other = X;
      else if (X === T && Y !== T && ['addu', 'and', 'or', 'xor'].includes(b.op)) other = Y; // commutative
      if (other === null) return false;

      let replacement = null;
      switch (b.op) {
        case 'addu': if (fits16(c)) replacement = ['addiu', c]; break;
        case 'subu': if (Y === T && fits16(-c)) replacement = ['addiu', -c]; break;
        case 'and': if (fitsU16(c)) replacement = ['andi', c]; break;
        case 'or': if (fitsU16(c)) replacement = ['ori', c]; break;
        case 'xor': if (fitsU16(c)) replacement = ['xori', c]; break;
        case 'slt': if (Y === T && fits16(c)) replacement = ['slti', c]; break;
        case 'sltu': if (Y === T && fits16(c)) replacement = ['sltiu', c]; break;
        case 'sllv': if (Y === T) replacement = ['sll', c & 31]; break;
        case 'srlv': if (Y === T) replacement = ['srl', c & 31]; break;
        case 'srav': if (Y === T) replacement = ['sra', c & 31]; break;
        default: break;
      }
      if (!replacement) return false;
      if (D !== T && isLive(code, T, j + 1)) return false; // someone still needs T = c
      code[j] = { ...b, op: replacement[0], args: [D, other, String(replacement[1])] };
      code.splice(i, 1);
      return true;
    },
  },
  {
    name: 'retarget',              // lw T, X; move S, T  ->  lw S, X   (T dead afterwards)
    apply(code, i) {
      const a = code[i];
      if (!(PURE.has(a.op) || LOADS.has(a.op)) || !isTemp(a.args[0])) return false;
      const j = nextIns(code, i);
      if (j < 0) return false;
      const b = code[j];
      const T = a.args[0];
      if (b.op !== 'move' || b.args[1] !== T || b.args[0] === T) return false;
      if (isLive(code, T, j + 1)) return false;
      code[i] = { ...a, args: [b.args[0], ...a.args.slice(1)], note: a.note || b.note };
      code.splice(j, 1);
      return true;
    },
  },
  {
    name: 'dead-temp',             // move $t0, $v0  where $t0 is never read  ->  (nothing)
    apply(code, i) {
      const a = code[i];
      if (!PURE.has(a.op) || !isTemp(a.args[0])) return false;
      if (isLive(code, a.args[0], i + 1)) return false;
      code.splice(i, 1);
      return true;
    },
  },
  {
    name: 'branch-over-jump',      // beq a, b, L1; j L2; L1:  ->  bne a, b, L2; L1:
    apply(code, i) {
      const a = code[i];
      if (!INVERT[a.op]) return false;
      const j = nextIns(code, i);
      if (j < 0 || code[j].op !== 'j') return false;
      const target = a.args[a.args.length - 1];
      if (!labelsAfter(code, j).includes(target)) return false;
      code[i] = { ...a, op: INVERT[a.op], args: [...a.args.slice(0, -1), code[j].args[0]] };
      code.splice(j, 1);
      return true;
    },
  },
  {
    name: 'jump-to-next',          // j L; L:  ->  L:   (also for a branch to the next label)
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'j' && !INVERT[a.op]) return false;
      if (!labelsAfter(code, i).includes(a.args[a.args.length - 1])) return false;
      code.splice(i, 1);
      return true;
    },
  },
  {
    name: 'unreachable',           // code after j / jr up to the next label can never run
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'j' && a.op !== 'jr') return false;
      let end = i + 1;
      while (end < code.length && code[end].type !== 'label') end++;
      const dead = code.slice(i + 1, end);
      if (!dead.some((item) => item.type === 'ins')) return false;
      code.splice(i + 1, end - i - 1);
      return true;
    },
  },
  {
    name: 'merge-sp',              // addiu $sp,$sp,4; addiu $sp,$sp,-4  ->  (nothing)
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'addiu' || a.args[0] !== '$sp' || a.args[1] !== '$sp') return false;
      const j = nextIns(code, i);
      if (j < 0) return false;
      const b = code[j];
      if (b.op !== 'addiu' || b.args[0] !== '$sp' || b.args[1] !== '$sp') return false;
      const total = Number(a.args[2]) + Number(b.args[2]);
      if (!fits16(total)) return false;
      code.splice(j, 1);
      if (total === 0) code.splice(i, 1);
      else code[i] = { ...a, args: ['$sp', '$sp', String(total)] };
      return true;
    },
  },
  {
    name: 'add-zero',              // addiu R, R, 0  ->  (nothing)
    apply(code, i) {
      const a = code[i];
      if (a.op !== 'addiu' || a.args[0] !== a.args[1] || Number(a.args[2]) !== 0) return false;
      code.splice(i, 1);
      return true;
    },
  },
  {
    name: 'unused-label',          // compiler-made labels nothing jumps to
    apply(code, i) {
      const a = code[i];
      if (a.type !== 'label' || !/^L\d+\./.test(a.name)) return false;
      if (code.some((item) => item.type === 'ins' && item.args.includes(a.name))) return false;
      code.splice(i, 1);
      return true;
    },
  },
];

/** Labels that directly follow position i (only comments may be in between). */
function labelsAfter(code, i) {
  const names = [];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j].type === 'label') names.push(code[j].name);
    else if (code[j].type === 'ins') break;
  }
  return names;
}

export const RULE_NAMES = RULES.map((r) => r.name);

/**
 * Run all rules until nothing changes.
 * @param {object[]} input items from codegen (not modified)
 * @returns {{ code: object[], stats: Record<string, number> }}
 */
export function peephole(input) {
  const code = input.map((item) => ({ ...item }));
  const stats = Object.fromEntries(RULE_NAMES.map((n) => [n, 0]));
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    for (let i = 0; i < code.length; i++) {
      for (const rule of RULES) {
        if (i < code.length && (code[i].type === 'ins' || rule.name === 'unused-label') && rule.apply(code, i)) {
          stats[rule.name]++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { code, stats };
}
