/**
 * Input validation for device readings (POST /api/readings).
 *
 * Strict on purpose: unknown fields are rejected so a firmware typo (e.g. the v1 Firebase
 * name "temp_C") fails loudly with a 400 instead of silently storing nulls.
 * A sensor value may be null - that is how the Pi reports a failed read (DHT22 reads fail
 * regularly) - but the key must be present and at least one sensor must have a value.
 */

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_BATCH = 500;
const MIN_TS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_MS = 7 * 24 * 3600 * 1000;

/** Physical/hardware ranges. Values outside these cannot come from the real sensors. */
export const SENSOR_LIMITS = {
  temperatureC: { min: -40, max: 80, int: false }, // DHT22 / AM2302 spec range
  weightRaw: { min: -32768, max: 32767, int: true }, // ADS1115 16-bit signed result
  phVoltage: { min: -0.5, max: 6.5, int: false }, // ADS1115 input, small margin around 0-5 V
  faces: { min: 0, max: 4, int: true }, // SEN-21231 reports at most 4 faces
};
const SENSOR_KEYS = Object.keys(SENSOR_LIMITS);
const ALLOWED_KEYS = new Set(['deviceId', 'ts', 'replay', ...SENSOR_KEYS]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates one reading.
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 */
export function validateReading(input, { now = Date.now() } = {}) {
  if (!isPlainObject(input)) return { ok: false, errors: ['reading must be a JSON object'] };
  const errors = [];

  for (const k of Object.keys(input)) if (!ALLOWED_KEYS.has(k)) errors.push(`unknown field: ${k}`);

  if (typeof input.deviceId !== 'string' || !DEVICE_ID_RE.test(input.deviceId)) {
    errors.push('deviceId must be 1-64 characters of A-Z a-z 0-9 _ -');
  }

  let ts = now;
  if (input.ts !== undefined) {
    if (!Number.isInteger(input.ts)) errors.push('ts must be an integer (milliseconds since epoch)');
    else if (input.ts < MIN_TS || input.ts > now + MAX_FUTURE_MS) errors.push('ts is out of range');
    else ts = input.ts;
  }

  if (input.replay !== undefined && typeof input.replay !== 'boolean') errors.push('replay must be a boolean');

  let present = 0;
  for (const key of SENSOR_KEYS) {
    const v = input[key];
    const lim = SENSOR_LIMITS[key];
    if (!(key in input)) errors.push(`${key} is required (use null for a failed read)`);
    else if (v === null) continue;
    else if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${key} must be a number or null`);
    else if (lim.int && !Number.isInteger(v)) errors.push(`${key} must be an integer`);
    else if (v < lim.min || v > lim.max) errors.push(`${key} must be between ${lim.min} and ${lim.max}`);
    else present++;
  }
  if (!errors.length && present === 0) errors.push('at least one sensor value must be non-null');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      deviceId: input.deviceId,
      ts,
      temperatureC: input.temperatureC,
      weightRaw: input.weightRaw,
      phVoltage: input.phVoltage,
      faces: input.faces,
      replay: input.replay === true,
    },
  };
}

/**
 * Accepts a single reading or an array (batch upload / offline-buffer flush).
 * All-or-nothing: one bad reading rejects the batch, with errors indexed.
 */
export function validateBatch(body, opts) {
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0) return { ok: false, errors: ['batch is empty'] };
  if (list.length > MAX_BATCH) return { ok: false, errors: [`batch exceeds ${MAX_BATCH} readings`] };
  const values = [];
  const errors = [];
  list.forEach((item, i) => {
    const r = validateReading(item, opts);
    if (r.ok) values.push(r.value);
    else errors.push(...r.errors.map((e) => (Array.isArray(body) ? `[${i}] ${e}` : e)));
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: values };
}
