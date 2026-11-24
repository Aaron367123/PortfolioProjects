import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CircuitBuilder, CircuitError, Simulator, fromJSON, stringify, toJSON, encodeCircuit, decodeCircuit, SCHEMA_VERSION,
} from '../src/index.js';
import { ROOT, exampleIndex, loadExample } from './helpers.js';

test('every example round-trips through stringify/fromJSON unchanged', () => {
  for (const { name } of exampleIndex()) {
    const text = readFileSync(join(ROOT, 'examples', `${name}.json`), 'utf8');
    const once = fromJSON(text);
    assert.equal(stringify(once) + '\n', text, `${name}: file is in normal form`);
    assert.deepEqual(toJSON(fromJSON(stringify(once))), toJSON(once), name);
  }
});

test('a round-tripped circuit simulates identically', () => {
  const original = loadExample('4-bit-counter');
  const copy = fromJSON(JSON.parse(stringify(original)));
  const a = new Simulator(original), b = new Simulator(copy);
  a.run(100); b.run(100);
  assert.deepEqual(Array.from(a.values), Array.from(b.values));
});

const base = () => {
  const b = new CircuitBuilder('t');
  b.output('Y', b.not(b.input('A')));
  return toJSON(b.build());
};

test('fromJSON rejects malformed input with clear errors', () => {
  const bad = (mutate, pattern) => {
    const c = base();
    mutate(c);
    assert.throws(() => fromJSON(c), (e) => e instanceof CircuitError && pattern.test(e.message), pattern.toString());
  };
  assert.throws(() => fromJSON('{nope'), /not valid JSON/);
  bad((c) => { c.schema = 'other'; }, /unknown schema/);
  bad((c) => { c.version = SCHEMA_VERSION + 1; }, /schema version/);
  bad((c) => { c.components[0].type = 'FLUX'; }, /unknown type/);
  bad((c) => { c.components.push({ ...c.components[0] }); }, /duplicate component id/);
  bad((c) => { c.wires.push({ from: 'ghost.out', to: 'Y.in' }); }, /unknown component/);
  bad((c) => { c.wires.push({ from: 'Y.in', to: 'not1.in' }); }, /not an output pin/);
  bad((c) => { c.wires.push({ from: 'A.out', to: 'not1.out' }); }, /not an input pin/);
  bad((c) => { c.components.push({ id: 'B', type: 'INPUT', x: 0, y: 0 }); c.wires.push({ from: 'B.out', to: 'Y.in' }); },
    /two outputs on one net/);
  bad((c) => { c.components.push({ id: 'k', type: 'CLOCK', x: 0, y: 0, props: { period: 3 } }); }, /period/);
  bad((c) => { c.components.push({ id: 'g', type: 'AND', x: 0, y: 0, props: { inputs: 5 } }); }, /2-4 inputs/);
});

test('share codes: deflate + base64url round trip, and the plain fallback', async () => {
  const circuit = loadExample('4-bit-adder');
  const z = await encodeCircuit(circuit);
  const j = await encodeCircuit(circuit, { compress: false });
  assert.equal(z[0], 'z');
  assert.equal(j[0], 'j');
  assert.match(z, /^[A-Za-z0-9_-]+$/, 'URL-safe alphabet, no padding');
  assert.ok(z.length < j.length / 3, `compressed ${z.length} vs plain ${j.length}`);
  assert.deepEqual(toJSON(await decodeCircuit(z)), toJSON(circuit));
  assert.deepEqual(toJSON(await decodeCircuit(j)), toJSON(circuit));
  await assert.rejects(decodeCircuit('q123'), /unrecognised/);
});
