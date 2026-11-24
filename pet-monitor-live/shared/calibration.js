/**
 * Calibration: raw sensor values -> engineering units. Pure functions only.
 *
 * Weight (FSR through ADS1115 A1) - 2-point linear calibration:
 *   grams = (raw - tareRaw) * knownMassG / (knownRaw - tareRaw)
 * An FSR is not linear over its full range (its resistance falls roughly as 1/force),
 * but around a bowl's working load a straight line through two measured points is a
 * good, explainable approximation. More points => piecewise-linear (see README).
 *
 * pH (PH-4502C through ADS1115 A0) - 2-point calibration with pH 7 and pH 4 buffers:
 *   slope = (7 - 4) / (v7 - v4)          [pH per volt, negative for this module]
 *   pH    = 7 + (voltage - v7) * slope
 * Optional temperature compensation: the electrode's mV/pH is proportional to absolute
 * temperature (Nernst: 59.16 mV/pH at 25 °C), so pH-per-volt scales by T_cal / T.
 */

export const ABS_ZERO_C = 273.15;

export function weightSlope({ tareRaw, knownRaw, knownMassG }) {
  const span = knownRaw - tareRaw;
  if (span === 0) throw new RangeError('weight calibration: knownRaw must differ from tareRaw');
  return knownMassG / span; // grams per raw count
}

/** Raw ADC count -> grams on the bowl. Returns null for a missing reading. */
export function rawToGrams(raw, cal) {
  if (raw == null) return null;
  return (raw - cal.tareRaw) * weightSlope(cal);
}

/** Inverse of rawToGrams (used by the simulator so both directions stay consistent). */
export function gramsToRaw(grams, cal) {
  return cal.tareRaw + grams / weightSlope(cal);
}

export function phSlope({ v7, v4 }) {
  if (v7 === v4) throw new RangeError('pH calibration: v7 must differ from v4');
  return (7 - 4) / (v7 - v4); // pH per volt
}

/**
 * Probe voltage -> pH.
 * @param {number|null} voltage
 * @param {{v7:number, v4:number}} cal
 * @param {{temperatureC?:number, calibrationTempC?:number}} [opts] pass temperatureC to compensate
 */
export function voltageToPh(voltage, cal, { temperatureC, calibrationTempC = 25 } = {}) {
  if (voltage == null) return null;
  let slope = phSlope(cal);
  if (temperatureC != null) slope *= (calibrationTempC + ABS_ZERO_C) / (temperatureC + ABS_ZERO_C);
  return 7 + (voltage - cal.v7) * slope;
}

/** Inverse of voltageToPh without compensation (simulator). */
export function phToVoltage(ph, cal) {
  return cal.v7 + (ph - 7) / phSlope(cal);
}

const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Calibrates the raw channels of one validated reading. */
export function calibrateReading(reading, calibration) {
  return {
    weightG: round(rawToGrams(reading.weightRaw, calibration.weight), 1),
    pH: round(voltageToPh(reading.phVoltage, calibration.ph), 2),
  };
}
