import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIDX, encodeIDXUint8 } from '../src/idx.js';

test('parses a hand-made uint8 IDX3 buffer', () => {
  const bytes = Uint8Array.of(
    0x00, 0x00, 0x08, 0x03,       // magic: uint8, 3 dimensions
    0x00, 0x00, 0x00, 0x02,       // dim 0 = 2
    0x00, 0x00, 0x00, 0x02,       // dim 1 = 2
    0x00, 0x00, 0x00, 0x03,       // dim 2 = 3
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 255,
  );
  const r = parseIDX(bytes.buffer);
  assert.equal(r.type, 'uint8');
  assert.deepEqual(r.dims, [2, 2, 3]);
  assert.deepEqual([...r.data], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 255]);
});

test('decodes big-endian multi-byte element types', () => {
  // int32, 1 dimension of 2: values 258 and -1
  const bytes = Uint8Array.of(0, 0, 0x0c, 1, 0, 0, 0, 2, 0, 0, 1, 2, 0xff, 0xff, 0xff, 0xff);
  const r = parseIDX(bytes);
  assert.equal(r.type, 'int32');
  assert.deepEqual([...r.data], [258, -1]);
  // float32 1.5 = 0x3FC00000
  const f = parseIDX(Uint8Array.of(0, 0, 0x0d, 1, 0, 0, 0, 1, 0x3f, 0xc0, 0, 0));
  assert.equal(f.data[0], 1.5);
});

test('rejects bad magic, unknown type and wrong length', () => {
  assert.throws(() => parseIDX(Uint8Array.of(1, 0, 8, 1, 0, 0, 0, 1, 7)), /magic/);
  assert.throws(() => parseIDX(Uint8Array.of(0, 0, 0x42, 1, 0, 0, 0, 1, 7)), /type/);
  assert.throws(() => parseIDX(Uint8Array.of(0, 0, 8, 1, 0, 0, 0, 3, 7, 7)), /expected 11 bytes/);
  assert.throws(() => parseIDX(Uint8Array.of(0, 0)), /short/);
});

test('encodeIDXUint8 round-trips', () => {
  const data = Uint8Array.from({ length: 2 * 28 * 28 }, (_, i) => i % 256);
  const r = parseIDX(encodeIDXUint8([2, 28, 28], data));
  assert.deepEqual(r.dims, [2, 28, 28]);
  assert.deepEqual([...r.data], [...data]);
});
