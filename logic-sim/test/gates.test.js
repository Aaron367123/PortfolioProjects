import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBuilder, Simulator, GATE_FUNCTIONS, GATE_TYPES, X, and, or, xor, not } from '../src/index.js';
import { combinations } from './helpers.js';

const IDEAL = {
  AND: (b) => b.every(Boolean),
  OR: (b) => b.some(Boolean),
  XOR: (b) => b.filter(Boolean).length % 2 === 1,
  NAND: (b) => !b.every(Boolean),
  NOR: (b) => !b.some(Boolean),
  XNOR: (b) => b.filter(Boolean).length % 2 === 0,
};

/** One gate with n switches, simulated (not just the pure function). */
function gateCircuit(type, n) {
  const b = new CircuitBuilder(`${type}${n}`);
  const ins = Array.from({ length: n }, (_, i) => b.input(`I${i}`, { y: i * 40 }));
  b.output('Y', b.gate(type, ins));
  return b.build();
}

for (const type of GATE_TYPES) {
  for (let n = 2; n <= 4; n++) {
    test(`${type} with ${n} inputs: full truth table through the simulator`, () => {
      const sim = new Simulator(gateCircuit(type, n));
      for (const bits of combinations(n)) {
        bits.forEach((v, i) => sim.setInput(`I${i}`, v));
        assert.equal(sim.settle().stable, true);
        assert.equal(sim.read('Y'), IDEAL[type](bits) ? 1 : 0, `${type}(${bits})`);
      }
    });
  }
}

test('NOT and BUF truth tables', () => {
  for (const type of ['NOT', 'BUF']) {
    const b = new CircuitBuilder(type);
    b.output('Y', b.gate(type, [b.input('A')]));
    const sim = new Simulator(b.build());
    for (const a of [0, 1]) {
      sim.setInput('A', a);
      sim.settle();
      assert.equal(sim.read('Y'), type === 'NOT' ? 1 - a : a);
    }
  }
});

test('three-valued logic: a known value wins only when it decides the result', () => {
  assert.equal(and([0, X]), 0);
  assert.equal(and([1, X]), X);
  assert.equal(or([1, X]), 1);
  assert.equal(or([0, X]), X);
  assert.equal(xor([1, X]), X);
  assert.equal(not(X), X);
  assert.equal(GATE_FUNCTIONS.NAND([0, X]), 1);
  assert.equal(GATE_FUNCTIONS.NOR([1, X]), 0);
  assert.equal(GATE_FUNCTIONS.XNOR([X, X]), X);
  assert.equal(GATE_FUNCTIONS.BUF([X]), X);
});

test('a floating (unconnected) input reads X, and a deciding input still wins', () => {
  const b = new CircuitBuilder('floating');
  const id = b.add('AND', { inputs: 2 });
  b.wire(b.input('A'), `${id}.in0`); // in1 left unconnected
  b.output('Y', `${id}.out`);
  const sim = new Simulator(b.build());
  sim.setInput('A', 1); sim.settle();
  assert.equal(sim.read('Y'), X);
  sim.setInput('A', 0); sim.settle();
  assert.equal(sim.read('Y'), 0);
});

test('unit delay: a gate output changes exactly one tick after its input', () => {
  const b = new CircuitBuilder('chain');
  let s = b.input('A');
  for (let i = 0; i < 3; i++) s = b.not(s);
  b.output('Y', s);
  const sim = new Simulator(b.build());
  sim.settle();
  assert.equal(sim.read('Y'), 1);
  sim.setInput('A', 1);
  const t0 = sim.time;
  sim.step(); sim.step();
  assert.equal(sim.read('Y'), 1, 'two ticks in, the change is still on its way');
  sim.step();
  assert.equal(sim.read('Y'), 0);
  assert.equal(sim.time - t0, 3);
});

test('static hazard: AND(A, NOT A) glitches high for exactly one tick when A rises', () => {
  const b = new CircuitBuilder('hazard');
  const a = b.input('A');
  b.output('Y', b.gate('AND', [a, b.not(a)]));
  const sim = new Simulator(b.build());
  sim.settle();
  sim.watch('Y');
  const t0 = sim.time;
  sim.setInput('A', 1);
  sim.settle();
  const changes = sim.history('Y').filter(([t]) => t > t0);
  assert.deepEqual(changes, [[t0 + 1, 1], [t0 + 2, 0]]);
});
