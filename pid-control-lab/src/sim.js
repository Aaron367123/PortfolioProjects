/**
 * sim.js - closed-loop runner: plant + sensor + PID + actuator, one sample at a time.
 *
 * Per controller sample k (t = k*Ts):
 *   1. r = setpoint(t), d = disturbance(t)          (piecewise-constant schedules)
 *   2. ym = quantise(y_true + noise)                 (sensor model, seeded PRNG)
 *   3. u = controller(r, ym)                         (PID, or a relay during autotune)
 *   4. ua = rateLimit(u)                             (optional slew limit on the actuator)
 *   5. plant integrates Ts seconds with ua held      (zero-order hold, RK4 inside)
 *
 * Everything is driven by the sample counter, never by wall-clock time, so a run is
 * bit-for-bit reproducible regardless of frame rate or how many samples the UI
 * processes per animation frame.
 */
import { PID } from './pid.js';
import { PLANTS, PlantSim } from './plants.js';

/** mulberry32: tiny, fast 32-bit seeded PRNG returning [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian N(0, 1) samples from a uniform PRNG (Box-Muller, caches the second value). */
export function gaussian(rand) {
  let spare = null;
  return function next() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

/** Value of a piecewise-constant schedule [{t, value}, ...] (sorted by t) at time t. */
export function scheduleValue(schedule, t, fallback = 0) {
  if (typeof schedule === 'number') return schedule;
  let v = fallback;
  for (const ev of schedule || []) { if (t + 1e-12 >= ev.t) v = ev.value; else break; }
  return v;
}

/** Build the PID options for a plant from its defaults plus overrides. */
export function pidOptionsFor(def, over = {}) {
  const g = def.defaultGains ?? { Kp: 1, Ki: 0, Kd: 0, N: Infinity };
  return {
    Kp: g.Kp, Ki: g.Ki, Kd: g.Kd, N: g.N,
    Ts: def.Ts ?? 0.01, uMin: def.uMin ?? -Infinity, uMax: def.uMax ?? Infinity,
    antiWindup: 'clamp', derivativeOnMeasurement: true, b: 1,
    ...over,
  };
}

export class ClosedLoop {
  /**
   * @param {object} o
   * @param {string|object} o.plant plant id or definition
   * @param {object} [o.plantParams]
   * @param {object} [o.pid] PID option overrides (gains, limits, antiWindup, ...)
   * @param {number} [o.Ts] controller sample time (default: plant's)
   * @param {Array|number} [o.setpoint] schedule [{t, value}] or constant
   * @param {Array|number} [o.disturbance] schedule [{t, value}] or constant
   * @param {object} [o.noise] { std, seed } additive Gaussian sensor noise
   * @param {number} [o.quant] sensor quantisation step (0 = off)
   * @param {number} [o.rateLimit] actuator slew limit in u-units per second (0 = off)
   */
  constructor(o = {}) {
    this.def = typeof o.plant === 'string' ? PLANTS[o.plant] : o.plant;
    this.Ts = o.Ts ?? this.def.Ts ?? 0.01;
    this.plant = new PlantSim(this.def, o.plantParams);
    this.pid = new PID(pidOptionsFor(this.def, { Ts: this.Ts, ...o.pid }));
    this.setpoint = o.setpoint ?? this.def.step?.[1] ?? 1;
    this.disturbance = o.disturbance ?? 0;
    this.noise = o.noise ?? { std: 0, seed: 1 };
    this.quant = o.quant ?? 0;
    this.rateLimit = o.rateLimit ?? 0;
    this.controller = null;   // optional override (r, ym, t) => u  (relay autotune)
    this.reset();
  }

  reset() {
    this.k = 0;
    this.plant.reset();
    this.pid.reset();
    this.uPrev = 0;
    this.gauss = gaussian(mulberry32(this.noise.seed ?? 1));
  }

  get t() { return this.k * this.Ts; }

  /** Sensor model: additive Gaussian noise, then quantisation to the nearest LSB. */
  measure(y) {
    let ym = y;
    if (this.noise.std > 0) ym += this.noise.std * this.gauss();
    if (this.quant > 0) ym = Math.round(ym / this.quant) * this.quant;
    return ym;
  }

  /** Run one controller sample; returns the sample record. */
  tick() {
    const t = this.t;
    const r = scheduleValue(this.setpoint, t);
    const d = scheduleValue(this.disturbance, t);
    const yTrue = this.plant.y;
    const ym = this.measure(yTrue);

    let u, P = 0, I = 0, D = 0;
    if (this.controller) {
      u = this.controller(r, ym, t);
    } else {
      u = this.pid.update(r, ym);
      ({ P, I, D } = this.pid.last);
    }
    if (this.rateLimit > 0) {
      const du = this.rateLimit * this.Ts;
      u = Math.min(this.uPrev + du, Math.max(this.uPrev - du, u));
    }
    this.uPrev = u;
    this.plant.step(u, d, this.Ts);
    this.k++;
    return { t, sp: r, y: ym, yTrue, u, e: r - ym, P, I, D, d };
  }
}

/**
 * Run a closed loop for `duration` seconds and return column arrays
 * { t, sp, y, yTrue, u, e, P, I, D, d } (Float64Array each) plus the loop config.
 */
export function simulate(o = {}) {
  const loop = new ClosedLoop(o);
  const duration = o.duration ?? loop.def.duration;
  const n = Math.round(duration / loop.Ts);
  const keys = ['t', 'sp', 'y', 'yTrue', 'u', 'e', 'P', 'I', 'D', 'd'];
  const out = Object.fromEntries(keys.map((k) => [k, new Float64Array(n)]));
  for (let i = 0; i < n; i++) {
    const s = loop.tick();
    for (const k of keys) out[k][i] = s[k];
  }
  out.n = n;
  out.Ts = loop.Ts;
  out.uMin = loop.pid.uMin;
  out.uMax = loop.pid.uMax;
  return out;
}

/**
 * Standard step-response experiment: the plant starts at rest in its initial state
 * (output = step[0]) and the setpoint steps to step[1] at t = 0.
 */
export function stepResponse(plantId, pid = {}, extra = {}) {
  const def = typeof plantId === 'string' ? PLANTS[plantId] : plantId;
  return simulate({ plant: def, pid, setpoint: [{ t: 0, value: def.step[1] }], ...extra });
}
