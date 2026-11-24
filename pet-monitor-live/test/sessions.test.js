import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../shared/sessions.js';
import { Monitor } from '../shared/monitor.js';
import { gramsToRaw } from '../shared/calibration.js';
import { defaultConfig } from '../shared/config.js';

const T0 = Date.UTC(2026, 0, 10, 9, 0, 0);

/** Builds readings from a presence string: '1' present, '0' absent, '?' sensor failed. */
function series(pattern, weights = () => 300) {
  return [...pattern].map((c, i) => ({ ts: T0 + i * 1000, presence: c === '?' ? null : c === '1', weightG: weights(i) }));
}

function run(pattern, weights, opts = { debounceReadings: 3, minEatenG: 3 }) {
  const t = new SessionTracker();
  return series(pattern, weights).flatMap((r) => t.update(r, opts));
}

test('a visit needs N consecutive presence readings to start and N absences to end', () => {
  const events = run('00011111110000');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'visit_start');
  assert.equal(events[0].ts, T0 + 3000); // start = first reading of the streak
  assert.equal(events[1].type, 'visit_end');
  assert.equal(events[1].endTs, T0 + 9000); // end = last reading that saw the pet
  assert.equal(events[1].durationS, 6);
});

test('single-reading flicker neither starts nor splits a visit', () => {
  assert.deepEqual(run('0010010110100'), []); // never 3 presences in a row
  const events = run('000111101101110110000');
  assert.deepEqual(events.map((e) => e.type), ['visit_start', 'visit_end']); // dropouts of 1 are bridged
});

test('failed presence reads (null) are ignored', () => {
  const events = run('0001?1?11?00?0');
  // '?' neither breaks the arrival streak nor counts towards the absence streak
  assert.deepEqual(events.map((e) => e.type), ['visit_start', 'visit_end']);
  assert.equal(events[0].ts, T0 + 3000);
  assert.equal(events[1].ts, T0 + 13000);
});

test('food eaten = baseline before arrival minus weight after departure; pressing on the bowl ignored', () => {
  // 300 g before; pet presses (+900 g reading) while eating 40 g; 260 g after.
  const pattern = '00000' + '1'.repeat(10) + '0000';
  const weights = (i) => (i < 5 ? 300 : i < 15 ? 1200 - (i - 5) * 4 : 260);
  const events = run(pattern, weights);
  const end = events.find((e) => e.type === 'visit_end');
  assert.equal(end.baselineG, 300);
  assert.equal(end.afterG, 260);
  assert.equal(end.foodEatenG, 40);
  assert.equal(end.kind, 'eating');
});

test('a visit without a meaningful weight drop is classified as drinking', () => {
  const end = run('000011111000', (i) => (i % 2 ? 300.4 : 299.8)).find((e) => e.type === 'visit_end');
  assert.equal(end.kind, 'drinking');
  assert.ok(end.foodEatenG < 3);
});

test('debounce of 1 reacts immediately', () => {
  const events = run('0101', undefined, { debounceReadings: 1, minEatenG: 3 });
  assert.deepEqual(events.map((e) => e.type), ['visit_start', 'visit_end', 'visit_start']);
});

test('monitor aggregates daily totals from visit_end events', () => {
  const m = new Monitor();
  const cal = defaultConfig().calibration.weight;
  let food = 200;
  const msgs = [];
  // two visits: one eating 20 g, one drinking
  const plan = '0000' + '1'.repeat(30) + '0'.repeat(10) + '1'.repeat(8) + '0'.repeat(6);
  [...plan].forEach((c, i) => {
    if (c === '1' && i < 34) food -= 20 / 30;
    const push = c === '1' ? 2000 : 0;
    const r = { deviceId: 'd', ts: T0 + i * 1000, temperatureC: 22, weightRaw: Math.round(gramsToRaw(food, cal)) + push + (i % 3), phVoltage: 2.5 + (i % 4) / 1000, faces: Number(c) };
    msgs.push(...m.ingest(r).messages);
  });
  const ends = msgs.filter((x) => x.type === 'event' && x.data.type === 'visit_end').map((x) => x.data);
  assert.deepEqual(ends.map((e) => e.kind), ['eating', 'drinking']);
  assert.ok(Math.abs(ends[0].foodEatenG - 20) < 0.3, `ate ${ends[0].foodEatenG}`);
  const today = ends[1].daily;
  assert.equal(today.visits, 2);
  assert.equal(today.eatingS, ends[0].durationS);
  assert.equal(today.drinkingS, ends[1].durationS);
  assert.equal(m.snapshot().devices[0].today.visits, 2);
});
