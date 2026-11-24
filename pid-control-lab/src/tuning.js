/**
 * tuning.js - automatic tuning.
 *
 * (a) Relay feedback autotune (Astrom & Hagglund, 1984).
 *     Replace the PID with an on/off relay  u = bias +/- h  around the setpoint. Most
 *     plants then settle into a limit cycle at the frequency where their phase is -180 deg
 *     - exactly the point Ziegler-Nichols need, found without pushing the loop to the edge
 *     of instability by hand. From the oscillation:
 *        Tu = period of the limit cycle
 *        Ku = 4h / (pi * a)                   describing-function estimate, a = output amplitude
 *     The describing function assumes y is a sine. On dead-time plants the limit cycle is
 *     closer to a triangle and the peak-based estimate comes out ~20 % low, so the value we
 *     use is the ratio of first Fourier harmonics over whole periods, Ku = |U1| / |Y1|
 *     (heater: -1.9 % vs analytic, DF: -20 %). Both share the method's intrinsic error: the
 *     relay oscillates slightly off the exact -180 deg frequency (a few % on a 3rd-order lag).
 *     Then a tuning rule maps (Ku, Tu) to gains.
 *
 * (b) Nelder-Mead optimiser on log10(gains) minimising normalised ITAE plus penalties on
 *     overshoot and control effort, each candidate evaluated by a full step simulation.
 */
import { ClosedLoop, simulate, pidOptionsFor } from './sim.js';
import { PLANTS } from './plants.js';
import { stepMetrics } from './metrics.js';

/** Tuning rules as multiples of Ku (for Kp) and Tu (for Ti, Td). */
export const TUNING_RULES = {
  'zn-pid':  { name: 'Ziegler-Nichols PID', kp: 0.6,       ti: 0.5,   td: 0.125 },
  'zn-pi':   { name: 'Ziegler-Nichols PI',  kp: 0.45,      ti: 1 / 1.2, td: 0 },
  'tl-pid':  { name: 'Tyreus-Luyben PID',   kp: 1 / 2.2,   ti: 2.2,   td: 1 / 6.3 },
  'tl-pi':   { name: 'Tyreus-Luyben PI',    kp: 1 / 3.2,   ti: 2.2,   td: 0 },
  'some-os': { name: 'ZN "some overshoot"', kp: 0.33,      ti: 0.5,   td: 1 / 3 },
  'no-os':   { name: 'ZN "no overshoot"',   kp: 0.2,       ti: 0.5,   td: 1 / 3 },
};

/** Kp = kp*Ku, Ti = ti*Tu, Td = td*Tu  ->  parallel gains Ki = Kp/Ti, Kd = Kp*Td. */
export function gainsFromRule(Ku, Tu, ruleId) {
  const r = TUNING_RULES[ruleId];
  if (!r) throw new Error(`unknown rule ${ruleId}`);
  const Kp = r.kp * Ku;
  const Ti = r.ti * Tu;
  const Td = r.td * Tu;
  return { Kp, Ki: Kp / Ti, Kd: Kp * Td };
}

/**
 * Sample-by-sample relay experiment. Feed it (r, y, t) each controller sample; it
 * returns the relay output and records the switching instants. `done` turns true once
 * enough full cycles have been measured.
 */
export class RelayExperiment {
  /**
   * @param {object} o
   * @param {number} o.h relay amplitude (u-units)
   * @param {number} [o.bias=0] centre of the relay (operating point input, e.g. hover thrust)
   * @param {number} [o.eps=0] hysteresis on the error (use ~2-3 sigma of the sensor noise)
   * @param {number} [o.uMin=-Infinity], [o.uMax=Infinity] actuator limits
   * @param {number} [o.cycles=8] total cycles to run
   * @param {number} [o.measure=4] last N cycles used for the estimate
   * @param {boolean} [o.adaptBias=true] equalise on/off times during the warm-up cycles
   */
  constructor(o) {
    this.h = o.h;
    this.bias = o.bias ?? 0;
    this.eps = o.eps ?? 0;
    this.uMin = o.uMin ?? -Infinity;
    this.uMax = o.uMax ?? Infinity;
    this.cycles = o.cycles ?? 8;
    this.measure = o.measure ?? 4;
    this.adaptBias = o.adaptBias ?? true;
    this.high = null;       // relay state, decided on the first sample
    this.ups = [];          // times of low->high switches (start of each cycle)
    this.downs = [];        // times of high->low switches
    this.log = [];          // {t, u, y} samples, for the Fourier estimate
    this.done = false;
  }

  step(r, y, t) {
    const e = r - y;
    const prev = this.high;
    if (this.high === null) this.high = e >= 0;
    else if (e > this.eps) this.high = true;
    else if (e < -this.eps) this.high = false;

    if (prev === false && this.high) this.onUp(t);
    if (prev === true && !this.high) this.downs.push(t);

    const u = Math.min(this.uMax, Math.max(this.uMin, this.bias + (this.high ? this.h : -this.h)));
    this.log.push({ t, u, y });
    if (this.ups.length > this.cycles) this.done = true;
    return u;
  }

  /** Start of a new cycle: optionally re-centre the bias so on- and off-times match. */
  onUp(t) {
    this.ups.push(t);
    const n = this.ups.length;
    const warmup = this.cycles - this.measure;
    if (this.adaptBias && n >= 2 && n <= warmup) {
      const t0 = this.ups[n - 2];
      const tDown = this.downs.find((td) => td > t0 && td < t);
      if (tDown !== undefined) {
        const tHigh = tDown - t0, tLow = t - tDown;
        // If the relay has to stay "high" longer than "low", the bias is too small.
        this.bias += 0.5 * this.h * (tHigh - tLow) / (tHigh + tLow);
      }
    }
  }

  /** Ku/Tu estimates from the last `measure` complete cycles. */
  result() {
    const n = this.ups.length;
    if (n < this.measure + 1) return null;
    const tStart = this.ups[n - 1 - this.measure];
    const tEnd = this.ups[n - 1];
    const Tu = (tEnd - tStart) / this.measure;

    const seg = this.log.filter((s) => s.t >= tStart && s.t < tEnd);
    let yMax = -Infinity, yMin = Infinity, ySum = 0;
    for (const s of seg) { yMax = Math.max(yMax, s.y); yMin = Math.min(yMin, s.y); ySum += s.y; }
    const a = (yMax - yMin) / 2;
    const yMean = ySum / seg.length;

    // Describing function of an ideal relay with hysteresis eps: N(a) = 4h / (pi*sqrt(a^2 - eps^2))
    const KuDF = (4 * this.h) / (Math.PI * Math.sqrt(Math.max(a * a - this.eps * this.eps, 1e-30)));

    // First harmonic over whole periods: X1 = sum x(t) e^{-j w t}
    const w = (2 * Math.PI) / Tu;
    let yr = 0, yi = 0, ur = 0, ui = 0, uSum = 0;
    for (const s of seg) uSum += s.u;
    const uMean = uSum / seg.length;
    for (const s of seg) {
      const c = Math.cos(w * s.t), sn = Math.sin(w * s.t);
      yr += (s.y - yMean) * c; yi -= (s.y - yMean) * sn;
      ur += (s.u - uMean) * c; ui -= (s.u - uMean) * sn;
    }
    const KuFourier = Math.hypot(ur, ui) / Math.hypot(yr, yi);
    return { Ku: KuFourier, KuDF, Tu, a, h: this.h, bias: this.bias, tStart, tEnd, yMean };
  }
}

/**
 * Run a complete relay experiment on a plant in simulation.
 * @returns {{Ku, KuDF, Tu, a, bias, gains: object, trace: object}|null}
 */
export function relayAutotune(plant, o = {}) {
  const def = typeof plant === 'string' ? PLANTS[plant] : plant;
  const r = o.setpoint ?? def.step?.[1] ?? 1;
  const relayDefaults = def.relay ?? { h: 1, eps: 0 };
  const exp = new RelayExperiment({
    h: o.h ?? relayDefaults.h,
    eps: o.eps ?? relayDefaults.eps,
    bias: o.bias ?? (def.equilibriumU ? def.equilibriumU(r, { ...def.params, ...o.plantParams }) : 0),
    uMin: def.uMin, uMax: def.uMax,
    cycles: o.cycles, measure: o.measure,
  });
  const loop = new ClosedLoop({
    plant: def, plantParams: o.plantParams, Ts: o.Ts ?? def.Ts, setpoint: r,
    noise: o.noise, quant: o.quant,
  });
  loop.controller = (rr, ym, t) => exp.step(rr, ym, t);
  const maxTime = o.maxTime ?? 50 * (def.duration ?? 10);
  const trace = { t: [], y: [], u: [], sp: [] };
  while (!exp.done && loop.t < maxTime) {
    const s = loop.tick();
    trace.t.push(s.t); trace.y.push(s.y); trace.u.push(s.u); trace.sp.push(s.sp);
  }
  const res = exp.result();
  if (!res) return null;
  const gains = Object.fromEntries(Object.keys(TUNING_RULES).map((k) => [k, gainsFromRule(res.Ku, res.Tu, k)]));
  return { ...res, gains, trace };
}

/* ------------------------------------------------------------------------------------
 * Nelder-Mead simplex (unconstrained), written as a generator so the UI can animate it.
 * Standard coefficients: reflection 1, expansion 2, contraction 0.5, shrink 0.5.
 * ---------------------------------------------------------------------------------- */
export function* nelderMeadIter(f, x0, o = {}) {
  const n = x0.length;
  const step = o.step ?? 0.3;
  const maxEvals = o.maxEvals ?? 200;
  const tol = o.tol ?? 1e-5;
  let evals = 0;
  const F = (x) => { evals++; const v = f(x); return Number.isFinite(v) ? v : 1e12; };

  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step; simplex.push(x); }
  let fs = simplex.map(F);
  let iter = 0;

  while (evals < maxEvals) {
    const order = fs.map((v, i) => i).sort((a, b) => fs[a] - fs[b]);
    simplex = order.map((i) => simplex[i]);
    fs = order.map((i) => fs[i]);
    yield { iter, evals, x: simplex[0].slice(), fx: fs[0] };
    if (Math.abs(fs[n] - fs[0]) <= tol * (Math.abs(fs[0]) + 1e-12)) break;
    iter++;

    const c = new Array(n).fill(0);   // centroid of all but the worst
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
    const lerp = (t) => c.map((cj, j) => cj + t * (simplex[n][j] - cj));

    const xr = lerp(-1); const fr = F(xr);
    if (fr < fs[0]) {
      const xe = lerp(-2); const fe = F(xe);
      if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
    } else if (fr < fs[n - 1]) {
      simplex[n] = xr; fs[n] = fr;
    } else {
      const outside = fr < fs[n];
      const xc = lerp(outside ? -0.5 : 0.5); const fc = F(xc);
      if (fc < (outside ? fr : fs[n])) { simplex[n] = xc; fs[n] = fc; } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          fs[i] = F(simplex[i]);
        }
      }
    }
  }
  const best = fs.indexOf(Math.min(...fs));
  return { iter, evals, x: simplex[best], fx: fs[best] };
}

export function nelderMead(f, x0, o) {
  const it = nelderMeadIter(f, x0, o);
  let r = it.next();
  let last = r.value;
  while (!r.done) { last = r.value; r = it.next(); }
  return r.value ?? last;
}

/**
 * Cost of a gain set on a plant's standard step (simulated with the plant's sensor noise,
 * fixed seed, so the optimiser "feels" noise amplification by large Kp/Kd):
 *   J = ITAE / (|A| T^2)                      tracking performance, normalised
 *     + wOs  * (max(0, OS% - osFree) / 10)^2  overshoot beyond a free allowance
 *     + wSat * saturation fraction            time spent pinned at a limit
 *     + wTv  * TV / (uSpan * T / Ts)          actuator chatter (mean |du| per sample)
 * Responses that never settle get +1, so unstable candidates are always rejected.
 */
export function tuningCost(def, gains, o = {}) {
  const pid = pidOptionsFor(def, { ...o.pid, ...gains });
  const T = o.duration ?? def.duration;
  const noise = o.noise ?? { std: def.noiseStd ?? 0, seed: 7 };
  const s = simulate({ plant: def, pid, setpoint: [{ t: 0, value: def.step[1] }], duration: T, noise });
  const m = stepMetrics(s, { yKey: 'yTrue', y0: def.step[0] });
  const A = Math.abs(m.amplitude) || 1;
  const uSpan = Number.isFinite(def.uMax - def.uMin) ? def.uMax - def.uMin : 1;
  let J = m.itae / (A * T * T);
  J += (o.wOs ?? 1) * (Math.max(0, m.overshoot - (o.osFree ?? 2)) / 10) ** 2;
  J += (o.wSat ?? 0.05) * (m.satPct / 100);
  J += (o.wTv ?? 0.5) * m.tv / (uSpan * s.n);
  if (!Number.isFinite(m.settle)) J += 1;
  return { J, m };
}

/**
 * Generator: optimise the gains in `mask` (others stay as given) on log10 scale.
 * Yields {evals, gains, J, m} after every simplex iteration.
 */
export function* optimiseIter(plant, start, o = {}) {
  const def = typeof plant === 'string' ? PLANTS[plant] : plant;
  const mask = o.mask ?? ['Kp', 'Ki', 'Kd'].filter((k) => start[k] > 0);
  // Search on log10(gain), clamped to the plant's slider range so a gain that "wants" to
  // vanish (e.g. Ki on an integrating plant) stops at the range floor instead of 1e-30.
  const range = (k) => def.gainRange?.[k] ?? [1e-6, 1e6];
  const toGains = (x) => {
    const g = { ...start };
    mask.forEach((k, i) => {
      const [lo, hi] = range(k);
      g[k] = Math.min(hi, Math.max(lo, 10 ** x[i]));
    });
    return g;
  };
  const f = (x) => tuningCost(def, toGains(x), o).J;
  const x0 = mask.map((k) => Math.log10(start[k]));
  const it = nelderMeadIter(f, x0, { maxEvals: o.maxEvals ?? 150, step: o.step ?? 0.25 });
  let r = it.next();
  while (!r.done) {
    const g = toGains(r.value.x);
    yield { evals: r.value.evals, gains: g, J: r.value.fx };
    r = it.next();
  }
  const g = toGains(r.value.x);
  const { J, m } = tuningCost(def, g, o);
  return { evals: r.value.evals, gains: g, J, m };
}

export function optimiseGains(plant, start, o) {
  const it = optimiseIter(plant, start, o);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
