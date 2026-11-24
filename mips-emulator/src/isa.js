// isa.js - the instruction set definition shared by every other module.
//
// This file is the "single source of truth" for:
//   * the memory map (where code, data and the stack live),
//   * register names,
//   * opcodes and function codes,
//   * the operand layout of every instruction the assembler accepts.
//
// The opcodes for the real MIPS instructions are the standard MIPS32 values.
// A few instructions (la, bge, blt, bgt, ble) are pseudo-instructions in real
// MIPS, but the CENG356 course gave them their own opcodes so they could be
// encoded as a single word. Those course-defined opcodes are kept exactly as
// they were in the original C labs (lab7.c / lab8.c).

// ---------------------------------------------------------------------------
// Memory map (same layout as the C labs: header.h CODESECTION / DATASECTION)
// ---------------------------------------------------------------------------
export const MEMORY_SIZE = 1024 * 1024; // 1 MB, same as MEM_SIZE in header.h
export const TEXT_BASE = 0x0000;        // code is loaded at address 0
export const DATA_BASE = 0x2000;        // data is loaded at 8 KB
export const TEXT_LIMIT = DATA_BASE;    // code must fit below the data section (2048 instructions)
export const STACK_TOP = MEMORY_SIZE - 4; // initial $sp: last word of memory, stack grows down

// ---------------------------------------------------------------------------
// Registers (same order as regNameTab in parser.h)
// ---------------------------------------------------------------------------
export const REGISTER_NAMES = [
  '$zero', '$at', '$v0', '$v1', '$a0', '$a1', '$a2', '$a3',
  '$t0', '$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7',
  '$s0', '$s1', '$s2', '$s3', '$s4', '$s5', '$s6', '$s7',
  '$t8', '$t9', '$k0', '$k1', '$gp', '$sp', '$fp', '$ra',
];

// ---------------------------------------------------------------------------
// Opcodes: bits 31-26 of every instruction word
// ---------------------------------------------------------------------------
export const OPCODE = {
  SPECIAL: 0b000000,  // all R-type instructions; the real operation is in "funct"
  J: 0b000010,
  JAL: 0b000011,
  BEQ: 0b000100,
  BNE: 0b000101,
  ADDI: 0b001000,     // lab7.c
  ADDIU: 0b001001,
  SLTI: 0b001010,
  SLTIU: 0b001011,
  ANDI: 0b001100,
  ORI: 0b001101,
  XORI: 0b001110,
  LUI: 0b001111,
  SPECIAL2: 0b011100, // MIPS32 "mul" lives here
  LB: 0b100000,       // lab7.c
  LW: 0b100011,       // lab7.c
  LBU: 0b100100,
  SB: 0b101000,
  SW: 0b101011,       // lab7.c
  LA: 0b101111,       // course-defined (lab7.c example), not standard MIPS
  BGE: 0b110010,      // course-defined (lab7.c), not standard MIPS
  BLT: 0b110011,      // added in the same style as bge
  BGT: 0b110110,      // added in the same style as bge
  BLE: 0b110111,      // added in the same style as bge
};

// ---------------------------------------------------------------------------
// Function codes: bits 5-0 of an R-type instruction (opcode 0)
// ---------------------------------------------------------------------------
export const FUNCT = {
  SLL: 0x00,
  SRL: 0x02,
  SRA: 0x03,
  SLLV: 0x04,
  SRLV: 0x06,
  SRAV: 0x07,
  JR: 0x08,
  SYSCALL: 0x0c,
  MFHI: 0x10,
  MFLO: 0x12,
  MULT: 0x18,
  MULTU: 0x19,
  DIV: 0x1a,
  DIVU: 0x1b,
  ADD: 0x20,          // lab7.c
  ADDU: 0x21,
  SUB: 0x22,
  SUBU: 0x23,
  AND: 0x24,
  OR: 0x25,
  XOR: 0x26,
  NOR: 0x27,
  SLT: 0x2a,
  SLTU: 0x2b,
};

// Function code used with opcode SPECIAL2.
export const FUNCT2 = {
  MUL: 0x02,
};

// ---------------------------------------------------------------------------
// Instruction table
// ---------------------------------------------------------------------------
// format   : 'R', 'I' or 'J' (decides which build*Instruction function is used)
// opcode   : bits 31-26
// funct    : bits 5-0 (R-type only)
// operands : the operand pattern written in the source code
//              'rd,rs,rt'      add $t0, $t1, $t2
//              'rd,rt,shamt'   sll $t0, $t1, 4
//              'rd,rt,rs'      sllv $t0, $t1, $t2
//              'rs,rt'         mult $t0, $t1
//              'rs'            jr $ra
//              'rd'            mfhi $t0
//              ''              syscall
//              'rt,rs,imm'     addi $t0, $t1, 5
//              'rt,imm'        lui $t0, 0x1234
//              'rt,mem'        lw $t0, 4($t1)
//              'rs,rt,label'   beq $t0, $t1, loop
//              'rt,label'      la $t0, array
//              'label'         j loop
// imm      : 'signed' (-32768..32767) or 'unsigned' (0..65535) for 'rt,rs,imm' / 'rt,imm'
// summary  : one-line description used by the README and the UI
export const INSTRUCTIONS = {
  // R-type arithmetic / logic
  add: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.ADD, operands: 'rd,rs,rt', summary: 'rd = rs + rt (traps on signed overflow)' },
  addu: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.ADDU, operands: 'rd,rs,rt', summary: 'rd = rs + rt (no overflow trap)' },
  sub: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SUB, operands: 'rd,rs,rt', summary: 'rd = rs - rt (traps on signed overflow)' },
  subu: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SUBU, operands: 'rd,rs,rt', summary: 'rd = rs - rt (no overflow trap)' },
  and: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.AND, operands: 'rd,rs,rt', summary: 'rd = rs & rt' },
  or: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.OR, operands: 'rd,rs,rt', summary: 'rd = rs | rt' },
  xor: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.XOR, operands: 'rd,rs,rt', summary: 'rd = rs ^ rt' },
  nor: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.NOR, operands: 'rd,rs,rt', summary: 'rd = ~(rs | rt)' },
  slt: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SLT, operands: 'rd,rs,rt', summary: 'rd = (rs < rt) signed ? 1 : 0' },
  sltu: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SLTU, operands: 'rd,rs,rt', summary: 'rd = (rs < rt) unsigned ? 1 : 0' },
  sll: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SLL, operands: 'rd,rt,shamt', summary: 'rd = rt << shamt' },
  srl: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SRL, operands: 'rd,rt,shamt', summary: 'rd = rt >>> shamt (logical)' },
  sra: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SRA, operands: 'rd,rt,shamt', summary: 'rd = rt >> shamt (arithmetic)' },
  sllv: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SLLV, operands: 'rd,rt,rs', summary: 'rd = rt << (rs & 31)' },
  srlv: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SRLV, operands: 'rd,rt,rs', summary: 'rd = rt >>> (rs & 31)' },
  srav: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SRAV, operands: 'rd,rt,rs', summary: 'rd = rt >> (rs & 31)' },
  mult: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.MULT, operands: 'rs,rt', summary: 'hi:lo = rs * rt (signed 64-bit)' },
  multu: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.MULTU, operands: 'rs,rt', summary: 'hi:lo = rs * rt (unsigned 64-bit)' },
  div: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.DIV, operands: 'rs,rt', summary: 'lo = rs / rt, hi = rs % rt (signed)' },
  divu: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.DIVU, operands: 'rs,rt', summary: 'lo = rs / rt, hi = rs % rt (unsigned)' },
  mfhi: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.MFHI, operands: 'rd', summary: 'rd = hi' },
  mflo: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.MFLO, operands: 'rd', summary: 'rd = lo' },
  mul: { format: 'R', opcode: OPCODE.SPECIAL2, funct: FUNCT2.MUL, operands: 'rd,rs,rt', summary: 'rd = low 32 bits of rs * rt' },
  jr: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.JR, operands: 'rs', summary: 'PC = rs' },
  syscall: { format: 'R', opcode: OPCODE.SPECIAL, funct: FUNCT.SYSCALL, operands: '', summary: 'service in $v0: 1 print int, 4 print string, 11 print char, 10 or 0 exit' },

  // I-type arithmetic / logic
  addi: { format: 'I', opcode: OPCODE.ADDI, operands: 'rt,rs,imm', imm: 'signed', summary: 'rt = rs + imm (traps on signed overflow)' },
  addiu: { format: 'I', opcode: OPCODE.ADDIU, operands: 'rt,rs,imm', imm: 'signed', summary: 'rt = rs + imm (no overflow trap)' },
  slti: { format: 'I', opcode: OPCODE.SLTI, operands: 'rt,rs,imm', imm: 'signed', summary: 'rt = (rs < imm) signed ? 1 : 0' },
  sltiu: { format: 'I', opcode: OPCODE.SLTIU, operands: 'rt,rs,imm', imm: 'signed', summary: 'rt = (rs < sign-extended imm) unsigned ? 1 : 0' },
  andi: { format: 'I', opcode: OPCODE.ANDI, operands: 'rt,rs,imm', imm: 'unsigned', summary: 'rt = rs & zero-extended imm' },
  ori: { format: 'I', opcode: OPCODE.ORI, operands: 'rt,rs,imm', imm: 'unsigned', summary: 'rt = rs | zero-extended imm' },
  xori: { format: 'I', opcode: OPCODE.XORI, operands: 'rt,rs,imm', imm: 'unsigned', summary: 'rt = rs ^ zero-extended imm' },
  lui: { format: 'I', opcode: OPCODE.LUI, operands: 'rt,imm', imm: 'unsigned', summary: 'rt = imm << 16' },

  // I-type loads and stores
  lb: { format: 'I', opcode: OPCODE.LB, operands: 'rt,mem', summary: 'rt = sign-extended byte at rs + offset' },
  lbu: { format: 'I', opcode: OPCODE.LBU, operands: 'rt,mem', summary: 'rt = zero-extended byte at rs + offset' },
  lw: { format: 'I', opcode: OPCODE.LW, operands: 'rt,mem', summary: 'rt = word at rs + offset (must be 4-byte aligned)' },
  sb: { format: 'I', opcode: OPCODE.SB, operands: 'rt,mem', summary: 'byte at rs + offset = low byte of rt' },
  sw: { format: 'I', opcode: OPCODE.SW, operands: 'rt,mem', summary: 'word at rs + offset = rt (must be 4-byte aligned)' },
  la: { format: 'I', opcode: OPCODE.LA, operands: 'rt,label', summary: 'rt = address of label (course-defined opcode, 16-bit address)' },

  // I-type branches (offset is counted in instructions from PC + 4)
  beq: { format: 'I', opcode: OPCODE.BEQ, operands: 'rs,rt,label', summary: 'if rs == rt branch to label' },
  bne: { format: 'I', opcode: OPCODE.BNE, operands: 'rs,rt,label', summary: 'if rs != rt branch to label' },
  bge: { format: 'I', opcode: OPCODE.BGE, operands: 'rs,rt,label', summary: 'if rs >= rt (signed) branch (course-defined opcode)' },
  blt: { format: 'I', opcode: OPCODE.BLT, operands: 'rs,rt,label', summary: 'if rs < rt (signed) branch (course-style opcode)' },
  bgt: { format: 'I', opcode: OPCODE.BGT, operands: 'rs,rt,label', summary: 'if rs > rt (signed) branch (course-style opcode)' },
  ble: { format: 'I', opcode: OPCODE.BLE, operands: 'rs,rt,label', summary: 'if rs <= rt (signed) branch (course-style opcode)' },

  // J-type
  j: { format: 'J', opcode: OPCODE.J, operands: 'label', summary: 'PC = label' },
  jal: { format: 'J', opcode: OPCODE.JAL, operands: 'label', summary: '$ra = PC + 4, PC = label' },
};

// Pseudo-instructions the assembler expands into the real instructions above.
export const PSEUDO_INSTRUCTIONS = {
  li: 'li rt, value  ->  addiu / ori, or lui $at + ori for 32-bit values',
  move: 'move rd, rs  ->  addu rd, rs, $zero',
  b: 'b label  ->  beq $zero, $zero, label',
  beqz: 'beqz rs, label  ->  beq rs, $zero, label',
  bnez: 'bnez rs, label  ->  bne rs, $zero, label',
  nop: 'nop  ->  sll $zero, $zero, 0 (the all-zero word)',
};
