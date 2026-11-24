import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBuilder, CircuitError, Simulator, chipInterface, compile, fromJSON, packageAsChip, toJSON, truthTable,
} from '../src/index.js';
import { loadExample } from './helpers.js';

const halfAdder = () => loadExample('half-adder');

test('packageAsChip: pins come from labelled INPUT/OUTPUT, ordered by position', () => {
  const chip = packageAsChip(halfAdder(), 'ha');
  const iface = chipInterface(chip);
  assert.deepEqual(iface.inputs.map((p) => p.label), ['A', 'B']);
  assert.deepEqual(iface.outputs.map((p) => p.label), ['S', 'C']);
});

test('a packaged chip behaves like the circuit it came from', () => {
  const b = new CircuitBuilder('uses-ha');
  b.defineChip('ha', packageAsChip(halfAdder(), 'ha'));
  const u = b.chip('ha', { A: b.input('X', { y: 0 }), B: b.input('Y', { y: 40 }) }, { id: 'u1' });
  b.output('SUM', `${u}.S`, { y: 0 });
  b.output('CARRY', `${u}.C`, { y: 40 });
  const tt = truthTable(b.build());
  assert.deepEqual(tt.rows.map((r) => r.outputs.join('')), ['00', '10', '10', '01']);
});

test('flattening: nested chips become prefixed primitives with no extra delay', () => {
  const flat = compile(loadExample('4-bit-adder'));
  const paths = flat.comps.map((c) => c.path);
  assert.ok(paths.includes('fa0/ha1/x1'), 'fa0 -> ha1 -> x1');
  assert.ok(paths.includes('fa3/o1'));
  assert.ok(!paths.some((p) => /\/(A|B|S|C|CIN|COUT)$/.test(p)), 'inner INPUT/OUTPUT pins are aliases, not components');
  // Chip pins resolve to the same net as the inner wire they alias.
  assert.equal(flat.nodeNet.get('fa0.COUT'), flat.nodeNet.get('fa1.CIN'));
  assert.equal(flat.nodeNet.get('fa0.COUT'), flat.nodeNet.get('fa0/o1.out'));

  // A full adder from chips has the same timing as one drawn flat.
  const sim = new Simulator(loadExample('full-adder'));
  sim.setInput('A', 1); sim.setInput('B', 0); sim.settle();
  sim.watch('COUT');
  const t0 = sim.time;
  sim.setInput('CIN', 1); sim.settle();
  assert.deepEqual(sim.history('COUT').filter(([t]) => t > t0), [[t0 + 2, 1]], 'AND + OR = 2 ticks');
});

test('chips nest: a 2-bit adder chip made of full-adder chips made of half-adder chips', () => {
  const two = new CircuitBuilder('two');
  two.defineChip('fa', packageAsChip(loadExample('full-adder'), 'fa'));
  const f0 = two.chip('fa', { A: two.input('A0', { y: 0 }), B: two.input('B0', { y: 40 }), CIN: two.constant(0) }, { id: 'f0' });
  const f1 = two.chip('fa', { A: two.input('A1', { y: 80 }), B: two.input('B1', { y: 120 }), CIN: `${f0}.COUT` }, { id: 'f1' });
  two.output('S0', `${f0}.S`, { y: 0 });
  two.output('S1', `${f1}.S`, { y: 40 });
  two.output('C', `${f1}.COUT`, { y: 80 });
  const add2 = packageAsChip(two.build(), 'add2');

  const top = new CircuitBuilder('top');
  top.defineChip('add2', add2);
  const ins = ['A0', 'B0', 'A1', 'B1'].map((n, i) => top.input(n, { y: i * 40 }));
  const u = top.chip('add2', { A0: ins[0], B0: ins[1], A1: ins[2], B1: ins[3] }, { id: 'u' });
  ['S0', 'S1', 'C'].forEach((p, i) => top.output(p, `${u}.${p}`, { y: i * 40 }));
  const circuit = fromJSON(toJSON(top.build()));
  const sim = new Simulator(circuit);
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    sim.setInput('A0', a & 1); sim.setInput('A1', a >> 1);
    sim.setInput('B0', b & 1); sim.setInput('B1', b >> 1);
    sim.settle();
    assert.equal(sim.readNumber(['C', 'S1', 'S0']), a + b);
  }
  assert.ok(sim.flat.comps.some((c) => c.path === 'u/f1/ha2/a1'), 'three levels deep');
});

test('recursion is rejected: direct and indirect', () => {
  const selfRef = toJSON(new CircuitBuilder('loop').build());
  selfRef.chips = {
    a: { name: 'a', components: [{ id: 'i', type: 'INPUT', x: 0, y: 0, label: 'I' }, { id: 'o', type: 'OUTPUT', x: 0, y: 0, label: 'O' }, { id: 'me', type: 'SUBCIRCUIT', x: 0, y: 0, props: { chip: 'a' } }], wires: [] },
  };
  selfRef.components.push({ id: 'u', type: 'SUBCIRCUIT', x: 0, y: 0, props: { chip: 'a' } });
  assert.throws(() => fromJSON(selfRef), /recursive chip: a -> a/);

  const indirect = structuredClone(selfRef);
  indirect.chips.a.components[2].props.chip = 'b';
  indirect.chips.b = { name: 'b', components: [{ id: 'x', type: 'SUBCIRCUIT', x: 0, y: 0, props: { chip: 'a' } }], wires: [] };
  assert.throws(() => fromJSON(indirect), /recursive chip: a -> b -> a/);
  assert.throws(() => compile(indirect), CircuitError);

  // Packaging a circuit under the name of a chip it already uses.
  const user = new CircuitBuilder('user');
  user.defineChip('ha', packageAsChip(halfAdder(), 'ha'));
  const u = user.chip('ha', { A: user.input('A'), B: user.input('B') });
  user.output('S', `${u}.S`);
  assert.throws(() => packageAsChip(user.build(), 'ha'), /recursive chip: ha -> ha/);
});

test('chip errors: missing chip, unlabelled pins, nothing to package', () => {
  const c = toJSON(new CircuitBuilder('x').build());
  c.components.push({ id: 'u', type: 'SUBCIRCUIT', x: 0, y: 0, props: { chip: 'nope' } });
  assert.throws(() => fromJSON(c), /unknown chip "nope"/);

  const noLabel = new CircuitBuilder('n');
  noLabel.add('INPUT', { id: 'i' });
  noLabel.add('OUTPUT', { id: 'o', label: 'Y' });
  noLabel.wire('i.out', 'o.in');
  assert.throws(() => packageAsChip(noLabel.build(), 'n'), /needs a label/);
  assert.throws(() => packageAsChip(new CircuitBuilder('e').build(), 'e'), /at least one INPUT and one OUTPUT/);
});

test('an unconnected chip input floats to X inside the chip', () => {
  const b = new CircuitBuilder('float');
  b.defineChip('ha', packageAsChip(halfAdder(), 'ha'));
  const u = b.chip('ha', { A: b.input('A', { value: 0 }) }); // B left open
  b.output('S', `${u}.S`);
  b.output('C', `${u}.C`);
  const sim = new Simulator(b.build());
  sim.settle();
  assert.equal(sim.read('S'), 2);
  assert.equal(sim.read('C'), 0, 'AND with a known 0 is still 0');
});
