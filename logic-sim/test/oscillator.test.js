import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBuilder, Simulator, X } from '../src/index.js';
import { loadExample } from './helpers.js';

/** NAND(EN, feedback) followed by `inverters` NOTs, closed into a loop. */
function ring(inverters) {
  const b = new CircuitBuilder(`ring${inverters}`);
  b.add('NAND', { id: 'g0' });
  b.wire(b.input('EN'), 'g0.in0');
  let s = 'g0.out';
  for (let i = 0; i < inverters; i++) s = b.not(s, { id: `inv${i}` });
  b.wire(s, 'g0.in1');
  b.output('OUT', s);
  return b.build();
}

test('ring oscillator example: stable while EN=0, unstable with period 10 once enabled', () => {
  const sim = new Simulator(loadExample('ring-oscillator'));
  assert.equal(sim.settle().stable, true, 'EN=0 forces the NAND high, the ring resolves');
  assert.equal(sim.read('OSC'), 1);
  sim.setInput('EN', 1);
  const res = sim.settle();
  assert.equal(res.stable, false);
  assert.equal(res.reason, 'oscillation');
  assert.equal(res.period, 10, '5 inverting stages x 1 tick, twice round for a full period');
  assert.equal(res.nets.length, 5, 'exactly the five loop nets are reported');
  assert.ok(res.nets.includes('g0.out'));
});

for (const inverters of [2, 4, 6]) {
  const stages = inverters + 1;
  test(`${stages}-stage ring oscillates with period ${2 * stages}`, () => {
    const sim = new Simulator(ring(inverters));
    sim.settle();
    sim.setInput('EN', 1);
    const res = sim.settle();
    assert.equal(res.stable, false);
    assert.equal(res.period, 2 * stages);
    // Keep running: the output really is a square wave with that period.
    sim.watch('OUT');
    sim.run(10 * stages);
    const h = sim.history('OUT');
    const rises = h.filter(([, v], i) => i > 0 && v === 1 && h[i - 1][1] === 0).map(([t]) => t);
    const gaps = rises.slice(1).map((t, i) => t - rises[i]);
    assert.ok(gaps.length >= 3);
    assert.ok(gaps.every((g) => g === 2 * stages), `gaps ${gaps}`);
  });
}

test('an even ring (NAND + 1 NOT, two inversions) settles: it is a latch, not an oscillator', () => {
  const sim = new Simulator(ring(1));
  sim.settle();
  sim.setInput('EN', 1);
  assert.equal(sim.settle().stable, true);
});

test('a ring of pure inverters starting from X never starts (X pessimism)', () => {
  const b = new CircuitBuilder('pure');
  b.add('NOT', { id: 'a' }); b.add('NOT', { id: 'b' }); b.add('NOT', { id: 'c' });
  b.wire('a.out', 'b.in').wire('b.out', 'c.in').wire('c.out', 'a.in');
  b.probe('P', 'c.out');
  const sim = new Simulator(b.build());
  assert.equal(sim.settle().stable, true);
  assert.equal(sim.read('P'), X);
  assert.equal(sim.flat.cycles.length, 1, 'the loop is still found statically');
});

test('oscillation is not reported while a long acyclic circuit is still settling', () => {
  const b = new CircuitBuilder('long');
  let s = b.input('A');
  for (let i = 0; i < 40; i++) s = b.not(s);
  b.output('Y', s);
  const sim = new Simulator(b.build());
  sim.settle();
  sim.setInput('A', 1);
  for (let i = 0; i < 39; i++) { sim.step(); assert.equal(sim.oscillation, null); }
  assert.equal(sim.settle().stable, true);
});

test('per-tick event cap reports runaway activity as unstable', () => {
  const b = new CircuitBuilder('fanout');
  const a = b.input('A');
  for (let i = 0; i < 20; i++) b.output(`Y${i}`, b.not(a));
  const sim = new Simulator(b.build(), { maxEventsPerTick: 10 });
  sim.settle();
  sim.setInput('A', 1);
  const res = sim.settle();
  assert.equal(res.stable, false);
  assert.equal(res.reason, 'event-cap');
  assert.equal(res.nets.length, 20);
});
