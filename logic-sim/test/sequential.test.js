import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBuilder, Simulator, X } from '../src/index.js';
import { loadExample, runToRisingEdge } from './helpers.js';

test('SR latch (NOR): starts X, then set / hold / reset / hold', () => {
  const sim = new Simulator(loadExample('sr-latch'));
  sim.settle();
  assert.equal(sim.read('Q'), X, 'never written: unknown');

  sim.setInput('S', 1); sim.settle();
  assert.deepEqual([sim.read('Q'), sim.read('QN')], [1, 0], 'set');
  sim.setInput('S', 0); sim.settle();
  assert.deepEqual([sim.read('Q'), sim.read('QN')], [1, 0], 'hold after set');

  sim.setInput('R', 1); sim.settle();
  assert.deepEqual([sim.read('Q'), sim.read('QN')], [0, 1], 'reset');
  sim.setInput('R', 0); sim.settle();
  assert.deepEqual([sim.read('Q'), sim.read('QN')], [0, 1], 'hold after reset');
});

test('SR latch race: releasing S=R=1 at the same instant oscillates', () => {
  const sim = new Simulator(loadExample('sr-latch'));
  sim.setInput('S', 1); sim.setInput('R', 1); sim.settle();
  assert.deepEqual([sim.read('Q'), sim.read('QN')], [0, 0], 'forbidden state');
  sim.setInput('S', 0); sim.setInput('R', 0);
  const res = sim.settle();
  assert.equal(res.stable, false);
  assert.equal(res.reason, 'oscillation');
  assert.equal(res.period, 2, 'both NORs flip together every tick');
  assert.deepEqual(res.nets.sort(), ['n1.out', 'n2.out']);
});

function dffCircuit() {
  const b = new CircuitBuilder('dff');
  const D = b.input('D'), C = b.input('C'), R = b.input('R', { y: 80 });
  b.dff({ id: 'ff', d: D, clk: C, rst: R });
  b.output('Q', 'ff.q');
  b.output('QN', 'ff.qn');
  return b.build();
}

test('built-in D flip-flop: captures D only on a rising clock edge', () => {
  const sim = new Simulator(dffCircuit());
  sim.settle();
  assert.equal(sim.read('Q'), X, 'power-on state is unknown');

  sim.setInput('D', 1); sim.settle();
  assert.equal(sim.read('Q'), X, 'D alone does nothing');
  sim.setInput('C', 1); sim.settle();
  assert.deepEqual([sim.read('Q'), sim.read('QN')], [1, 0], 'rising edge captures 1');

  sim.setInput('D', 0); sim.settle();
  assert.equal(sim.read('Q'), 1, 'D changes while CLK high are ignored');
  sim.setInput('C', 0); sim.settle();
  assert.equal(sim.read('Q'), 1, 'falling edge does nothing');
  sim.setInput('C', 1); sim.settle();
  assert.equal(sim.read('Q'), 0, 'next rising edge captures 0');
});

test('D flip-flop: output appears one tick after the edge', () => {
  const sim = new Simulator(dffCircuit());
  sim.setInput('D', 1); sim.settle();
  sim.setInput('C', 1);
  assert.equal(sim.read('Q'), X);
  sim.step();
  assert.equal(sim.read('Q'), 1);
});

test('D flip-flop: asynchronous reset, and an X clock edge makes Q unknown', () => {
  const sim = new Simulator(dffCircuit());
  sim.setInput('R', 1); sim.settle();
  assert.equal(sim.read('Q'), 0, 'reset clears without a clock');
  sim.setInput('D', 1); sim.setInput('C', 1); sim.settle();
  assert.equal(sim.read('Q'), 0, 'reset dominates the clock');
  sim.setInput('R', 0); sim.setInput('C', 0); sim.settle();
  sim.setInput('C', 'X'); sim.settle();
  assert.equal(sim.read('Q'), X, '0 -> X might be an edge; D=1 differs from Q=0');
});

test('D flip-flop: unconnected reset is inactive (floats to 0, not X)', () => {
  const b = new CircuitBuilder('dff-norst');
  b.dff({ id: 'ff', d: b.input('D', { value: 1 }), clk: b.input('C') });
  b.output('Q', 'ff.q');
  const sim = new Simulator(b.build());
  sim.setInput('C', 1); sim.settle();
  assert.equal(sim.read('Q'), 1);
});

test('master-slave D flip-flop from NAND gates is positive-edge triggered', () => {
  const circuit = loadExample('d-flip-flop');
  const sim = new Simulator(circuit);
  sim.settle();
  assert.equal(sim.read('Q'), X, 'slave not written before the first rising edge');
  let d = 1;
  for (let cycle = 0; cycle < 6; cycle++) {
    sim.setInput('D', d);
    runToRisingEdge(sim, 'CLK');
    sim.run(6);                     // through NOT + two NAND levels of the slave
    assert.equal(sim.read('Q'), d, `cycle ${cycle}: Q took D at the edge`);
    assert.equal(sim.read('QN'), 1 - d);
    sim.setInput('D', 1 - d);       // change D while CLK is high: no effect
    sim.run(3);
    assert.equal(sim.read('Q'), d, `cycle ${cycle}: master closed while CLK high`);
    d = cycle % 3 === 0 ? d : 1 - d;
  }
});

test('4-bit counter from flip-flops counts 0..15 and wraps over 20 clock cycles', () => {
  const sim = new Simulator(loadExample('4-bit-counter'));
  const bits = ['Q3', 'Q2', 'Q1', 'Q0'];
  sim.setInput('RST', 1);
  sim.run(3);
  assert.equal(sim.readNumber(bits), 0);
  sim.setInput('RST', 0);
  sim.watch('Q0');
  for (let k = 1; k <= 20; k++) {
    runToRisingEdge(sim, 'CLK');
    sim.run(3); // flip-flop delay + let the next-state logic settle
    assert.equal(sim.readNumber(bits), k % 16, `after ${k} edges`);
    assert.equal(sim.display('hex').value, k % 16, '7-segment shows the count');
  }
  // Q0 toggles every clock: 20 changes recorded after the reset was released.
  assert.equal(sim.history('Q0').filter(([t]) => t > 3).length, 20);
});

test('4-bit counter from X: without reset the toggle logic stays unknown', () => {
  const b = new CircuitBuilder('t');
  const clk = b.clock('CLK', 4);
  const ff = b.dff({ id: 'ff', clk }); // init X
  b.wire(b.not('ff.q'), 'ff.d');
  b.output('Q', 'ff.q');
  const sim = new Simulator(b.build());
  sim.run(40);
  assert.equal(sim.read('Q'), X, 'X pessimism: NOT X = X, so a toggle flop never resolves');
  void ff;
});

test('traffic-light state machine cycles GREEN -> AMBER -> RED and waits for REQ', () => {
  const sim = new Simulator(loadExample('traffic-light'));
  const lights = () => ['GREEN', 'AMBER', 'RED'].filter((l) => sim.read(l) === 1).join();
  sim.settle();
  assert.equal(lights(), 'GREEN');
  const seen = [];
  for (let i = 0; i < 6; i++) {
    runToRisingEdge(sim, 'CLK');
    sim.run(3);
    seen.push(lights());
  }
  assert.deepEqual(seen, ['AMBER', 'RED', 'GREEN', 'AMBER', 'RED', 'GREEN']);
  sim.setInput('REQ', 0);
  for (let i = 0; i < 3; i++) { runToRisingEdge(sim, 'CLK'); sim.run(3); }
  assert.equal(lights(), 'GREEN', 'no request: stays green');
});
