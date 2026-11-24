/**
 * metrics.js - step-response and performance metrics from a sampled time series.
 *
 * All metrics are computed for a single setpoint step from y0 (output at the step) to
 * r (the new setpoint). Let A = r - y0 be the step amplitude (sign-aware, so a step
 * down works the same as a step up) and tau = t - tStep the time since the step.
 *
 *   rise time      t(90 %) - t(10 %) of A (first crossings, linearly interpolated)
 *   overshoot %    max(0, max over window of (y - r)/A) * 100
 *   settling time  last tau at which |y - r| > 2 % of |A|   (0 if it never leaves the band)
 *   SSE            r - mean(y) over the last 10 % of the window
 *   IAE  = sum |e| Ts      ISE  = sum e^2 Ts      ITAE = sum tau |e| Ts
 *   effort L1 = sum |u| Ts, L2 = sum u^2 Ts
 *   TV             total variation sum |u[k] - u[k-1]| (how "busy" the actuator is)
 *   saturation %   share of samples with u at (within 1e-9 of) a limit
 *
 * Settling uses the "never leaves the band again" definition, which is what a scope
 * measurement would give you. If the response never settles, settle = Infinity.
 */

/**
 * @param {object} s series with t, sp, y, u (array-likes) and optional uMin/uMax
 * @param {object} [o]
 * @param {number} [o.from=0] first sample index (the step instant)
 * @param {number} [o.to=s.t.length] end index (exclusive)
 * @param {number} [o.y0] output before the step (default: y[from])
 * @param {number} [o.r] final setpoint (default: sp[to-1])
 * @param {number} [o.band=0.02] settling band as a fraction of |A|
 * @param {string} [o.yKey='y'] which output column to use (use 'yTrue' to ignore noise)
 */
export function stepMetrics(s, o = {}) {
  const from = o.from ?? 0;
  const to = o.to ?? s.t.length;
  const Y = s[o.yKey ?? 'y'];
  const y0 = o.y0 ?? Y[from];
  const r = o.r ?? s.sp[to - 1];
  const A = r - y0;
  const band = (o.band ?? 0.02) * Math.abs(A);
  const t0 = s.t[from];
  const Ts = to - from > 1 ? s.t[from + 1] - s.t[from] : 0;
  const uMin = o.uMin ?? s.uMin ?? -Infinity;
  const uMax = o.uMax ?? s.uMax ?? Infinity;

  const out = {
    amplitude: A, rise: NaN, overshoot: 0, peak: y0, peakTime: 0, settle: 0,
    sse: NaN, iae: 0, ise: 0, itae: 0, effortL1: 0, effortL2: 0, tv: 0, satPct: 0,
  };
  if (to - from < 2) return out;

  // Normalised progress p = (y - y0)/A runs 0 -> 1 for any step direction.
  const prog = (i) => (A === 0 ? 1 : (Y[i] - y0) / A);
  const cross = (level) => {
    for (let i = from + 1; i < to; i++) {
      const p0 = prog(i - 1), p1 = prog(i);
      if (p0 < level && p1 >= level) {
        const f = p1 === p0 ? 0 : (level - p0) / (p1 - p0);
        return s.t[i - 1] + f * (s.t[i] - s.t[i - 1]) - t0;
      }
    }
    return NaN;
  };
  const t10 = cross(0.1), t90 = cross(0.9);
  out.rise = Number.isFinite(t10) && Number.isFinite(t90) ? t90 - t10 : NaN;

  let maxProg = -Infinity, lastOut = -1, sat = 0;
  for (let i = from; i < to; i++) {
    const p = prog(i);
    if (p > maxProg) { maxProg = p; out.peak = Y[i]; out.peakTime = s.t[i] - t0; }
    const e = s.sp[i] - Y[i];
    const tau = s.t[i] - t0;
    out.iae += Math.abs(e) * Ts;
    out.ise += e * e * Ts;
    out.itae += tau * Math.abs(e) * Ts;
    const u = s.u[i];
    out.effortL1 += Math.abs(u) * Ts;
    out.effortL2 += u * u * Ts;
    if (i > from) out.tv += Math.abs(u - s.u[i - 1]);
    if (u >= uMax - 1e-9 || u <= uMin + 1e-9) sat++;
    if (Math.abs(Y[i] - r) > band) lastOut = i;
  }
  out.overshoot = A === 0 ? 0 : Math.max(0, (maxProg - 1) * 100);
  if (lastOut === to - 1) out.settle = Infinity;
  else if (lastOut >= from) out.settle = s.t[lastOut + 1] - t0;
  out.satPct = (100 * sat) / (to - from);

  const tailStart = to - Math.max(1, Math.floor((to - from) * 0.1));
  let sum = 0;
  for (let i = tailStart; i < to; i++) sum += Y[i];
  out.sse = r - sum / (to - tailStart);
  return out;
}

/** Format helper shared by the demo and the README generator. */
export function fmtMetric(v, digits = 3) {
  if (v === Infinity) return '∞';
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a < 1e-6) return '0';
  if (a < 1e-3 || a >= 1e5) return v.toExponential(2);
  const s = v.toPrecision(digits);
  if (s.includes('e')) return v.toFixed(0);       // e.g. 99.97 with 2 digits -> "100"
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
