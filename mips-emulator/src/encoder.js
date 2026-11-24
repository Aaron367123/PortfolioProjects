// encoder.js - pack instruction fields into 32-bit machine words.
//
// The three build*Instruction functions are direct ports of the C functions in
// lab7.c (buildIInstruction, buildJInstruction, buildRInstruction). The bit
// layout is identical:
//
//   R-type: oooooo sssss ttttt ddddd aaaaa ffffff   (opcode rs rt rd shamt funct)
//   I-type: oooooo sssss ttttt iiiiiiiiiiiiiiii     (opcode rs rt immediate)
//   J-type: oooooo aaaaaaaaaaaaaaaaaaaaaaaaaa       (opcode 26-bit word address)
//
// Two small fixes compared with the C version:
//   * Each field is masked to its real width (5 bits for registers, 6 for the
//     opcode/funct). The C code masked with 0xFF, so an out-of-range value
//     could spill into the neighbouring field.
//   * The J-type address is masked to 26 bits (0x03FFFFFF). The C code used
//     0x00FFFFFF (24 bits). For a 1 MB memory both give the same result.
//
// JavaScript bitwise operators work on signed 32-bit integers, so every result
// is finished with ">>> 0" to turn it back into an unsigned 32-bit number.

import { INSTRUCTIONS } from './isa.js';

/** I-type: opcode | rs | rt | 16-bit immediate. Port of buildIInstruction(). */
export function buildIInstruction(opcode, rs, rt, immediate) {
  let machineCode = immediate & 0xffff;        // bits 15-0: immediate (two's complement if negative)
  machineCode |= (rt & 0x1f) << 16;            // bits 20-16: rt
  machineCode |= (rs & 0x1f) << 21;            // bits 25-21: rs
  machineCode |= (opcode & 0x3f) << 26;        // bits 31-26: opcode
  return machineCode >>> 0;
}

/** J-type: opcode | 26-bit word address. Port of buildJInstruction(). */
export function buildJInstruction(opcode, address) {
  let machineCode = address & 0x03ffffff;      // bits 25-0: target address / 4
  machineCode |= (opcode & 0x3f) << 26;        // bits 31-26: opcode
  return machineCode >>> 0;
}

/** R-type: opcode | rs | rt | rd | shamt | funct. Port of buildRInstruction(). */
export function buildRInstruction(opcode, rs, rt, rd, shamt, funct) {
  let machineCode = funct & 0x3f;              // bits 5-0: function code
  machineCode |= (shamt & 0x1f) << 6;          // bits 10-6: shift amount
  machineCode |= (rd & 0x1f) << 11;            // bits 15-11: rd
  machineCode |= (rt & 0x1f) << 16;            // bits 20-16: rt
  machineCode |= (rs & 0x1f) << 21;            // bits 25-21: rs
  machineCode |= (opcode & 0x3f) << 26;        // bits 31-26: opcode
  return machineCode >>> 0;
}

/**
 * Encode one instruction from its mnemonic and already-resolved fields.
 * The assembler does all the checking (register numbers, immediate ranges,
 * label lookups) before calling this, so here we only pick the right format.
 *
 * @param {string} mnemonic e.g. 'addi'
 * @param {object} fields   { rs, rt, rd, shamt, immediate, address } - missing fields are 0
 * @returns {number} the 32-bit machine word
 */
export function encodeInstruction(mnemonic, fields) {
  const spec = INSTRUCTIONS[mnemonic];
  if (!spec) {
    throw new Error(`encodeInstruction: unknown mnemonic '${mnemonic}'`);
  }
  const { rs = 0, rt = 0, rd = 0, shamt = 0, immediate = 0, address = 0 } = fields;

  switch (spec.format) {
    case 'R':
      return buildRInstruction(spec.opcode, rs, rt, rd, shamt, spec.funct);
    case 'I':
      return buildIInstruction(spec.opcode, rs, rt, immediate);
    case 'J':
      return buildJInstruction(spec.opcode, address);
    default:
      throw new Error(`encodeInstruction: bad format '${spec.format}'`);
  }
}
