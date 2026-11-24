import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulator, truthTable, criticalPath, gateCount } from '../src/index.js';
import { rippleAdder } from '../scripts/build-examples.js';
import { loadExample } from './helpers.js';

const rowsAsObjects = (tt) =>
  tt.rows.map((r) => ({
    ...Object.fromEntries(tt.inputs.map((n, i) => [n, r.inputs[i]])),
    ...Object.fromEntries(tt.outputs.map((n, i) => [n, Number(r.outputs[i])])),
  }));

test('half adder: S = A xor B, C = A and B', () => {
  const tt = truthTable(loadExample('half-adder'));
  assert.deepEqual(tt.inputs, ['A', 'B']);
  for (const r of rowsAsObjects(tt)) {
    assert.equal(r.S, r.A ^ r.B);
    assert.equal(r.C, r.A & r.B);
  }
});

test('full adder (built from two half-adder chips): all 8 rows', () => {
  const tt = truthTable(loadExample('full-adder'));
  assert.equal(tt.rows.length, 8);
  for (const r of rowsAsObjects(tt)) {
    const sum = r.A + r.B + r.CIN;
    assert.equal(r.S, sum & 1);
    assert.equal(r.COUT, sum >> 1);
  }
});

test('4-bit ripple-carry adder: exhaustive, all 256 input combinations', () => {
  const tt = truthTable(loadExample('4-bit-adder'));
  assert.equal(tt.rows.length, 256);
  let checked = 0;
  for (const r of rowsAsObjects(tt)) {
    let a = 0, b = 0, s = 0;
    for (let i = 0; i < 4; i++) { a |= r[`A${i}`] << i; b |= r[`B${i}`] << i; s |= r[`S${i}`] << i; }
    assert.equal(s | (r.COUT << 4), a + b, `${a} + ${b}`);
    checked++;
  }
  assert.equal(checked, 256);
});

test('4-bit adder via direct simulation agrees with arithmetic', () => {
  const sim = new Simulator(loadExample('4-bit-adder'));
  const bitsOut = ['COUT', 'S3', 'S2', 'S1', 'S0'];
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      for (let i = 0; i < 4; i++) { sim.setInput(`A${i}`, (a >> i) & 1); sim.setInput(`B${i}`, (b >> i) & 1); }
      assert.equal(sim.settle().stable, true);
      assert.equal(sim.readNumber(bitsOut), a + b);
    }
  }
});

/** Ticks from CIN rising (A = all ones, B = 0) until COUT settles: the full carry ripple. */
function carryDelay(bits) {
  const sim = new Simulator(rippleAdder(bits, { carryIn: true }));
  for (let i = 0; i < bits; i++) { sim.setInput(`A${i}`, 1); sim.setInput(`B${i}`, 0); }
  sim.setInput('CIN', 0);
  sim.settle();
  assert.equal(sim.read('COUT'), 0);
  sim.watch('COUT');
  const t0 = sim.time;
  sim.setInput('CIN', 1);
  sim.settle();
  assert.equal(sim.read('COUT'), 1);
  const changes = sim.history('COUT').filter(([t]) => t > t0);
  return changes[changes.length - 1][0] - t0;
}

test('carry propagation delay grows linearly with the number of bits', (t) => {
  const measured = {};
  for (const bits of [1, 2, 4, 8]) {
    const delay = carryDelay(bits);
    const adder = rippleAdder(bits, { carryIn: true });
    const depth = criticalPath(adder).depth;
    const gates = gateCount(adder).gates;
    measured[bits] = { carryDelay: delay, criticalPath: depth, gates };
    // Each full adder adds an AND + OR on the carry path: 2 ticks per bit.
    assert.equal(delay, 2 * bits, `${bits}-bit carry delay`);
    // Longest path: A0 -> XOR -> AND -> OR, then AND -> OR per further bit.
    assert.equal(depth, 2 * bits + 1, `${bits}-bit critical path`);
    assert.equal(gates, 5 * bits);
  }
  t.diagnostic(`measured ${JSON.stringify(measured)}`);
});

test('gate counts flatten nested chips', () => {
  assert.equal(gateCount(loadExample('half-adder')).gates, 2);
  assert.equal(gateCount(loadExample('full-adder')).gates, 5);
  const four = gateCount(loadExample('4-bit-adder'));
  assert.equal(four.gates, 20);
  assert.deepEqual({ XOR: four.byType.XOR, AND: four.byType.AND, OR: four.byType.OR }, { XOR: 8, AND: 8, OR: 4 });
  assert.equal(criticalPath(loadExample('half-adder')).depth, 1);
  assert.equal(criticalPath(loadExample('full-adder')).depth, 3);
  assert.equal(criticalPath(loadExample('4-bit-adder')).depth, 9);
});

test('ripple adder shows transient glitches on the sum while the carry travels', () => {
  const sim = new Simulator(rippleAdder(4, { carryIn: true }));
  for (let i = 0; i < 4; i++) { sim.setInput(`A${i}`, 1); sim.setInput(`B${i}`, 0); }
  sim.setInput('CIN', 0);
  sim.settle();
  const seen = new Set();
  sim.setInput('CIN', 1);
  while (sim.pendingEvents) {
    sim.step();
    seen.add(sim.readNumber(['COUT', 'S3', 'S2', 'S1', 'S0']));
  }
  // 15 + 1 = 16, but intermediate (wrong) sums appear on the way there.
  assert.equal(sim.readNumber(['COUT', 'S3', 'S2', 'S1', 'S0']), 16);
  assert.ok(seen.size > 2, `saw intermediate values ${[...seen]}`);
});
