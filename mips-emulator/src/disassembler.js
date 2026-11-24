// disassembler.js - turn a machine word back into readable assembly.
//
// Used by the web UI for the machine-code listing, and by the tests to check
// that encode -> decode gives back the same instruction.
//
// It looks the word up in the same INSTRUCTIONS table the assembler uses:
// non-R-type instructions are found by opcode alone, R-type instructions
// (opcode 0, and opcode 0x1C for mul) need the funct field as well.

import { INSTRUCTIONS, REGISTER_NAMES, OPCODE } from './isa.js';
import { decode } from './cpu.js';

// Build the reverse table once: "opcode" or "opcode:funct" -> mnemonic.
const BY_CODE = new Map();
for (const [mnemonic, spec] of Object.entries(INSTRUCTIONS)) {
  BY_CODE.set(lookupKey(spec.opcode, spec.funct), mnemonic);
}

function lookupKey(opcode, funct) {
  const hasFunct = opcode === OPCODE.SPECIAL || opcode === OPCODE.SPECIAL2;
  return hasFunct ? `${opcode}:${funct}` : `${opcode}`;
}

/**
 * @param {number} word       32-bit machine word
 * @param {number} address    where the word lives (needed to show branch targets)
 * @param {Map<number,string>} [labelNames] address -> label, to print "loop" instead of 0x00000014
 * @returns {string} e.g. "bge $s0, $a1, exit"
 */
export function disassemble(word, address = 0, labelNames = new Map()) {
  if (word === 0) return 'nop'; // sll $zero, $zero, 0

  const d = decode(word);
  const mnemonic = BY_CODE.get(lookupKey(d.opcode, d.funct));
  if (!mnemonic) return `.word 0x${hex(word, 8)}`; // not an instruction we know

  const spec = INSTRUCTIONS[mnemonic];
  const reg = (i) => REGISTER_NAMES[i];
  const name = (target) => labelNames.get(target) ?? `0x${hex(target, 4)}`;

  let operands;
  switch (spec.operands) {
    case 'rd,rs,rt': operands = [reg(d.rd), reg(d.rs), reg(d.rt)]; break;
    case 'rd,rt,shamt': operands = [reg(d.rd), reg(d.rt), String(d.shamt)]; break;
    case 'rd,rt,rs': operands = [reg(d.rd), reg(d.rt), reg(d.rs)]; break;
    case 'rs,rt': operands = [reg(d.rs), reg(d.rt)]; break;
    case 'rs': operands = [reg(d.rs)]; break;
    case 'rd': operands = [reg(d.rd)]; break;
    case '': operands = []; break;
    case 'rt,rs,imm':
      operands = [reg(d.rt), reg(d.rs), spec.imm === 'unsigned' ? `0x${hex(d.imm, 4)}` : String(d.simm)];
      break;
    case 'rt,imm': operands = [reg(d.rt), `0x${hex(d.imm, 4)}`]; break;
    case 'rt,mem': operands = [reg(d.rt), `${d.simm}(${reg(d.rs)})`]; break;
    case 'rs,rt,label': operands = [reg(d.rs), reg(d.rt), name((address + 4 + d.simm * 4) >>> 0)]; break;
    case 'rt,label': operands = [reg(d.rt), name(d.imm)]; break;
    case 'label': operands = [name((((address + 4) & 0xf0000000) | (d.target << 2)) >>> 0)]; break;
    default: operands = [];
  }
  return operands.length ? `${mnemonic} ${operands.join(', ')}` : mnemonic;
}

/** Invert an assembler label map (name -> address) into address -> first name. */
export function labelsByAddress(labels) {
  const result = new Map();
  for (const [labelName, address] of labels) {
    if (!result.has(address)) result.set(address, labelName);
  }
  return result;
}

function hex(value, digits) {
  return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}
