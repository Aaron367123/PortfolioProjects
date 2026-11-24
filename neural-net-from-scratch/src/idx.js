// idx.js — parser for the IDX format MNIST is distributed in.
//
// Layout (all integers big-endian):
//   byte 0-1  : 0x00 0x00                      magic prefix
//   byte 2    : element type (0x08 = uint8, 0x09 = int8, 0x0B = int16,
//               0x0C = int32, 0x0D = float32, 0x0E = float64)
//   byte 3    : number of dimensions d
//   next 4·d  : size of each dimension (uint32)
//   rest      : the data, row-major
//
// Pure function over bytes, so it runs unchanged in Node and the browser
// (the demo's bundled test samples are tiny IDX files too).

const TYPES = {
  0x08: { name: 'uint8', size: 1, Arr: Uint8Array },
  0x09: { name: 'int8', size: 1, Arr: Int8Array },
  0x0b: { name: 'int16', size: 2, Arr: Int16Array },
  0x0c: { name: 'int32', size: 4, Arr: Int32Array },
  0x0d: { name: 'float32', size: 4, Arr: Float32Array },
  0x0e: { name: 'float64', size: 8, Arr: Float64Array },
};

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{type: string, dims: number[], data: ArrayLike<number>}}
 */
export function parseIDX(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4) throw new Error('IDX: buffer too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0 || bytes[1] !== 0) throw new Error('IDX: bad magic number');
  const t = TYPES[bytes[2]];
  if (!t) throw new Error(`IDX: unknown element type 0x${bytes[2].toString(16)}`);
  const ndim = bytes[3];
  const header = 4 + 4 * ndim;
  if (ndim === 0 || bytes.length < header) throw new Error('IDX: truncated header');
  const dims = [];
  let count = 1;
  for (let i = 0; i < ndim; i++) {
    const d = view.getUint32(4 + 4 * i, false);
    dims.push(d);
    count *= d;
  }
  const expected = header + count * t.size;
  if (bytes.length !== expected) {
    throw new Error(`IDX: expected ${expected} bytes for dims [${dims}], got ${bytes.length}`);
  }
  let data;
  if (t.size === 1) {
    data = new t.Arr(bytes.buffer, bytes.byteOffset + header, count);
  } else {
    // Multi-byte types are big-endian on disk: decode explicitly.
    data = new t.Arr(count);
    const get = { 2: 'getInt16', 4: t.name === 'float32' ? 'getFloat32' : 'getInt32', 8: 'getFloat64' }[t.size];
    for (let i = 0; i < count; i++) data[i] = view[get](header + i * t.size, false);
  }
  return { type: t.name, dims, data };
}

/** Encode a uint8 tensor as IDX (used to bundle demo samples). */
export function encodeIDXUint8(dims, data) {
  const header = 4 + 4 * dims.length;
  const out = new Uint8Array(header + data.length);
  const view = new DataView(out.buffer);
  out[2] = 0x08;
  out[3] = dims.length;
  dims.forEach((d, i) => view.setUint32(4 + 4 * i, d, false));
  out.set(data, header);
  return out;
}
