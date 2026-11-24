// cpu.js - fetch, decode and execute.
//
// This finishes the CPU from lab8.c. The C version could fetch and decode
// (CPU_fetchCode, CPU_Decode) but CPU_Execution only had the `la` example.
// The loop is the same as CPU() in lab8.c:
//
//     fetch the word at PC  ->  PC += 4  ->  decode  ->  execute
//
// Because PC has already moved on by the time an instruction executes, a
// branch adds its offset to "PC + 4", exactly like real MIPS hardware.
//
// Registers are stored in a Uint32Array, so every value written to a register
// is automatically wrapped to an unsigned 32-bit number. When an instruction
// needs the signed value (slt, bge, sra, ...) we read it with `| 0`.

import { OPCODE, FUNCT, FUNCT2, TEXT_BASE, DATA_BASE, STACK_TOP, REGISTER_NAMES } from './isa.js';
import { Memory } from './memory.js';
import { MipsError, hex32 } from './errors.js';

const SP = 29; // $sp
const RA = 31; // $ra
const V0 = 2;  // $v0
const A0 = 4;  // $a0

/**
 * Split a machine word into all of its possible fields.
 * Port of CPU_Decode() in lab8.c, which only extracted the opcode. R-type
 * instructions all share opcode 0, so the funct field is needed as well.
 */
export function decode(word) {
  return {
    opcode: (word >>> 26) & 0x3f,  // bits 31-26
    rs: (word >>> 21) & 0x1f,      // bits 25-21
    rt: (word >>> 16) & 0x1f,      // bits 20-16
    rd: (word >>> 11) & 0x1f,      // bits 15-11
    shamt: (word >>> 6) & 0x1f,    // bits 10-6
    funct: word & 0x3f,            // bits 5-0
    imm: word & 0xffff,            // bits 15-0, zero-extended (andi, ori, xori, lui, la)
    simm: (word << 16) >> 16,      // bits 15-0, sign-extended (addi, lw, sw, branches)
    target: word & 0x03ffffff,     // bits 25-0 (j, jal)
  };
}

export class CPU {
  constructor(memory = new Memory()) {
    this.memory = memory;
    this.program = null;
    this.lineForAddress = new Map();
    this.codeEnd = TEXT_BASE; // address just after the last instruction (no program yet)
    this.onOutput = null; // optional callback(text) for syscall output
    this.reset();
  }

  /** Clear registers and state. Memory is left alone (load() resets it). */
  reset() {
    this.regs = new Uint32Array(32); // the 32 general purpose registers (regFile in header.h)
    this.hi = 0;
    this.lo = 0;
    this.pc = TEXT_BASE;             // PCRegister = CODESECTION
    this.regs[SP] = STACK_TOP;
    this.steps = 0;                  // instructions executed so far
    this.halted = false;
    this.haltReason = '';
    this.error = null;
    this.output = '';
    this.lastStep = null;            // { pc, word, line } of the last executed instruction
    this.lastWrite = null;           // { address, size } of the last store, for the UI
  }

  /**
   * Put an assembled program into memory (loadCodeToMem in lab7.c):
   * code at 0x0000, data at 0x2000, then reset the registers.
   */
  load(program) {
    this.program = program;
    this.memory.clear();
    program.text.forEach((word, i) => this.memory.writeWord(program.textBase + i * 4, word));
    this.memory.loadBytes(program.dataBase, program.data);
    this.lineForAddress = new Map(program.listing.map((entry) => [entry.address, entry.line]));
    this.codeEnd = program.codeEnd;
    this.reset();
  }

  /** Read a register as a signed 32-bit number. */
  signed(index) {
    return this.regs[index] | 0;
  }

  /** Write a register. $zero is hard-wired to 0, so writes to it are ignored. */
  setReg(index, value) {
    if (index !== 0) this.regs[index] = value; // Uint32Array wraps the value to 32 bits
  }

  /**
   * Execute one instruction.
   * @returns {{pc: number, word: number, line: number|null} | null} null if already halted
   * @throws {MipsError} on any run-time error (the CPU is halted afterwards)
   */
  step() {
    if (this.halted) return null;

    const pc = this.pc;
    // Running past the last instruction ends the program. This replaces the
    // "stop when the fetched word is 0" rule of lab8.c, because 0x00000000 is
    // a valid instruction (nop).
    if (pc === this.codeEnd) {
      this.halt('reached the end of the program');
      return null;
    }

    try {
      if (pc % 4 !== 0 || pc < TEXT_BASE || pc >= this.codeEnd) {
        throw new MipsError(`PC out of range: ${hex32(pc)} is not an instruction in the code section`, { address: pc });
      }
      this.lastWrite = null;
      const word = this.memory.readWord(pc);  // 1. fetch   (CPU_fetchCode)
      this.pc = (pc + 4) >>> 0;               // 2. PC += 4 (PC now points to the next instruction)
      const d = decode(word);                 // 3. decode  (CPU_Decode)
      this.execute(d, word);                  // 4. execute (CPU_Execution)
      this.steps++;
      this.lastStep = { pc, word, line: this.lineForAddress.get(pc) ?? null };
      return this.lastStep;
    } catch (err) {
      const error = err instanceof MipsError ? err : new MipsError(String(err.message || err));
      if (error.line === null) {
        // If PC itself is bad, blame the jump/branch that sent us there.
        error.line = this.lineForAddress.get(pc) ?? this.lastStep?.line ?? null;
      }
      this.halted = true;
      this.error = error;
      this.haltReason = 'error';
      throw error;
    }
  }

  /**
   * Keep stepping until the program halts.
   * @param {number} maxSteps safety limit so an infinite loop cannot freeze the page
   * @returns {number} instructions executed by this call
   */
  run(maxSteps = 1_000_000) {
    let count = 0;
    while (!this.halted) {
      if (count >= maxSteps) {
        const line = this.lineForAddress.get(this.pc) ?? null;
        throw new MipsError(`Step limit of ${maxSteps} instructions reached (infinite loop?)`, { line, address: this.pc });
      }
      if (this.step() !== null) count++;
    }
    return count;
  }

  halt(reason) {
    this.halted = true;
    this.haltReason = reason;
  }

  // -------------------------------------------------------------------------
  // Execute (CPU_Execution in lab8.c): one case per opcode
  // -------------------------------------------------------------------------
  execute(d, word) {
    const { opcode, rs, rt, simm, imm } = d;

    switch (opcode) {
      case OPCODE.SPECIAL: // every R-type instruction: look at funct
        this.executeRType(d, word);
        break;

      case OPCODE.SPECIAL2:
        if (d.funct !== FUNCT2.MUL) throw unknownInstruction(word);
        this.setReg(d.rd, Math.imul(this.regs[rs], this.regs[rt])); // low 32 bits of the product
        break;

      // ---- course-defined la: rt = 16-bit address from the immediate field ----
      case OPCODE.LA:
        this.setReg(rt, imm);
        break;

      // ---- immediate arithmetic and logic ----
      case OPCODE.ADDI:
        this.setReg(rt, addWithOverflowCheck(this.signed(rs), simm, 'addi'));
        break;
      case OPCODE.ADDIU:
        this.setReg(rt, this.regs[rs] + simm);
        break;
      case OPCODE.SLTI:
        this.setReg(rt, this.signed(rs) < simm ? 1 : 0);
        break;
      case OPCODE.SLTIU: // immediate is sign-extended, then both sides compared as unsigned
        this.setReg(rt, this.regs[rs] < (simm >>> 0) ? 1 : 0);
        break;
      case OPCODE.ANDI:
        this.setReg(rt, this.regs[rs] & imm);
        break;
      case OPCODE.ORI:
        this.setReg(rt, this.regs[rs] | imm);
        break;
      case OPCODE.XORI:
        this.setReg(rt, this.regs[rs] ^ imm);
        break;
      case OPCODE.LUI:
        this.setReg(rt, imm << 16);
        break;

      // ---- loads and stores: address = rs + sign-extended offset ----
      case OPCODE.LB: {
        const byte = this.memory.readByte(this.effectiveAddress(d));
        this.setReg(rt, (byte << 24) >> 24); // sign-extend bit 7
        break;
      }
      case OPCODE.LBU:
        this.setReg(rt, this.memory.readByte(this.effectiveAddress(d)));
        break;
      case OPCODE.LW:
        this.setReg(rt, this.memory.readWord(this.effectiveAddress(d)));
        break;
      case OPCODE.SB: {
        const address = this.effectiveAddress(d);
        this.memory.writeByte(address, this.regs[rt]);
        this.lastWrite = { address, size: 1 };
        break;
      }
      case OPCODE.SW: {
        const address = this.effectiveAddress(d);
        this.memory.writeWord(address, this.regs[rt]);
        this.lastWrite = { address, size: 4 };
        break;
      }

      // ---- branches: compare, then PC = PC + 4 + offset * 4 ----
      case OPCODE.BEQ:
        if (this.regs[rs] === this.regs[rt]) this.branch(simm);
        break;
      case OPCODE.BNE:
        if (this.regs[rs] !== this.regs[rt]) this.branch(simm);
        break;
      case OPCODE.BGE:
        if (this.signed(rs) >= this.signed(rt)) this.branch(simm);
        break;
      case OPCODE.BLT:
        if (this.signed(rs) < this.signed(rt)) this.branch(simm);
        break;
      case OPCODE.BGT:
        if (this.signed(rs) > this.signed(rt)) this.branch(simm);
        break;
      case OPCODE.BLE:
        if (this.signed(rs) <= this.signed(rt)) this.branch(simm);
        break;

      // ---- jumps: PC = upper 4 bits of PC + 4, followed by target * 4 ----
      case OPCODE.J:
        this.jump(d.target);
        break;
      case OPCODE.JAL:
        this.setReg(RA, this.pc); // this.pc is already the return address (PC + 4)
        this.jump(d.target);
        break;

      default:
        throw unknownInstruction(word);
    }
  }

  executeRType(d, word) {
    const { rs, rt, rd, shamt } = d;
    const r = this.regs;

    switch (d.funct) {
      case FUNCT.ADD:
        this.setReg(rd, addWithOverflowCheck(this.signed(rs), this.signed(rt), 'add'));
        break;
      case FUNCT.ADDU:
        this.setReg(rd, r[rs] + r[rt]);
        break;
      case FUNCT.SUB:
        this.setReg(rd, addWithOverflowCheck(this.signed(rs), -this.signed(rt), 'sub'));
        break;
      case FUNCT.SUBU:
        this.setReg(rd, r[rs] - r[rt]);
        break;
      case FUNCT.AND:
        this.setReg(rd, r[rs] & r[rt]);
        break;
      case FUNCT.OR:
        this.setReg(rd, r[rs] | r[rt]);
        break;
      case FUNCT.XOR:
        this.setReg(rd, r[rs] ^ r[rt]);
        break;
      case FUNCT.NOR:
        this.setReg(rd, ~(r[rs] | r[rt]));
        break;
      case FUNCT.SLT:
        this.setReg(rd, this.signed(rs) < this.signed(rt) ? 1 : 0);
        break;
      case FUNCT.SLTU:
        this.setReg(rd, r[rs] < r[rt] ? 1 : 0);
        break;

      case FUNCT.SLL:
        this.setReg(rd, r[rt] << shamt);
        break;
      case FUNCT.SRL:
        this.setReg(rd, r[rt] >>> shamt);            // logical: fill with zeros
        break;
      case FUNCT.SRA:
        this.setReg(rd, this.signed(rt) >> shamt);   // arithmetic: copy the sign bit
        break;
      case FUNCT.SLLV:
        this.setReg(rd, r[rt] << (r[rs] & 31));
        break;
      case FUNCT.SRLV:
        this.setReg(rd, r[rt] >>> (r[rs] & 31));
        break;
      case FUNCT.SRAV:
        this.setReg(rd, this.signed(rt) >> (r[rs] & 31));
        break;

      case FUNCT.MULT: {
        const product = BigInt(this.signed(rs)) * BigInt(this.signed(rt)); // 64-bit result
        this.lo = Number(product & 0xffffffffn);
        this.hi = Number((product >> 32n) & 0xffffffffn);
        break;
      }
      case FUNCT.MULTU: {
        const product = BigInt(r[rs]) * BigInt(r[rt]);
        this.lo = Number(product & 0xffffffffn);
        this.hi = Number((product >> 32n) & 0xffffffffn);
        break;
      }
      case FUNCT.DIV:
        if (r[rt] === 0) throw new MipsError('Division by zero');
        this.lo = Math.trunc(this.signed(rs) / this.signed(rt)) >>> 0; // C-style: round toward zero
        this.hi = (this.signed(rs) % this.signed(rt)) >>> 0;           // remainder has the sign of rs
        break;
      case FUNCT.DIVU:
        if (r[rt] === 0) throw new MipsError('Division by zero');
        this.lo = Math.floor(r[rs] / r[rt]) >>> 0;
        this.hi = (r[rs] % r[rt]) >>> 0;
        break;
      case FUNCT.MFHI:
        this.setReg(rd, this.hi);
        break;
      case FUNCT.MFLO:
        this.setReg(rd, this.lo);
        break;

      case FUNCT.JR:
        this.pc = r[rs]; // checked on the next fetch (must be an aligned code address)
        break;
      case FUNCT.SYSCALL:
        this.syscall();
        break;

      default:
        throw unknownInstruction(word);
    }
  }

  effectiveAddress(d) {
    return (this.regs[d.rs] + d.simm) >>> 0;
  }

  /** this.pc already holds PC + 4, so the offset is counted from there. */
  branch(offset) {
    this.pc = (this.pc + offset * 4) >>> 0;
  }

  jump(target) {
    this.pc = ((this.pc & 0xf0000000) | (target << 2)) >>> 0;
  }

  /**
   * syscall: the service number is in $v0 (MARS/SPIM convention).
   *    1  print the integer in $a0
   *    4  print the NUL-terminated string at address $a0
   *   11  print the character in $a0
   *   10  exit
   *    0  exit - the course program (MIPS.asm) calls syscall without setting
   *       $v0, and the lab treated syscall as "the end of the program".
   */
  syscall() {
    const service = this.regs[V0];
    switch (service) {
      case 1:
        this.print(String(this.signed(A0)));
        break;
      case 4:
        this.print(this.readString(this.regs[A0]));
        break;
      case 11:
        this.print(String.fromCharCode(this.regs[A0] & 0xff));
        break;
      case 10:
        this.halt('exit (syscall 10)');
        break;
      case 0:
        this.halt('syscall with $v0 = 0 (end of program)');
        break;
      default:
        throw new MipsError(`Unsupported syscall service ${service} in $v0 (supported: 1, 4, 10, 11)`);
    }
  }

  print(text) {
    this.output += text;
    if (this.onOutput) this.onOutput(text);
  }

  readString(address) {
    const bytes = [];
    for (let a = address; ; a++) {
      const byte = this.memory.readByte(a);
      if (byte === 0) break;
      bytes.push(byte);
      if (bytes.length > 10000) throw new MipsError(`String at ${hex32(address)} has no NUL terminator`);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  /** Register file printout in the style of printRegisterFiles() in lab8.c. */
  registerDump() {
    const lines = REGISTER_NAMES.map((name, i) => `${name.padEnd(5)} = ${hex32(this.regs[i]).slice(2)}`);
    lines.push(`${'lo'.padEnd(5)} = ${hex32(this.lo).slice(2)}`);
    lines.push(`${'hi'.padEnd(5)} = ${hex32(this.hi).slice(2)}`);
    lines.push(`${'pc'.padEnd(5)} = ${hex32(this.pc).slice(2)}`);
    return lines.join('\n');
  }

  /** Data section dump, like printDataMemoryDump() in lab8.c. */
  dataDump(length = 256) {
    return this.memory.dump(DATA_BASE, length);
  }
}

/** Signed add that throws on overflow, like the real add/addi/sub instructions. */
function addWithOverflowCheck(a, b, name) {
  const result = a + b;                 // exact, because JS numbers have 53 bits
  if (result > 0x7fffffff || result < -0x80000000) {
    throw new MipsError(`Arithmetic overflow in ${name} (${a} + ${b} does not fit in 32 bits)`);
  }
  return result;
}

function unknownInstruction(word) {
  const d = decode(word);
  return new MipsError(`Unknown instruction ${hex32(word)} (opcode 0x${d.opcode.toString(16)}, funct 0x${d.funct.toString(16)})`);
}
