import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peephole, isLive } from '../src/peephole.js';

// Tiny assembler for test input: "op a, b, c" lines, "name:" labels.
function items(text) {
  return text.trim().split('\n').map((line) => {
    const s = line.trim();
    if (s.endsWith(':')) return { type: 'label', name: s.slice(0, -1) };
    const [op, ...rest] = s.split(/\s+/);
    const args = rest.join(' ').split(',').map((a) => a.trim()).filter(Boolean);
    return { type: 'ins', op, args, line: 1, note: '' };
  });
}

function text(code) {
  return code.map((i) => (i.type === 'label' ? `${i.name}:` : `${i.op} ${i.args.join(', ')}`.trim())).join('\n');
}

function optimize(src) {
  return text(peephole(items(src)).code);
}

test('self moves are removed', () => {
  assert.equal(optimize('move $t0, $t0\njr $ra'), 'jr $ra');
});

test('a push followed by a pop becomes a move', () => {
  assert.equal(optimize(`
    li $t0, 1
    addiu $sp, $sp, -4
    sw $t0, 0($sp)
    lw $t1, 0($sp)
    addiu $sp, $sp, 4
    move $a0, $t1
    jal f_x
    f_x:
    jr $ra`), 'li $a0, 1\njal f_x\nf_x:\njr $ra');
});

test('store then load of the same address forwards the value', () => {
  assert.equal(optimize(`
    sw $t0, -12($fp)
    lw $t0, -12($fp)
    sw $t0, -16($fp)
    jr $ra`), 'sw $t0, -12($fp)\nsw $t0, -16($fp)\njr $ra');
});

test('constants become immediates when the temporary is dead', () => {
  assert.equal(optimize('li $t1, 5\naddu $t0, $t0, $t1\nmove $v0, $t0\njr $ra'), 'addiu $v0, $t0, 5\njr $ra');
  assert.equal(optimize('li $t1, 3\nsubu $t0, $t0, $t1\nmove $v0, $t0\njr $ra'), 'addiu $v0, $t0, -3\njr $ra');
  assert.equal(optimize('li $t1, 4\nsllv $t0, $t0, $t1\nmove $v0, $t0\njr $ra'), 'sll $v0, $t0, 4\njr $ra');
  assert.equal(optimize('li $t1, 10\nslt $t0, $t0, $t1\nmove $v0, $t0\njr $ra'), 'slti $v0, $t0, 10\njr $ra');
  // Too big for a 16-bit immediate: unchanged.
  assert.equal(optimize('li $t1, 100000\naddu $v0, $t0, $t1\njr $ra'), 'li $t1, 100000\naddu $v0, $t0, $t1\njr $ra');
});

test('a constant that is still needed is not folded away', () => {
  const src = 'li $t1, 5\naddu $t0, $t0, $t1\nmove $a0, $t1\nli $v0, 1\nsyscall\nmove $v0, $t0\njr $ra';
  assert.match(optimize(src), /li \$t1, 5\naddu/);
});

test('a value computed into a temporary and then moved is computed in place', () => {
  assert.equal(optimize('lw $t0, -12($fp)\nmove $a0, $t0\nli $v0, 1\nsyscall\njr $ra'), 'lw $a0, -12($fp)\nli $v0, 1\nsyscall\njr $ra');
});

test('branch over an unconditional jump is inverted', () => {
  assert.equal(optimize(`
    blt $t0, $t1, L1.skip
    j L2.out
    L1.skip:
    li $v0, 1
    L2.out:
    jr $ra`), 'bge $t0, $t1, L2.out\nli $v0, 1\nL2.out:\njr $ra');
});

test('jumps to the next label and unreachable code are removed', () => {
  assert.equal(optimize('j f_x.ret\nli $v0, 0\nf_x.ret:\njr $ra'), 'f_x.ret:\njr $ra');
});

test('stack adjustments are merged', () => {
  assert.equal(optimize('addiu $sp, $sp, 4\naddiu $sp, $sp, -4\njr $ra'), 'jr $ra');
  assert.equal(optimize('addiu $sp, $sp, -4\naddiu $sp, $sp, -8\njr $ra'), 'addiu $sp, $sp, -12\njr $ra');
});

test('li 0 uses $zero', () => {
  assert.equal(optimize('li $t0, 0\nsw $t0, -12($fp)\njr $ra'), 'sw $zero, -12($fp)\njr $ra');
});

test('liveness follows jumps and branches', () => {
  const code = items(`
    li $t0, 1
    beqz $t1, L1.a
    li $t0, 2
    L1.a:
    move $v0, $t0
    jr $ra`);
  assert.equal(isLive(code, '$t0', 1), true);   // read at L1.a on the branch path
  assert.equal(isLive(code, '$t2', 1), false);
  assert.equal(isLive(code, '$v0', 5), true);   // the result is read by the caller after jr
  // $t registers do not survive a call, so they are dead after jal.
  assert.equal(isLive(items('jal f_x\nmove $v0, $t0\njr $ra'), '$t0', 0), false);
});
