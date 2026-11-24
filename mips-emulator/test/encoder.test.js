import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIInstruction, buildJInstruction, buildRInstruction, encodeInstruction } from '../src/encoder.js';
import { decode } from '../src/cpu.js';
import { INSTRUCTIONS, OPCODE, FUNCT } from '../src/isa.js';

// ---------------------------------------------------------------------------
// Literal transliterations of the C functions in lab7.c (including the 0xFF
// masks and the 24-bit J mask), used as a reference for the bit layout.
// ---------------------------------------------------------------------------
function cBuildIInstruction(opcode, rs, rt, immediate) {
  let machineCode = immediate & 0x0000ffff;
  machineCode |= (rs & 0x000000ff) << 21;
  machineCode |= (rt & 0x000000ff) << 16;
  machineCode |= (opcode & 0x000000ff) << 26;
  return machineCode >>> 0;
}
function cBuildJInstruction(opcode, immediate) {
  let machineCode = immediate & 0x00ffffff;
  machineCode |= (opcode & 0x000000ff) << 26;
  return machineCode >>> 0;
}
function cBuildRInstruction(opcode, rs, rt, rd, shamt, fn) {
  let machineCode = fn & 0x000000ff;
  machineCode |= (shamt & 0x000000ff) << 6;
  machineCode |= (rd & 0x000000ff) << 11;
  machineCode |= (rt & 0x000000ff) << 16;
  machineCode |= (rs & 0x000000ff) << 21;
  machineCode |= (opcode & 0x000000ff) << 26;
  return machineCode >>> 0;
}

// Small deterministic pseudo-random generator so failures are reproducible.
function makeRandom(seed) {
  let state = seed;
  return (limit) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % limit;
  };
}

test('hand-computed words for the instructions in MIPS.asm', () => {
  // la $t1, 0x2004   opcode 101111, rs 0, rt 01001
  assert.equal(buildIInstruction(0b101111, 0, 9, 0x2004), 0xbc092004);
  // lb $a1, 0($t3)   opcode 100000, rs 01011, rt 00101
  assert.equal(buildIInstruction(0b100000, 11, 5, 0), 0x81650000);
  // bge $s0, $a1, +8 opcode 110010, rs 10000, rt 00101
  assert.equal(buildIInstruction(0b110010, 16, 5, 8), 0xca050008);
  // lw $t4, 0($t1)
  assert.equal(buildIInstruction(0b100011, 9, 12, 0), 0x8d2c0000);
  // sw $t4, 0($t2)
  assert.equal(buildIInstruction(0b101011, 10, 12, 0), 0xad4c0000);
  // addi $t1, $t1, 4
  assert.equal(buildIInstruction(0b001000, 9, 9, 4), 0x21290004);
  // add $s0, $zero, $zero   000000 00000 00000 10000 00000 100000
  assert.equal(buildRInstruction(0, 0, 0, 16, 0, 0b100000), 0x00008020);
  // j 0x14   (word address 5)
  assert.equal(buildJInstruction(0b000010, 5), 0x08000005);
});

test('negative immediates are stored as 16-bit two\'s complement', () => {
  assert.equal(buildIInstruction(OPCODE.ADDI, 29, 29, -8), 0x23bdfff8); // addi $sp, $sp, -8
  assert.equal(buildIInstruction(OPCODE.BNE, 8, 9, -1), 0x1509ffff);
});

test('R-type fields land in the right bits', () => {
  // sll $t0, $t1, 4: rs 0, rt 9, rd 8, shamt 4, funct 0
  assert.equal(buildRInstruction(0, 0, 9, 8, 4, FUNCT.SLL), 0x00094100);
  // syscall
  assert.equal(buildRInstruction(0, 0, 0, 0, 0, FUNCT.SYSCALL), 0x0000000c);
  // jr $ra
  assert.equal(buildRInstruction(0, 31, 0, 0, 0, FUNCT.JR), 0x03e00008);
});

test('build functions match the original C bit layout for all valid fields', () => {
  const random = makeRandom(356);
  for (let i = 0; i < 2000; i++) {
    const opcode = random(64);
    const rs = random(32);
    const rt = random(32);
    const rd = random(32);
    const shamt = random(32);
    const funct = random(64);
    const immediate = random(65536) - 32768;
    const address = random(1 << 18); // 1 MB of memory = 2^18 words

    assert.equal(buildIInstruction(opcode, rs, rt, immediate), cBuildIInstruction(opcode, rs, rt, immediate));
    assert.equal(buildRInstruction(opcode, rs, rt, rd, shamt, funct), cBuildRInstruction(opcode, rs, rt, rd, shamt, funct));
    assert.equal(buildJInstruction(opcode, address), cBuildJInstruction(opcode, address));
  }
});

test('fields are masked to their real width (a fix over the 0xFF masks in C)', () => {
  // rt = 32 would spill into rs with an 0xFF mask; with a 5-bit mask it becomes 0.
  assert.equal(buildIInstruction(0, 0, 32, 0), 0);
  // the full 26-bit jump field is kept
  assert.equal(buildJInstruction(OPCODE.J, 0x03ffffff), 0x0bffffff);
});

test('every instruction in the table decodes back to its own opcode/funct', () => {
  for (const [mnemonic, spec] of Object.entries(INSTRUCTIONS)) {
    const word = encodeInstruction(mnemonic, { rs: 1, rt: 2, rd: 3, shamt: 4, immediate: 5, address: 6 });
    const d = decode(word);
    assert.equal(d.opcode, spec.opcode, `${mnemonic} opcode`);
    if (spec.format === 'R') {
      assert.equal(d.funct, spec.funct, `${mnemonic} funct`);
      assert.deepEqual([d.rs, d.rt, d.rd, d.shamt], [1, 2, 3, 4], `${mnemonic} fields`);
    } else if (spec.format === 'I') {
      assert.deepEqual([d.rs, d.rt, d.imm], [1, 2, 5], `${mnemonic} fields`);
    } else {
      assert.equal(d.target, 6, `${mnemonic} target`);
    }
  }
});

test('course-defined opcodes are kept from lab7.c', () => {
  assert.equal(OPCODE.LA, 0b101111);
  assert.equal(OPCODE.BGE, 0b110010);
  assert.equal(OPCODE.LB, 0b100000);
  assert.equal(OPCODE.LW, 0b100011);
  assert.equal(OPCODE.SW, 0b101011);
  assert.equal(OPCODE.ADDI, 0b001000);
  assert.equal(OPCODE.J, 0b000010);
  assert.equal(FUNCT.ADD, 0b100000);
});

test('no two instructions share an encoding', () => {
  const seen = new Map();
  for (const [mnemonic, spec] of Object.entries(INSTRUCTIONS)) {
    const key = spec.format === 'R' ? `${spec.opcode}:${spec.funct}` : `${spec.opcode}`;
    assert.ok(!seen.has(key), `${mnemonic} clashes with ${seen.get(key)}`);
    seen.set(key, mnemonic);
  }
});
