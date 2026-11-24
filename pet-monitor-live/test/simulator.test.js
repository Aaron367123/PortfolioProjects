import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PetSimulator, mulberry32 } from '../shared/simulator.js';
import { validateReading } from '../shared/validation.js';
import { Monitor } from '../shared/monitor.js';

const START = Date.UTC(2026, 3, 1, 8, 0, 0);

test('same seed => identical stream; different seed => different stream', () => {
  const a = new PetSimulator({ seed: 42, startTs: START });
  const b = new PetSimulator({ seed: 42, startTs: START });
  const c = new PetSimulator({ seed: 43, startTs: START });
  const sa = Array.from({ length: 500 }, () => a.step(1));
  assert.deepEqual(sa, Array.from({ length: 500 }, () => b.step(1)));
  assert.notDeepEqual(sa, Array.from({ length: 500 }, () => c.step(1)));
  assert.equal(mulberry32(1)(), mulberry32(1)());
});

test('one simulated day: every reading is valid; visits, faults and alerts occur', () => {
  const sim = new PetSimulator({ seed: 7, startTs: START });
  const monitor = new Monitor();
  const kinds = new Set();
  let visits = 0;
  for (let i = 0; i < 86_400; i++) {
    const raw = sim.step(1);
    const v = validateReading(raw, { now: raw.ts });
    assert.ok(v.ok, `invalid simulated reading ${JSON.stringify(raw)}: ${v.errors}`);
    for (const m of monitor.ingest(v.value, { receivedAt: raw.ts }).messages) {
      if (m.type === 'alert' && m.data.status === 'active') kinds.add(m.data.rule);
      if (m.type === 'event' && m.data.type === 'visit_end') visits++;
    }
  }
  assert.ok(visits >= 8, `expected several visits, got ${visits}`);
  for (const rule of ['temperature', 'water_ph', 'sensor_fault']) assert.ok(kinds.has(rule), `expected a ${rule} alert, got ${[...kinds]}`);
});
