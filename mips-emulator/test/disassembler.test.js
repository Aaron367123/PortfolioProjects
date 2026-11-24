import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disassemble, labelsByAddress } from '../src/disassembler.js';
import { assemble } from '../src/assembler.js';
import { example } from './helpers.js';

test('disassembles the swap program with label names', () => {
  const program = assemble(example('swap.asm'));
  const names = labelsByAddress(program.labels);
  const text = program.listing.map((e) => disassemble(e.word, e.address, names));
  assert.deepEqual(text, [
    'la $t1, testdata1',
    'la $t2, testdata2',
    'la $t3, counter',
    'add $s0, $zero, $zero',
    'lb $a1, 0($t3)',
    'bge $s0, $a1, exit',
    'lw $t4, 0($t1)',
    'lw $t5, 0($t2)',
    'sw $t4, 0($t2)',
    'sw $t5, 0($t1)',
    'addi $t1, $t1, 4',
    'addi $t2, $t2, 4',
    'addi $s0, $s0, 4',
    'j loop',
    'syscall',
  ]);
});

test('without labels, targets are shown as addresses', () => {
  assert.equal(disassemble(0x08000005, 0x34), 'j 0x0014');
  assert.equal(disassemble(0xca050008, 0x14), 'bge $s0, $a1, 0x0038');
  assert.equal(disassemble(0x1509ffff, 0x10), 'bne $t0, $t1, 0x0010');
});

test('every instruction form disassembles back to its source text', () => {
  const lines = [
    'add $t0, $t1, $t2', 'addu $t0, $t1, $t2', 'sub $t0, $t1, $t2', 'subu $t0, $t1, $t2',
    'and $t0, $t1, $t2', 'or $t0, $t1, $t2', 'xor $t0, $t1, $t2', 'nor $t0, $t1, $t2',
    'slt $t0, $t1, $t2', 'sltu $t0, $t1, $t2', 'sll $t0, $t1, 3', 'srl $t0, $t1, 3', 'sra $t0, $t1, 3',
    'sllv $t0, $t1, $t2', 'srlv $t0, $t1, $t2', 'srav $t0, $t1, $t2',
    'mult $t1, $t2', 'multu $t1, $t2', 'div $t1, $t2', 'divu $t1, $t2', 'mfhi $t0', 'mflo $t0',
    'mul $t0, $t1, $t2', 'jr $ra', 'syscall',
    'addi $t0, $t1, -5', 'addiu $t0, $t1, 7', 'slti $t0, $t1, -1', 'sltiu $t0, $t1, 9',
    'andi $t0, $t1, 0x00FF', 'ori $t0, $t1, 0xF000', 'xori $t0, $t1, 0x0001', 'lui $t0, 0x1234',
    'lw $t0, -4($sp)', 'sw $t0, 8($sp)', 'lb $t0, 1($a0)', 'lbu $t0, 0($a0)', 'sb $t0, 2($a0)',
  ];
  for (const line of lines) {
    const [word] = assemble(line).text;
    assert.equal(disassemble(word, 0), line);
  }
});

test('unknown words are shown as data', () => {
  assert.equal(disassemble(0xfc000000), '.word 0xFC000000');
  assert.equal(disassemble(0), 'nop');
});
