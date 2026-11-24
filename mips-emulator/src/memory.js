// memory.js - 1 MB of byte-addressed, little-endian memory.
//
// Port of memory.c from the C labs:
//   init_memory()  -> new Memory()        (zero-filled, like the memset in init_memory)
//   write_dword()  -> writeWord()
//   read_byte()    -> readByte()
//   read_dword()   -> readWord()
//   memory_dump()  -> dump()              (16 bytes per line, hex + ASCII)
//
// The C version cast the byte pointer to (unsigned int *), so words were stored
// in the host's byte order (little-endian on x86). Here the byte order is
// explicit: the least significant byte goes to the lowest address.
//
// Unlike the C version, every access is checked: addresses outside the 1 MB
// array and word accesses that are not 4-byte aligned throw a MipsError
// instead of silently reading garbage.

import { MEMORY_SIZE } from './isa.js';
import { MipsError, hex32 } from './errors.js';

export const DUMP_LINE = 16;     // bytes per dump line (header.h DUMP_LINE)
export const MIN_DUMP_SIZE = 256; // header.h MIN_DUMP_SIZE

export class Memory {
  constructor(size = MEMORY_SIZE) {
    this.size = size;
    this.bytes = new Uint8Array(size); // a Uint8Array starts out filled with zeros
  }

  /** Fill all of memory with zeros again. */
  clear() {
    this.bytes.fill(0);
  }

  /** Throw if [address, address + length) is not inside memory. */
  checkRange(address, length) {
    if (!Number.isInteger(address) || address < 0 || address + length > this.size) {
      throw new MipsError(`Address ${hex32(address)} is outside memory (1 MB)`, { address });
    }
  }

  /** Throw if a word access is not on a 4-byte boundary (real MIPS raises an exception). */
  checkWordAligned(address) {
    if (address % 4 !== 0) {
      throw new MipsError(`Misaligned word access at ${hex32(address)} (address must be a multiple of 4)`, { address });
    }
  }

  readByte(address) {
    this.checkRange(address, 1);
    return this.bytes[address];
  }

  writeByte(address, value) {
    this.checkRange(address, 1);
    this.bytes[address] = value & 0xff;
  }

  /** Read a 32-bit word (unsigned). Byte at the lowest address is the least significant. */
  readWord(address) {
    this.checkRange(address, 4);
    this.checkWordAligned(address);
    const b = this.bytes;
    return (b[address] | (b[address + 1] << 8) | (b[address + 2] << 16) | (b[address + 3] << 24)) >>> 0;
  }

  /** Write a 32-bit word in little-endian order. */
  writeWord(address, value) {
    this.checkRange(address, 4);
    this.checkWordAligned(address);
    this.bytes[address] = value & 0xff;
    this.bytes[address + 1] = (value >>> 8) & 0xff;
    this.bytes[address + 2] = (value >>> 16) & 0xff;
    this.bytes[address + 3] = (value >>> 24) & 0xff;
  }

  /** Copy an array of bytes into memory starting at address (setupDataMemory in lab7.c). */
  loadBytes(address, bytes) {
    this.checkRange(address, bytes.length);
    this.bytes.set(bytes, address);
  }

  /**
   * Text memory dump in the same format as memory_dump() in memory.c:
   *   002000: 20 00 00 00 0A 00 00 00 0B 00 00 00 0C 00 00 00  ...............
   */
  dump(start, length = MIN_DUMP_SIZE) {
    const lines = [];
    for (const row of this.rows(start, length)) {
      const hexPart = row.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      const asciiPart = row.bytes.map(toPrintable).join('');
      const address = row.address.toString(16).toUpperCase().padStart(6, '0');
      lines.push(`${address}: ${hexPart.padEnd(DUMP_LINE * 3 - 1)}  ${asciiPart}`);
    }
    return lines.join('\n');
  }

  /** The same data as dump(), as objects, for the web UI: [{ address, bytes: [..] }]. */
  rows(start, length = MIN_DUMP_SIZE, bytesPerRow = DUMP_LINE) {
    const end = Math.min(start + length, this.size);
    const rows = [];
    for (let address = start; address < end; address += bytesPerRow) {
      const rowEnd = Math.min(address + bytesPerRow, end);
      rows.push({ address, bytes: Array.from(this.bytes.subarray(address, rowEnd)) });
    }
    return rows;
  }
}

/** Printable ASCII (0x20-0x7E) is shown as itself, everything else as '.' (memory.c rule). */
export function toPrintable(byte) {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}
