import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBuilder, Simulator, hexToSegments } from '../src/index.js';

// Segment names: a top, b upper right, c lower right, d bottom, e lower left, f upper left, g middle.
const EXPECTED = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc',
  8: 'abcdefg', 9: 'abcdfg', 10: 'abcefg', 11: 'cdefg', 12: 'adef', 13: 'bcdeg', 14: 'adefg', 15: 'aefg',
};

test('7-segment decoder: every hex digit lights the right segments', () => {
  for (let v = 0; v < 16; v++) assert.equal(hexToSegments(v), EXPECTED[v], v.toString(16));
});

test('SEG7 component decodes its 4-bit input (d0 = LSB) and shows nothing for X', () => {
  const b = new CircuitBuilder('seg');
  const bits = [0, 1, 2, 3].map((i) => b.input(`B${i}`, { y: i * 40 }));
  b.add('SEG7', { id: 'disp' });
  bits.slice(0, 3).forEach((s, i) => b.wire(s, `disp.d${i}`));
  const sim = new Simulator(b.build());
  sim.settle();
  assert.equal(sim.display('disp'), null, 'd3 unconnected -> X -> blank');

  const full = b.build();
  full.wires.push({ from: 'B3.out', to: 'disp.d3' });
  const sim2 = new Simulator(full);
  for (let v = 0; v < 16; v++) {
    for (let i = 0; i < 4; i++) sim2.setInput(`B${i}`, (v >> i) & 1);
    sim2.settle();
    const shown = sim2.display('disp');
    assert.equal(shown.value, v);
    assert.equal(shown.segments, EXPECTED[v]);
    assert.equal(shown.char, v.toString(16).toUpperCase());
  }
});
