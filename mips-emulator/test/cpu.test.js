import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CPU, decode } from '../src/cpu.js';
import { MipsError } from '../src/errors.js';
import { STACK_TOP } from '../src/isa.js';
import { load, run, runCode, R } from './helpers.js';

/** Signed value of a register, to compare against negative numbers. */
const s = (cpu, reg) => cpu.regs[reg] | 0;

/** Assert that running `source` throws a MipsError on `line` matching `pattern`. */
function assertRunError(source, line, pattern) {
  const { cpu } = load(source);
  assert.throws(() => cpu.run(1000), (err) => {
    assert.ok(err instanceof MipsError, `expected MipsError, got ${err}`);
    assert.match(err.message, pattern);
    assert.equal(err.line, line, `line number for: ${err.message}`);
    return true;
  });
  assert.equal(cpu.halted, true);
}

test('decode splits a word into its fields', () => {
  const d = decode(0xca050008); // bge $s0, $a1, +8
  assert.equal(d.opcode, 0b110010);
  assert.equal(d.rs, 16);
  assert.equal(d.rt, 5);
  assert.equal(d.simm, 8);
  const neg = decode(0x23bdfff8); // addi $sp, $sp, -8
  assert.equal(neg.simm, -8);
  assert.equal(neg.imm, 0xfff8);
  const r = decode(0x00094100); // sll $t0, $t1, 4
  assert.deepEqual([r.opcode, r.rt, r.rd, r.shamt, r.funct], [0, 9, 8, 4, 0]);
});

test('initial state: PC = 0, $sp at the top of memory, everything else 0', () => {
  const cpu = new CPU();
  assert.equal(cpu.pc, 0);
  assert.equal(cpu.regs[R.sp], STACK_TOP);
  assert.equal(cpu.regs[R.t0], 0);
  assert.equal(cpu.hi, 0);
  assert.equal(cpu.lo, 0);
});

test('step() fetches, advances PC by 4 and executes one instruction', () => {
  const { cpu } = load('addi $t0, $zero, 7\naddi $t1, $t0, 1');
  const first = cpu.step();
  assert.deepEqual(first, { pc: 0, word: 0x20080007, line: 1 });
  assert.equal(cpu.pc, 4);
  assert.equal(cpu.regs[R.t0], 7);
  cpu.step();
  assert.equal(cpu.regs[R.t1], 8);
  assert.equal(cpu.steps, 2);
  // running past the last instruction halts the program
  assert.equal(cpu.step(), null);
  assert.equal(cpu.halted, true);
  assert.match(cpu.haltReason, /end of the program/);
  assert.equal(cpu.step(), null);
});

test('$zero is hard-wired to 0', () => {
  const cpu = runCode('addi $zero, $zero, 5\nlui $zero, 0xFFFF\nadd $t0, $zero, $zero');
  assert.equal(cpu.regs[R.zero], 0);
  assert.equal(cpu.regs[R.t0], 0);
});

test('R-type arithmetic: add addu sub subu', () => {
  const cpu = runCode(`
    li   $t0, 100
    li   $t1, -30
    add  $s0, $t0, $t1
    sub  $s1, $t0, $t1
    li   $t2, 0xFFFFFFFF
    addu $s2, $t2, $t2      # wraps, no trap
    subu $s3, $zero, $t0
  `);
  assert.equal(s(cpu, R.s0), 70);
  assert.equal(s(cpu, R.s1), 130);
  assert.equal(cpu.regs[R.s2], 0xfffffffe);
  assert.equal(s(cpu, R.s3), -100);
});

test('R-type logic: and or xor nor', () => {
  const cpu = runCode(`
    li  $t0, 0x0F0F
    li  $t1, 0x00FF
    and $s0, $t0, $t1
    or  $s1, $t0, $t1
    xor $s2, $t0, $t1
    nor $s3, $t0, $t1
  `);
  assert.equal(cpu.regs[R.s0], 0x000f);
  assert.equal(cpu.regs[R.s1], 0x0fff);
  assert.equal(cpu.regs[R.s2], 0x0ff0);
  assert.equal(cpu.regs[R.s3], 0xfffff000);
});

test('slt and sltu compare signed and unsigned', () => {
  const cpu = runCode(`
    li   $t0, -1
    li   $t1, 1
    slt  $s0, $t0, $t1    # -1 < 1         -> 1
    sltu $s1, $t0, $t1    # 0xFFFFFFFF < 1 -> 0
    slt  $s2, $t1, $t0    # 0
    sltu $s3, $t1, $t0    # 1
  `);
  assert.deepEqual([R.s0, R.s1, R.s2, R.s3].map((r) => cpu.regs[r]), [1, 0, 0, 1]);
});

test('shifts: sll srl sra sllv srlv srav', () => {
  const cpu = runCode(`
    li   $t0, 0x80000010
    sll  $s0, $t0, 4
    srl  $s1, $t0, 4
    sra  $s2, $t0, 4
    li   $t1, 8
    sllv $s3, $t0, $t1
    srlv $s4, $t0, $t1
    srav $s5, $t0, $t1
  `);
  assert.equal(cpu.regs[R.s0], 0x00000100);
  assert.equal(cpu.regs[R.s1], 0x08000001);
  assert.equal(cpu.regs[R.s2], 0xf8000001);
  assert.equal(cpu.regs[R.s3], 0x00001000);
  assert.equal(cpu.regs[R.s4], 0x00800000);
  assert.equal(cpu.regs[R.s5], 0xff800000);
});

test('mult multu div divu mfhi mflo mul', () => {
  const cpu = runCode(`
    li    $t0, -6
    li    $t1, 7
    mult  $t0, $t1
    mflo  $s0             # -42
    mfhi  $s1             # sign extension of -42 -> 0xFFFFFFFF
    li    $t2, 0x10000
    multu $t2, $t2        # 2^32 -> hi = 1, lo = 0
    mfhi  $s2
    mflo  $s3
    li    $t3, -17
    li    $t4, 5
    div   $t3, $t4        # C-style: -3 remainder -2
    mflo  $s4
    mfhi  $s5
    li    $t5, 0xFFFFFFFF
    divu  $t5, $t4        # 4294967295 / 5 = 858993459 r 0
    mflo  $s6
    mul   $s7, $t0, $t1   # -42
  `);
  assert.equal(s(cpu, R.s0), -42);
  assert.equal(cpu.regs[R.s1], 0xffffffff);
  assert.equal(cpu.regs[R.s2], 1);
  assert.equal(cpu.regs[R.s3], 0);
  assert.equal(s(cpu, R.s4), -3);
  assert.equal(s(cpu, R.s5), -2);
  assert.equal(cpu.regs[R.s6], 858993459);
  assert.equal(s(cpu, R.s7), -42);
});

test('I-type arithmetic: addi addiu slti sltiu', () => {
  const cpu = runCode(`
    addi  $s0, $zero, -5
    addiu $s1, $s0, 10
    slti  $s2, $s0, -4     # -5 < -4 -> 1
    slti  $s3, $s0, -6     # 0
    sltiu $s4, $zero, -1   # 0 < 0xFFFFFFFF -> 1
  `);
  assert.equal(s(cpu, R.s0), -5);
  assert.equal(cpu.regs[R.s1], 5);
  assert.equal(cpu.regs[R.s2], 1);
  assert.equal(cpu.regs[R.s3], 0);
  assert.equal(cpu.regs[R.s4], 1);
});

test('I-type logic: andi ori xori zero-extend, lui loads the upper half', () => {
  const cpu = runCode(`
    li   $t0, -1
    andi $s0, $t0, 0xFF00
    ori  $s1, $zero, 0x8000
    xori $s2, $t0, 0xFFFF
    lui  $s3, 0xABCD
  `);
  assert.equal(cpu.regs[R.s0], 0x0000ff00);
  assert.equal(cpu.regs[R.s1], 0x00008000);
  assert.equal(cpu.regs[R.s2], 0xffff0000);
  assert.equal(cpu.regs[R.s3], 0xabcd0000);
});

test('la loads the real address of a data label', () => {
  const cpu = runCode('la $t0, second\nla $t1, first', 'first: .word 1\nsecond: .word 2');
  assert.equal(cpu.regs[R.t0], 0x2004);
  assert.equal(cpu.regs[R.t1], 0x2000);
});

test('loads and stores: lw sw lb lbu sb', () => {
  const cpu = runCode(`
    la   $t0, word
    lw   $s0, 0($t0)
    lb   $s1, 3($t0)       # 0x80 sign-extended
    lbu  $s2, 3($t0)       # 0x80 zero-extended
    lb   $s3, 0($t0)       # 0x7F
    li   $t1, 0x1234ABCD
    sw   $t1, 4($t0)
    li   $t2, 0x1FF
    sb   $t2, -1($t0)      # only the low byte is stored, before "word"
    lw   $s4, 4($t0)
    lw   $s5, -4($t0)
  `, 'pad: .word 0\nword: .word 0x8012347F\nspare: .word 0');
  assert.equal(cpu.regs[R.s0], 0x8012347f);
  assert.equal(s(cpu, R.s1), -128);
  assert.equal(cpu.regs[R.s2], 0x80);
  assert.equal(cpu.regs[R.s3], 0x7f);
  assert.equal(cpu.regs[R.s4], 0x1234abcd);
  assert.equal(cpu.memory.readWord(0x2008), 0x1234abcd);
  assert.equal(cpu.regs[R.s5], 0xff000000);
  assert.deepEqual(cpu.lastWrite, null); // last instruction (syscall) wrote nothing
});

test('stores report what they wrote (used by the UI)', () => {
  const { cpu } = load('.data\nx: .word 0\n.text\nla $t0, x\nli $t1, 5\nsw $t1, 0($t0)\nsb $t1, 1($t0)');
  cpu.step(); cpu.step(); cpu.step();
  assert.deepEqual(cpu.lastWrite, { address: 0x2000, size: 4 });
  cpu.step();
  assert.deepEqual(cpu.lastWrite, { address: 0x2001, size: 1 });
});

/** Run a two-operand branch with the given values; returns 1 if it was taken. */
function branchTaken(mnemonic, a, b) {
  const cpu = runCode(`
    li $t0, ${a}
    li $t1, ${b}
    li $s0, 0
    ${mnemonic} $t0, $t1, taken
    j done
taken: li $s0, 1
done:
  `);
  return cpu.regs[R.s0];
}

test('branches: beq bne bge blt bgt ble (signed compares)', () => {
  const cases = [
    ['beq', 3, 3, 1], ['beq', 3, 4, 0],
    ['bne', 3, 4, 1], ['bne', 3, 3, 0],
    ['bge', 5, 5, 1], ['bge', 6, 5, 1], ['bge', -1, 0, 0],
    ['blt', -1, 0, 1], ['blt', 0, 0, 0],
    ['bgt', 1, -1, 1], ['bgt', 0, 0, 0],
    ['ble', 0, 0, 1], ['ble', -1, -2, 0],
  ];
  for (const [mnemonic, a, b, expected] of cases) {
    assert.equal(branchTaken(mnemonic, a, b), expected, `${mnemonic} ${a}, ${b}`);
  }
});

test('a backward branch loops the right number of times', () => {
  const cpu = runCode(`
        li   $t0, 0
        li   $t1, 10
top:    addi $t0, $t0, 1
        bne  $t0, $t1, top
  `);
  assert.equal(cpu.regs[R.t0], 10);
});

test('j, jal and jr', () => {
  const cpu = runCode(`
        jal  func          # address 0
        addi $s1, $zero, 2 # returns here (address 4)
        j    end
        addi $s2, $zero, 9 # skipped
func:   addi $s0, $zero, 1
        jr   $ra
end:
  `);
  assert.equal(cpu.regs[R.s0], 1);
  assert.equal(cpu.regs[R.s1], 2);
  assert.equal(cpu.regs[R.s2], 0);
  assert.equal(cpu.regs[R.ra], 4);
});

test('syscall services 1, 4 and 11 print; 10 exits', () => {
  const printed = [];
  const { cpu } = load(`
    .data
    msg: .asciiz "x = "
    .text
    li $v0, 4
    la $a0, msg
    syscall
    li $v0, 1
    li $a0, -42
    syscall
    li $v0, 11
    li $a0, '!'
    syscall
    li $v0, 10
    syscall
    li $s0, 1          # never reached
  `);
  cpu.onOutput = (text) => printed.push(text);
  cpu.run();
  assert.equal(cpu.output, 'x = -42!');
  assert.deepEqual(printed, ['x = ', '-42', '!']);
  assert.equal(cpu.regs[R.s0], 0);
  assert.match(cpu.haltReason, /exit/);
});

test('syscall with $v0 = 0 ends the program (course convention)', () => {
  const cpu = run('syscall\naddi $t0, $zero, 1');
  assert.equal(cpu.regs[R.t0], 0);
  assert.match(cpu.haltReason, /\$v0 = 0/);
});

test('run-time errors are reported with the source line', () => {
  assertRunError('.data\nx: .word 1\n.text\nla $t0, x\nlw $t1, 2($t0)', 5, /Misaligned word access at 0x00002002/);
  assertRunError('nop\nli $t0, 0x3000\njr $t0', 3, /PC out of range/);
  assertRunError('li $t0, 6\njr $t0', 2, /PC out of range/); // misaligned PC
  assertRunError('li $t0, 0x7FFFFFFF\naddi $t0, $t0, 1', 2, /Arithmetic overflow in addi/);
  assertRunError('li $t0, 0x7FFFFFFF\nadd $t0, $t0, $t0', 2, /Arithmetic overflow in add/);
  assertRunError('li $t0, -0x80000000\nli $t1, 1\nsub $t0, $t0, $t1', 3, /Arithmetic overflow in sub/);
  assertRunError('li $t0, 1\ndiv $t0, $zero', 2, /Division by zero/);
  assertRunError('li $v0, 5\nsyscall', 2, /Unsupported syscall service 5/);
  assertRunError('lui $t0, 0x10\nlw $t1, 0($t0)', 2, /outside memory/);
});

test('unknown machine words are reported', () => {
  const { cpu } = load('nop');
  cpu.memory.writeWord(0, 0xfc000000); // opcode 0x3F is not defined
  assert.throws(() => cpu.step(), /Unknown instruction 0xFC000000/);
});

test('step limit stops infinite loops', () => {
  const { cpu } = load('nop\nforever: j forever');
  assert.throws(() => cpu.run(500), (err) => err instanceof MipsError && /Step limit of 500/.test(err.message) && err.line === 2);
});

test('load() resets memory and registers between programs', () => {
  const { cpu } = load('.data\nx: .word 0\n.text\nla $t0, x\nli $t1, 9\nsw $t1, 0($t0)');
  cpu.run();
  assert.equal(cpu.memory.readWord(0x2000), 9);
  const { program } = load('.data\nx: .word 1\n.text\nnop');
  cpu.load(program);
  assert.equal(cpu.memory.readWord(0x2000), 1);
  assert.equal(cpu.regs[R.t1], 0);
  assert.equal(cpu.steps, 0);
  assert.equal(cpu.halted, false);
});
