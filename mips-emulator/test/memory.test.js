import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.js';
import { MipsError } from '../src/errors.js';

test('memory is 1 MB and starts zero-filled', () => {
  const mem = new Memory();
  assert.equal(mem.size, 1024 * 1024);
  assert.equal(mem.readWord(0), 0);
  assert.equal(mem.readByte(mem.size - 1), 0);
});

test('words are stored little-endian', () => {
  const mem = new Memory();
  mem.writeWord(0x2000, 0x11223344);
  assert.equal(mem.readByte(0x2000), 0x44); // least significant byte at the lowest address
  assert.equal(mem.readByte(0x2001), 0x33);
  assert.equal(mem.readByte(0x2002), 0x22);
  assert.equal(mem.readByte(0x2003), 0x11);
  assert.equal(mem.readWord(0x2000), 0x11223344);
});

test('bytes written one at a time read back as a word', () => {
  const mem = new Memory();
  [0xef, 0xbe, 0xad, 0xde].forEach((b, i) => mem.writeByte(0x100 + i, b));
  assert.equal(mem.readWord(0x100), 0xdeadbeef); // returned unsigned
});

test('writeByte keeps only the low 8 bits', () => {
  const mem = new Memory();
  mem.writeByte(5, 0x1ff);
  assert.equal(mem.readByte(5), 0xff);
});

test('misaligned word access throws', () => {
  const mem = new Memory();
  assert.throws(() => mem.readWord(0x2001), (err) => err instanceof MipsError && /Misaligned/.test(err.message));
  assert.throws(() => mem.writeWord(0x2002, 1), /Misaligned/);
});

test('out-of-range access throws', () => {
  const mem = new Memory();
  assert.throws(() => mem.readByte(-1), /outside memory/);
  assert.throws(() => mem.readByte(mem.size), /outside memory/);
  assert.throws(() => mem.writeWord(mem.size - 2, 0), /outside memory/);
});

test('dump prints 16 bytes per line in hex and ASCII, like memory_dump()', () => {
  const mem = new Memory();
  mem.loadBytes(0x2000, [...new TextEncoder().encode('Hello, MIPS!'), 0, 0x7f]);
  const lines = mem.dump(0x2000, 32).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '002000: 48 65 6C 6C 6F 2C 20 4D 49 50 53 21 00 7F 00 00  Hello, MIPS!....');
  assert.ok(lines[1].startsWith('002010: 00 00'));
});

test('rows() groups bytes for the UI', () => {
  const mem = new Memory();
  mem.writeWord(0x10, 0x04030201);
  const rows = mem.rows(0x10, 16, 8);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { address: 0x10, bytes: [1, 2, 3, 4, 0, 0, 0, 0] });
});
