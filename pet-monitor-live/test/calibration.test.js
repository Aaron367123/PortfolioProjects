import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawToGrams, gramsToRaw, voltageToPh, phToVoltage, phSlope, calibrateReading } from '../shared/calibration.js';
import { defaultConfig } from '../shared/config.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);

test('weight: tare reads 0 g and the known point reads the known mass', () => {
  const cal = { tareRaw: 2000, knownRaw: 12000, knownMassG: 500 };
  near(rawToGrams(2000, cal), 0);
  near(rawToGrams(12000, cal), 500);
  near(rawToGrams(7000, cal), 250); // linear in between
  near(rawToGrams(1000, cal), -50); // below tare is negative, not clamped
});

test('weight: works when the ADC count falls with load (inverted divider)', () => {
  const cal = { tareRaw: 20000, knownRaw: 15000, knownMassG: 250 };
  near(rawToGrams(17500, cal), 125);
});

test('weight: gramsToRaw is the inverse of rawToGrams', () => {
  const cal = defaultConfig().calibration.weight;
  for (const g of [0, 12.5, 300, 999]) near(rawToGrams(gramsToRaw(g, cal), cal), g, 1e-9);
});

test('weight: degenerate calibration throws, null passes through', () => {
  assert.throws(() => rawToGrams(100, { tareRaw: 5, knownRaw: 5, knownMassG: 100 }), RangeError);
  assert.equal(rawToGrams(null, { tareRaw: 0, knownRaw: 1, knownMassG: 1 }), null);
});

test('pH: buffer voltages map exactly to pH 7 and pH 4', () => {
  const cal = { v7: 2.5, v4: 3.04 };
  near(voltageToPh(2.5, cal), 7);
  near(voltageToPh(3.04, cal), 4);
  near(phSlope(cal), -5.555555555555555, 1e-12); // ≈ -0.18 V per pH (typical PH-4502C)
  near(voltageToPh(2.32, cal), 8); // lower voltage = more alkaline
});

test('pH: extrapolates linearly beyond the buffers and inverts', () => {
  const cal = { v7: 2.48, v4: 3.0 };
  for (const ph of [2, 6.5, 7, 9.2, 12]) near(voltageToPh(phToVoltage(ph, cal), cal), ph, 1e-9);
});

test('pH: temperature compensation scales the slope by T_cal / T (Nernst)', () => {
  const cal = { v7: 2.5, v4: 3.04 };
  // At 25 °C compensation is a no-op.
  near(voltageToPh(2.8, cal, { temperatureC: 25 }), voltageToPh(2.8, cal));
  // Colder electrode has a smaller mV/pH, so the same offset means a larger pH change.
  const cold = voltageToPh(2.8, cal, { temperatureC: 5 });
  const expected = 7 + (2.8 - 2.5) * phSlope(cal) * (298.15 / 278.15);
  near(cold, expected, 1e-12);
  assert.ok(cold < voltageToPh(2.8, cal));
  // pH 7 (the isopotential point here) is unaffected.
  near(voltageToPh(2.5, cal, { temperatureC: 40 }), 7);
});

test('pH: equal buffer voltages are rejected', () => {
  assert.throws(() => voltageToPh(2.5, { v7: 2.5, v4: 2.5 }), RangeError);
});

test('calibrateReading rounds and tolerates nulls', () => {
  const cal = defaultConfig().calibration;
  assert.deepEqual(calibrateReading({ weightRaw: 7000, phVoltage: 2.6 }, cal), { weightG: 250, pH: 6.44 });
  assert.deepEqual(calibrateReading({ weightRaw: null, phVoltage: null }, cal), { weightG: null, pH: null });
});
