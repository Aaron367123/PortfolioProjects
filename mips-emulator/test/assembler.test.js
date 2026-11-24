import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, parseNumber, parseRegister, splitOperands, stripComment } from '../src/assembler.js';
import { MipsError } from '../src/errors.js';
import { example } from './helpers.js';

/** Assert that assembling `source` throws a MipsError on `line` whose message matches `pattern`. */
function assertAsmError(source, line, pattern) {
  assert.throws(() => assemble(source), (err) => {
    assert.ok(err instanceof MipsError, `expected MipsError, got ${err}`);
    assert.equal(err.line, line, `line number for: ${err.message}`);
    assert.match(err.message, pattern);
    return true;
  });
}

test('swap.asm: label addresses, with .word aligned to 4 bytes', () => {
  const program = assemble(example('swap.asm'));
  assert.equal(program.labels.get('counter'), 0x2000);
  assert.equal(program.labels.get('testdata1'), 0x2004); // offset 1 rounded up to 4
  assert.equal(program.labels.get('testdata2'), 0x2024); // 0x2004 + 8 words
  assert.equal(program.labels.get('loop'), 0x14);        // 6th instruction
  assert.equal(program.labels.get('exit'), 0x38);        // 15th instruction
});

test('swap.asm: machine code matches the hand-assembled words', () => {
  const program = assemble(example('swap.asm'));
  const expected = [
    0xbc092004, // la   $t1, testdata1
    0xbc0a2024, // la   $t2, testdata2
    0xbc0b2000, // la   $t3, counter
    0x00008020, // add  $s0, $zero, $zero
    0x81650000, // lb   $a1, 0($t3)
    0xca050008, // bge  $s0, $a1, exit   (exit is 8 instructions after PC + 4)
    0x8d2c0000, // lw   $t4, 0($t1)
    0x8d4d0000, // lw   $t5, 0($t2)
    0xad4c0000, // sw   $t4, 0($t2)
    0xad2d0000, // sw   $t5, 0($t1)
    0x21290004, // addi $t1, $t1, 4
    0x214a0004, // addi $t2, $t2, 4
    0x22100004, // addi $s0, $s0, 4
    0x08000005, // j    loop             (0x14 / 4)
    0x0000000c, // syscall
  ];
  assert.deepEqual(program.text, expected);
  assert.equal(program.codeEnd, expected.length * 4);
  assert.equal(program.listing[5].line, 14); // the bge line in the source
});

test('swap.asm: data section bytes', () => {
  const { data } = assemble(example('swap.asm'));
  assert.equal(data.length, 4 + 32 + 32);
  assert.deepEqual(Array.from(data.slice(0, 8)), [32, 0, 0, 0, 0x0a, 0, 0, 0]); // counter, padding, 0x0A
  assert.deepEqual(Array.from(data.slice(0x24, 0x28)), [0xaa, 0xaa, 0, 0]);   // 0xAAAA little-endian
});

test('branch offset equals the lab7.c formula: labelIndex - (i + 1)', () => {
  const program = assemble(`
        addi $t0, $zero, 0     # 0
        addi $t1, $zero, 3     # 1
top:    addi $t0, $t0, 1       # 2
        bne  $t0, $t1, top     # 3 -> 2 - (3 + 1) = -2
        beq  $t0, $t1, end     # 4 -> 7 - (4 + 1) = 2
        nop                    # 5
        nop                    # 6
end:    syscall                # 7
  `);
  assert.equal(program.text[3] & 0xffff, 0xfffe); // -2
  assert.equal(program.text[4] & 0xffff, 2);
});

test('jumps store the target word address (findLabel >> 2)', () => {
  const program = assemble('nop\nnop\nhere: j here\njal here');
  assert.equal(program.text[2], 0x08000002);
  assert.equal(program.text[3], 0x0c000002);
});

test('data directives: .byte .half .word .ascii .asciiz .space .align and alignment', () => {
  const program = assemble(`
          .data
b:        .byte 1, -1, 'A'
h:        .half 0x1234
w:        .word 0x11223344, w
s:        .ascii "hi"
z:        .asciiz "a\\tb\\n"
gap:      .space 3
          .align 2
after:    .byte 9
end:
          .text
          nop
  `);
  const L = (n) => program.labels.get(n) - 0x2000;
  assert.equal(L('b'), 0);
  assert.equal(L('h'), 4);   // .half aligned to 2 (offset 3 -> 4)
  assert.equal(L('w'), 8);   // .word aligned to 4 (offset 6 -> 8)
  assert.equal(L('s'), 16);
  assert.equal(L('z'), 18);
  assert.equal(L('gap'), 23); // "a\tb\n" + NUL = 5 bytes
  assert.equal(L('after'), 28); // .align 2 -> multiple of 4 (26 -> 28)
  assert.equal(L('end'), 29);
  const d = Array.from(program.data);
  assert.deepEqual(d.slice(0, 3), [1, 0xff, 65]);
  assert.deepEqual(d.slice(4, 6), [0x34, 0x12]);
  assert.deepEqual(d.slice(8, 12), [0x44, 0x33, 0x22, 0x11]);
  assert.deepEqual(d.slice(12, 16), [0x08, 0x20, 0, 0]); // label value = 0x2008
  assert.deepEqual(d.slice(16, 23), [104, 105, 97, 9, 98, 10, 0]);
});

test('a label on its own line before a .word gets the aligned address', () => {
  const program = assemble('.data\nc: .byte 1\narr:\n  .word 5\n.text\nnop');
  assert.equal(program.labels.get('arr'), 0x2004);
});

test('pseudo-instructions expand to real instructions', () => {
  const program = assemble(`
    li   $t0, 5
    li   $t1, -1
    li   $t2, 0xFFFF
    li   $t3, 0x12345678
    move $t4, $t5
    nop
    b    end
    beqz $t0, end
    bnez $t0, end
end: syscall
  `);
  assert.deepEqual(program.listing.map((e) => e.pseudo), ['li', 'li', 'li', 'li', 'li', 'move', 'nop', 'b', 'beqz', 'bnez', null]);
  const t = program.text;
  assert.equal(t[0], 0x24080005); // addiu $t0, $zero, 5
  assert.equal(t[1], 0x2409ffff); // addiu $t1, $zero, -1
  assert.equal(t[2], 0x340affff); // ori   $t2, $zero, 0xFFFF
  assert.equal(t[3], 0x3c011234); // lui   $at, 0x1234
  assert.equal(t[4], 0x342b5678); // ori   $t3, $at, 0x5678
  assert.equal(t[5], 0x01a06021); // addu  $t4, $t5, $zero
  assert.equal(t[6], 0x00000000); // sll   $zero, $zero, 0
  assert.equal(program.labels.get('end'), 40); // li 0x12345678 took two words
});

test('register names and numbers', () => {
  assert.equal(parseRegister('$zero'), 0);
  assert.equal(parseRegister('$t0'), 8);
  assert.equal(parseRegister('$8'), 8);
  assert.equal(parseRegister('$RA'), 31);
  assert.throws(() => parseRegister('$t10'), /Bad register/);
  assert.throws(() => parseRegister('$32'), /Bad register/);
  assert.throws(() => parseRegister('t0'), /Bad register/);
});

test('number formats', () => {
  assert.equal(parseNumber('42'), 42);
  assert.equal(parseNumber('-7'), -7);
  assert.equal(parseNumber('0x2A'), 42);
  assert.equal(parseNumber('-0x10'), -16);
  assert.equal(parseNumber('0b1010'), 10);
  assert.equal(parseNumber("'A'"), 65);
  assert.equal(parseNumber("'\\n'"), 10);
  assert.equal(parseNumber('loop'), null);
});

test('operand splitting and comments', () => {
  assert.deepEqual(splitOperands('$t4, 0($t1)'), ['$t4', '0($t1)']);
  assert.deepEqual(splitOperands('$t4 , -4 ( $sp )'), ['$t4', '-4($sp)']);
  assert.deepEqual(splitOperands('$t0 $t1 $t2'), ['$t0', '$t1', '$t2']); // spaces work, like parser.c
  assert.deepEqual(splitOperands("$t0, ' '"), ['$t0', "' '"]);
  assert.equal(stripComment('add $t0, $t1, $t2  # comment'), 'add $t0, $t1, $t2  ');
  assert.equal(stripComment('s: .asciiz "a # b" # real'), 's: .asciiz "a # b" ');
});

test('mnemonics are case-insensitive', () => {
  assert.deepEqual(assemble('ADD $t0, $t1, $t2').text, assemble('add $t0, $t1, $t2').text);
});

test('errors are reported with line numbers', () => {
  assertAsmError('nop\naddd $t0, $t1, $t2', 2, /Unknown instruction 'addd'/);
  assertAsmError('add $t0, $t1, $t99', 1, /Bad register '\$t99'/);
  assertAsmError('nop\n\nj nowhere', 3, /Undefined label 'nowhere'/);
  assertAsmError('a: nop\na: nop', 2, /Duplicate label 'a'/);
  assertAsmError('addi $t0, $t0, 40000', 1, /out of range/);
  assertAsmError('andi $t0, $t0, -1', 1, /out of range/);
  assertAsmError('sll $t0, $t0, 32', 1, /out of range/);
  assertAsmError('add $t0, $t1', 1, /expects 3 operand/);
  assertAsmError('lw $t0, $t1', 1, /Expected offset\(\$register\)/);
  assertAsmError('.data\nadd $t0, $t1, $t2', 2, /\.data section/);
  assertAsmError('.word 5', 1, /only allowed in the \.data section/);
  assertAsmError('.data\n.float 1.5', 2, /Unknown directive/);
  assertAsmError('.data\n.byte 300', 2, /out of range/);
  assertAsmError('.data\n.asciiz hello', 2, /double quotes/);
  assertAsmError('.data\nbig: .space 0x10000\nend: .byte 1\n.text\nla $t0, end', 5, /la can only reach/);
  assertAsmError('li $t0, foo', 1, /li expects a number/);
});
