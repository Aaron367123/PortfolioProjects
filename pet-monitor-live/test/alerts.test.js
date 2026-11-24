import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertTracker } from '../shared/alerts.js';
import { Monitor } from '../shared/monitor.js';
import { defaultConfig, applyConfigPatch } from '../shared/config.js';

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const S = 1000;

/** Feeds a temperature series through a tracker using a 30 °C threshold and 1 °C hysteresis. */
function runTemps(temps, opts) {
  const tr = new AlertTracker();
  return temps.map((v, i) => tr.update(T0 + i * S, v > 30, v <= 29, opts));
}

test('tracker: fires once when crossing, stays active inside the hysteresis band', () => {
  const out = runTemps([29, 31, 30.5, 29.5, 30.2, 29.1, 28.9, 31], { confirm: 1, cooldownMs: 0 });
  assert.deepEqual(out, [null, 'fire', null, null, null, null, 'resolve', 'fire']);
});

test('tracker: oscillating around the threshold does not flap', () => {
  const series = Array.from({ length: 40 }, (_, i) => (i % 2 ? 30.3 : 29.7));
  const out = runTemps(series, { confirm: 1, cooldownMs: 0 }).filter(Boolean);
  assert.deepEqual(out, ['fire']); // 29.7 never satisfies the clear condition (<= 29)
});

test('tracker: confirm requires consecutive triggering readings', () => {
  assert.deepEqual(runTemps([31, 29.5, 31, 31, 31], { confirm: 3 }), [null, null, null, null, 'fire']);
});

test('tracker: cooldown suppresses re-firing, then fires once it has elapsed', () => {
  const tr = new AlertTracker();
  const opts = { confirm: 1, cooldownMs: 60 * S };
  assert.equal(tr.update(T0, true, false, opts), 'fire');
  assert.equal(tr.update(T0 + 5 * S, false, true, opts), 'resolve');
  assert.equal(tr.update(T0 + 10 * S, true, false, opts), null); // within cooldown
  assert.equal(tr.update(T0 + 59 * S, true, false, opts), null);
  assert.equal(tr.update(T0 + 60 * S, true, false, opts), 'fire'); // still hot after cooldown
});

// ---- Monitor-level alert rules -----------------------------------------------------------

function reading(i, over = {}) {
  return { deviceId: 'd1', ts: T0 + i * S, temperatureC: 22, weightRaw: 8000 + (i % 7), phVoltage: 2.5 + (i % 5) * 0.001, faces: 0, ...over };
}

function feed(monitor, readings) {
  const msgs = [];
  for (const r of readings) msgs.push(...monitor.ingest(r, { receivedAt: r.ts }).messages);
  return msgs.filter((m) => m.type === 'alert').map((m) => `${m.data.key}:${m.data.status}`);
}

test('monitor: temperature alert fires after confirmation and resolves below the band', () => {
  const m = new Monitor();
  const temps = [22, 31, 31, 31, 31, 30.5, 29.5, 28.9, 27];
  const alerts = feed(m, temps.map((t, i) => reading(i, { temperatureC: t })));
  assert.deepEqual(alerts, ['temp_high:active', 'temp_high:resolved']);
  const fired = [...m.alerts.values()][0];
  assert.equal(fired.ts, T0 + 3 * S); // third consecutive hot reading
  assert.equal(fired.resolvedTs, T0 + 7 * S); // first reading <= 29
});

test('monitor: pH out of range uses the calibrated value', () => {
  const m = new Monitor();
  // 2.95 V -> pH 4.5 with default calibration (well below 6.5)
  const alerts = feed(m, Array.from({ length: 5 }, (_, i) => reading(i, { phVoltage: 2.95 + i * 0.001 })));
  assert.deepEqual(alerts, ['ph_low:active']);
});

test('monitor: a temperature spike raises a sensor fault, not a heat alert', () => {
  const m = new Monitor();
  const temps = [22, 22.1, 22, 22.1, 65, 22, 22.1, 22, 22.1, 22, 22.1];
  const msgs = [];
  temps.forEach((t, i) => msgs.push(...m.ingest(reading(i, { temperatureC: t }), { receivedAt: T0 }).messages));
  const alerts = msgs.filter((x) => x.type === 'alert').map((x) => `${x.data.key}:${x.data.status}`);
  assert.deepEqual(alerts, ['sensor_fault:temperatureC:active', 'sensor_fault:temperatureC:resolved']);
  const spike = msgs.find((x) => x.type === 'reading' && x.data.temperatureRaw === 65).data;
  assert.equal(spike.temperatureC, null); // excluded from charts and threshold rules
});

test('monitor: stuck ADC channel is detected after stuckReadings identical values', () => {
  const cfg = applyConfigPatch(defaultConfig(), { alerts: { fault: { stuckReadings: 10 } } }).value;
  const m = new Monitor({ config: cfg });
  const rs = Array.from({ length: 20 }, (_, i) => reading(i, { phVoltage: i < 5 ? 2.5 + i * 0.001 : 2.5123 }));
  const msgs = [];
  rs.forEach((r) => msgs.push(...m.ingest(r).messages));
  const fire = msgs.find((x) => x.type === 'alert');
  assert.equal(fire.data.key, 'sensor_fault:phVoltage');
  assert.equal(fire.data.reason, 'stuck');
  assert.equal(fire.data.ts, T0 + 14 * S); // 10th identical value (indices 5..14)
});

test('monitor: no-visit alert fires after the configured idle time and clears on a visit', () => {
  const cfg = applyConfigPatch(defaultConfig(), { alerts: { noVisitHours: 1 } }).value;
  const m = new Monitor({ config: cfg });
  const step = 60 * S; // one reading per minute keeps the test small
  const rs = [];
  for (let i = 0; i <= 70; i++) rs.push({ ...reading(i), ts: T0 + i * step, faces: i >= 65 ? 1 : 0 });
  const alerts = feed(m, rs);
  assert.deepEqual(alerts, ['no_visit:active', 'no_visit:resolved']);
  assert.equal([...m.alerts.values()][0].ts, T0 + 61 * step);
});

test('monitor: device offline after offlineSeconds of silence (wall clock), resolved on next reading', () => {
  const m = new Monitor();
  m.ingest(reading(0), { receivedAt: 1_000_000 });
  assert.deepEqual(m.tick(1_000_000 + 9_000).filter((x) => x.type === 'alert'), []);
  const offline = m.tick(1_000_000 + 10_001);
  assert.deepEqual(offline.map((x) => x.type), ['status', 'alert']);
  assert.equal(offline[0].data.online, false);
  assert.equal(offline[1].data.severity, 'critical');
  const back = m.ingest(reading(1), { receivedAt: 1_000_000 + 20_000 }).messages;
  assert.ok(back.some((x) => x.type === 'status' && x.data.online));
  assert.ok(back.some((x) => x.type === 'alert' && x.data.key === 'device_offline' && x.data.status === 'resolved'));
});

test('monitor: replayed (buffered) readings are stored but do not drive alerts', () => {
  const m = new Monitor();
  const out = m.ingest({ ...reading(0), temperatureC: 45, replay: true });
  assert.equal(out.live, false);
  assert.equal(out.reading.temperatureC, 45);
  assert.deepEqual(out.messages.filter((x) => x.type !== 'status'), []);
});

test('monitor: acknowledge marks the alert', () => {
  const m = new Monitor();
  feed(m, [31, 31, 31].map((t, i) => reading(i, { temperatureC: t })));
  const [alert] = m.alerts.values();
  const msg = m.acknowledge(alert.id);
  assert.equal(msg.data.acknowledged, true);
  assert.equal(m.acknowledge('nope'), null);
});
