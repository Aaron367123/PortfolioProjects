// errors.js - one error type for the whole emulator.
//
// Every problem the assembler or the CPU detects (unknown instruction, bad
// register, misaligned word access, PC out of range, step limit, ...) is thrown
// as a MipsError. It carries the source line number when we know it, so the
// UI can highlight the line and the tests can check it.

export class MipsError extends Error {
  /**
   * @param {string} message  human readable description (without the line number)
   * @param {object} [where]
   * @param {number|null} [where.line]     1-based source line, if known
   * @param {number|null} [where.address]  memory address involved, if any
   */
  constructor(message, { line = null, address = null } = {}) {
    super(message);
    this.name = 'MipsError';
    this.line = line;
    this.address = address;
  }

  /** "Line 12: Unknown instruction 'addd'" (or just the message when there is no line). */
  describe() {
    return this.line ? `Line ${this.line}: ${this.message}` : this.message;
  }
}

/** Format an address the same way the C labs printed them: 0x00002000. */
export function hex32(value) {
  return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
