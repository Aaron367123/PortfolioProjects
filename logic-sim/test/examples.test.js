import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Simulator, truthTable, criticalPath, gateCount } from '../src/index.js';
import { ROOT, exampleIndex, loadExample } from './helpers.js';

test('index.json lists every example file and each one compiles and simulates', () => {
  const files = readdirSync(join(ROOT, 'examples')).filter((f) => f !== 'index.json').map((f) => f.replace(/\.json$/, ''));
  const listed = exampleIndex().map((e) => e.name);
  assert.deepEqual([...listed].sort(), files.sort());
  assert.equal(listed.length, 10);
  for (const name of listed) {
    const sim = new Simulator(loadExample(name));
    sim.run(50);
    assert.ok(sim.time === 50, name);
  }
});

test('2-to-4 decoder: one-hot outputs, all low when disabled', () => {
  const tt = truthTable(loadExample('2-to-4-decoder'));
  assert.deepEqual(tt.inputs, ['A1', 'A0', 'EN']);
  for (const { inputs: [a1, a0, en], outputs } of tt.rows) {
    const expected = ['0', '0', '0', '0'];
    if (en) expected[a1 * 2 + a0] = '1';
    assert.deepEqual(outputs, expected, `A1=${a1} A0=${a0} EN=${en}`);
  }
});

test('4:1 multiplexer: Y = D[S1 S0] for all 64 input combinations', () => {
  const tt = truthTable(loadExample('4-to-1-mux'));
  assert.deepEqual(tt.inputs, ['S1', 'S0', 'D0', 'D1', 'D2', 'D3']);
  assert.equal(tt.rows.length, 64);
  for (const { inputs: [s1, s0, ...d], outputs: [y] } of tt.rows) {
    assert.equal(Number(y), d[s1 * 2 + s0]);
  }
  assert.equal(criticalPath(loadExample('4-to-1-mux')).depth, 3, 'NOT -> AND -> OR');
});

test('analysis refuses sequential circuits and oversized truth tables', () => {
  assert.throws(() => truthTable(loadExample('4-bit-counter')), /sequential circuit: contains a clock/);
  assert.throws(() => truthTable(loadExample('sr-latch')), /sequential circuit: feedback loop/);
  assert.throws(() => criticalPath(loadExample('ring-oscillator')), /feedback loop/);
  assert.throws(() => truthTable(loadExample('4-bit-adder'), { maxInputs: 7 }), /too many/);
  const counter = gateCount(loadExample('4-bit-counter'));
  assert.deepEqual([counter.gates, counter.flipFlops], [6, 4]);
  assert.equal(gateCount(loadExample('d-flip-flop')).gates, 10);
});
