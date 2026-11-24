import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReading, validateBatch, MAX_BATCH } from '../shared/validation.js';
import { applyConfigPatch, defaultConfig, validateConfig, CONFIG_FIELDS } from '../shared/config.js';

const NOW = Date.UTC(2026, 5, 1);
const good = { deviceId: 'pi-kitchen', ts: NOW - 1000, temperatureC: 22.4, weightRaw: 8123, phVoltage: 2.512, faces: 1 };
const v = (r) => validateReading(r, { now: NOW });

test('accepts a well-formed reading and normalises it', () => {
  const r = v(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { ...good, replay: false });
});

test('ts defaults to the server clock', () => {
  const { ts, ...noTs } = good;
  assert.equal(v(noTs).value.ts, NOW);
});

test('null means a failed sensor read and is allowed, but not all-null', () => {
  assert.equal(v({ ...good, temperatureC: null }).ok, true);
  const r = v({ ...good, temperatureC: null, weightRaw: null, phVoltage: null, faces: null });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /at least one sensor/);
});

test('rejects junk', () => {
  const cases = [
    [null, /JSON object/],
    [[good], /JSON object/],
    ['hello', /JSON object/],
    [{ ...good, deviceId: '' }, /deviceId/],
    [{ ...good, deviceId: '../etc' }, /deviceId/],
    [{ ...good, deviceId: 42 }, /deviceId/],
    [{ ...good, temperatureC: '22' }, /temperatureC must be a number/],
    [{ ...good, temperatureC: 120 }, /temperatureC must be between/],
    [{ ...good, weightRaw: 1.5 }, /weightRaw must be an integer/],
    [{ ...good, weightRaw: 40000 }, /weightRaw must be between/],
    [{ ...good, phVoltage: -3 }, /phVoltage must be between/],
    [{ ...good, faces: 9 }, /faces must be between/],
    [{ ...good, faces: true }, /faces must be a number/],
    [{ ...good, ts: '2026-01-01' }, /ts must be an integer/],
    [{ ...good, ts: 1000 }, /ts is out of range/],
    [{ ...good, ts: NOW + 30 * 86400e3 }, /ts is out of range/],
    [{ ...good, replay: 'yes' }, /replay/],
    [{ ...good, temp_C: 22 }, /unknown field: temp_C/],
  ];
  for (const [input, re] of cases) {
    const r = v(input);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(input)}`);
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(r.errors)} should match ${re}`);
  }
  const { faces, ...missing } = good;
  assert.match(v(missing).errors[0], /faces is required/);
});

test('batches are all-or-nothing with indexed errors', () => {
  assert.equal(validateBatch([good, good], { now: NOW }).value.length, 2);
  const r = validateBatch([good, { ...good, faces: -1 }], { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^\[1\] faces/);
  assert.equal(validateBatch([], { now: NOW }).ok, false);
  assert.equal(validateBatch(Array(MAX_BATCH + 1).fill(good), { now: NOW }).ok, false);
});

test('config: defaults are valid and every field has a default', () => {
  assert.deepEqual(validateConfig(defaultConfig()), []);
  assert.ok(CONFIG_FIELDS.length >= 15);
});

test('config: partial patch merges deeply', () => {
  const r = applyConfigPatch(defaultConfig(), { alerts: { temperature: { highC: 28 } } });
  assert.equal(r.ok, true);
  assert.equal(r.value.alerts.temperature.highC, 28);
  assert.equal(r.value.alerts.temperature.lowC, 15); // untouched
});

test('config: rejects unknown keys, bad types, out-of-range and inconsistent values', () => {
  const base = defaultConfig();
  const bad = [
    [{ alerts: { temperature: { hotC: 28 } } }, /unknown setting/],
    [{ alerts: { temperature: { highC: '28' } } }, /must be a number/],
    [{ alerts: { offlineSeconds: 1 } }, /between/],
    [{ session: { debounceReadings: 2.5 } }, /integer/],
    [{ alerts: { temperature: { lowC: 31 } } }, /lowC must be below/],
    [{ alerts: { ph: { hysteresis: 1.5 } } }, /hysteresis is too large/],
    [{ calibration: { ph: { v4: 2.5 } } }, /v4 must differ/],
    [[1, 2], /JSON object/],
  ];
  for (const [patch, re] of bad) {
    const r = applyConfigPatch(base, patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.errors.some((e) => re.test(e)), `${r.errors} should match ${re}`);
  }
});
