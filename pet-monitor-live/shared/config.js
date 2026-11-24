/**
 * Monitor configuration: defaults, a declarative field schema and a patch validator.
 *
 * The same CONFIG_FIELDS table is used in two places:
 *   - the server validates PUT /api/config against it, and
 *   - the dashboard builds its settings drawer from it,
 * so a new threshold only has to be added here once.
 *
 * Shared between Node and the browser: no imports, no Node APIs.
 */

/** Returns a fresh copy of the default configuration. */
export function defaultConfig() {
  return {
    calibration: {
      // FSR under the bowl, read through ADS1115 channel A1 (16-bit signed raw value).
      // 2-point linear fit: raw value with the empty bowl (tare) and with a known mass.
      weight: { tareRaw: 2000, knownRaw: 12000, knownMassG: 500 },
      // PH-4502C output voltage (ADS1115 A0) measured in pH 7.00 and pH 4.00 buffers.
      // Typical module: ~2.50 V at pH 7 and rising ~0.18 V per pH unit as the solution gets more acidic.
      ph: { v7: 2.5, v4: 3.04 },
    },
    session: {
      debounceReadings: 3, // consecutive presence/absence readings needed to start/end a visit
      minEatenG: 3, // food drop (g) during a visit that classifies it as "eating"
    },
    alerts: {
      temperature: { lowC: 15, highC: 30, hysteresisC: 1 },
      ph: { min: 6.5, max: 8.5, hysteresis: 0.2 },
      noVisitHours: 8,
      offlineSeconds: 10,
      confirmReadings: 3, // a threshold must be crossed this many readings in a row before firing
      cooldownMinutes: 10, // minimum time between two firings of the same alert
      fault: {
        stuckReadings: 30, // identical ADC readings in a row => sensor stuck
        clearReadings: 5, // healthy readings in a row before a fault clears
        maxTempJumpC: 5, // deviation from the recent median => spike
        maxNullReadings: 10, // failed reads in a row => "no data"
      },
    },
  };
}

/**
 * Every editable setting. `path` is a dot path into the config object.
 * min/max are inclusive; `int` requires an integer.
 */
export const CONFIG_FIELDS = [
  { path: 'alerts.temperature.lowC', group: 'Temperature', label: 'Too cold below', unit: '°C', min: -20, max: 40, step: 0.5 },
  { path: 'alerts.temperature.highC', group: 'Temperature', label: 'Too hot above', unit: '°C', min: 0, max: 60, step: 0.5 },
  { path: 'alerts.temperature.hysteresisC', group: 'Temperature', label: 'Hysteresis', unit: '°C', min: 0, max: 10, step: 0.1 },
  { path: 'alerts.ph.min', group: 'Water pH', label: 'Safe minimum', unit: 'pH', min: 0, max: 14, step: 0.1 },
  { path: 'alerts.ph.max', group: 'Water pH', label: 'Safe maximum', unit: 'pH', min: 0, max: 14, step: 0.1 },
  { path: 'alerts.ph.hysteresis', group: 'Water pH', label: 'Hysteresis', unit: 'pH', min: 0, max: 2, step: 0.05 },
  { path: 'alerts.noVisitHours', group: 'Visits', label: 'Alert if no visit for', unit: 'h', min: 0.5, max: 72, step: 0.5 },
  { path: 'session.debounceReadings', group: 'Visits', label: 'Presence debounce', unit: 'readings', min: 1, max: 60, step: 1, int: true },
  { path: 'session.minEatenG', group: 'Visits', label: 'Counts as eating from', unit: 'g', min: 0, max: 500, step: 1 },
  { path: 'alerts.offlineSeconds', group: 'Device & faults', label: 'Offline after', unit: 's', min: 2, max: 3600, step: 1 },
  { path: 'alerts.fault.stuckReadings', group: 'Device & faults', label: 'Stuck after', unit: 'readings', min: 3, max: 3600, step: 1, int: true },
  { path: 'alerts.fault.clearReadings', group: 'Device & faults', label: 'Fault clears after', unit: 'readings', min: 1, max: 600, step: 1, int: true },
  { path: 'alerts.fault.maxTempJumpC', group: 'Device & faults', label: 'Temperature spike', unit: '°C', min: 0.5, max: 50, step: 0.5 },
  { path: 'alerts.fault.maxNullReadings', group: 'Device & faults', label: 'Failed reads before fault', unit: 'readings', min: 1, max: 3600, step: 1, int: true },
  { path: 'alerts.confirmReadings', group: 'Alert behaviour', label: 'Confirm over', unit: 'readings', min: 1, max: 60, step: 1, int: true },
  { path: 'alerts.cooldownMinutes', group: 'Alert behaviour', label: 'Cooldown', unit: 'min', min: 0, max: 1440, step: 1 },
  { path: 'calibration.weight.tareRaw', group: 'Calibration', label: 'Empty bowl (tare)', unit: 'raw', min: -32768, max: 32767, step: 1, int: true },
  { path: 'calibration.weight.knownRaw', group: 'Calibration', label: 'Raw with known mass', unit: 'raw', min: -32768, max: 32767, step: 1, int: true },
  { path: 'calibration.weight.knownMassG', group: 'Calibration', label: 'Known mass', unit: 'g', min: 1, max: 100000, step: 1 },
  { path: 'calibration.ph.v7', group: 'Calibration', label: 'Voltage in pH 7 buffer', unit: 'V', min: 0, max: 5, step: 0.001 },
  { path: 'calibration.ph.v4', group: 'Calibration', label: 'Voltage in pH 4 buffer', unit: 'V', min: 0, max: 5, step: 0.001 },
];

const FIELD_BY_PATH = new Map(CONFIG_FIELDS.map((f) => [f.path, f]));

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Flattens {a:{b:1}} into [['a.b', 1]]. */
function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push(...flatten(v, p));
    else out.push([p, v]);
  }
  return out;
}

/** Validates a complete config object. Returns a list of error strings (empty = valid). */
export function validateConfig(cfg) {
  const errors = [];
  for (const f of CONFIG_FIELDS) {
    const v = getPath(cfg, f.path);
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${f.path} must be a number`);
    else if (v < f.min || v > f.max) errors.push(`${f.path} must be between ${f.min} and ${f.max}`);
    else if (f.int && !Number.isInteger(v)) errors.push(`${f.path} must be an integer`);
  }
  if (errors.length) return errors;

  // Cross-field rules: the hysteresis band must fit inside the safe range.
  const t = cfg.alerts.temperature;
  if (t.lowC >= t.highC) errors.push('alerts.temperature.lowC must be below highC');
  else if (t.hysteresisC * 2 >= t.highC - t.lowC) errors.push('alerts.temperature.hysteresisC is too large for the range');
  const p = cfg.alerts.ph;
  if (p.min >= p.max) errors.push('alerts.ph.min must be below max');
  else if (p.hysteresis * 2 >= p.max - p.min) errors.push('alerts.ph.hysteresis is too large for the range');
  const w = cfg.calibration.weight;
  if (Math.abs(w.knownRaw - w.tareRaw) < 10) errors.push('calibration.weight.knownRaw must differ from tareRaw by at least 10');
  const ph = cfg.calibration.ph;
  if (Math.abs(ph.v7 - ph.v4) < 0.05) errors.push('calibration.ph.v4 must differ from v7 by at least 0.05 V');
  return errors;
}

/**
 * Applies a partial patch (e.g. {alerts:{temperature:{highC:28}}}) to `current`.
 * Unknown keys and wrong types are rejected; the result is validated as a whole.
 * Returns {ok:true, value} or {ok:false, errors}.
 */
export function applyConfigPatch(current, patch) {
  if (!isPlainObject(patch)) return { ok: false, errors: ['config patch must be a JSON object'] };
  const next = structuredClone(current);
  const errors = [];
  for (const [path, value] of flatten(patch)) {
    if (!FIELD_BY_PATH.has(path)) errors.push(`unknown setting: ${path}`);
    else setPath(next, path, value);
  }
  if (errors.length) return { ok: false, errors };
  const invalid = validateConfig(next);
  return invalid.length ? { ok: false, errors: invalid } : { ok: true, value: next };
}
