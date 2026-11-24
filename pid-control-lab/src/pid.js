/**
 * pid.js - discrete PID controller with a fixed sample time Ts.
 *
 * This is the reference implementation. firmware/pid.c mirrors it line for
 * line (in float) and a golden-trajectory test checks they agree.
 *
 * Control law, evaluated once per sample k (r = setpoint, y = measurement):
 *
 *   e[k]  = r[k] - y[k]
 *   P[k]  = Kp * (b*r[k] - y[k])                      setpoint weighting b (0..1)
 *   D[k]  = a*D[k-1] + kd*(ed[k] - ed[k-1])           filtered derivative
 *           ed[k] = c*r[k] - y[k]                     c = 0: derivative on measurement
 *           a  = Tf / (Tf + Ts),  kd = Kd / (Tf + Ts) (backward Euler of Kd*s/(Tf*s + 1))
 *   v[k]  = P[k] + I[k] + D[k]                        unsaturated output
 *   u[k]  = clamp(v[k], uMin, uMax)                   saturated output (sent to the actuator)
 *   I[k+1]= I[k] + Ki*Ts*e[k]                         forward Euler integral, plus anti-windup:
 *           'clamp'    : skip the update while saturated AND e pushes further into saturation
 *           'backcalc' : add (Ts/Tt)*(u[k] - v[k]) so I bleeds off while saturated
 *           'none'     : plain integration (shows windup)
 *
 * Design notes:
 *  - The integral is stored in output units (it already contains Ki), so changing Ki
 *    never makes the output jump. Kp/b/Kd changes are made bumpless in setGains().
 *  - Backward Euler for the derivative filter is stable for any Tf >= 0 (Tf = 0 gives
 *    the raw difference quotient) - forward Euler would go unstable when Tf < Ts/2.
 *  - Forward Euler for the integral means u[k] only depends on errors up to k-1 in the
 *    I term, which keeps the update order simple: compute output, then update state.
 *  - On the very first sample the previous ed is initialised to the current one, so D
 *    starts at 0 instead of producing a spike.
 */

/** Anti-windup modes. */
export const AW_NONE = 'none';
export const AW_CLAMP = 'clamp';
export const AW_BACKCALC = 'backcalc';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Derivative filter time constant from options: explicit `tf` (seconds) wins,
 * otherwise Tf = 1/N where N is the filter bandwidth in rad/s (N = Infinity -> no filter).
 */
export function filterTimeConstant({ tf, N }) {
  if (Number.isFinite(tf) && tf >= 0) return tf;
  if (Number.isFinite(N) && N > 0) return 1 / N;
  return 0;
}

/**
 * Back-calculation tracking time constant. Tt = Ti/2 (Ti = Kp/Ki) is a common rule of
 * thumb (it equals sqrt(Ti*Td) for ZN-style Td = Ti/4) and needs no sqrt in the C port.
 * Tt is never allowed below Ts, otherwise the correction would overshoot in one sample.
 */
export function autoTrackingTime(Kp, Ki, Ts) {
  if (!(Ki > 0) || !(Kp > 0)) return Ts;
  return Math.max(Ts, 0.5 * Kp / Ki);
}

export class PID {
  /**
   * @param {object} o
   * @param {number} o.Kp proportional gain
   * @param {number} o.Ki integral gain (1/s)       - Ki = Kp/Ti
   * @param {number} o.Kd derivative gain (s)       - Kd = Kp*Td
   * @param {number} o.Ts sample time (s)
   * @param {number} [o.N=Infinity] derivative filter bandwidth (rad/s), Tf = 1/N
   * @param {number} [o.tf] derivative filter time constant (s); overrides N
   * @param {number} [o.b=1] proportional setpoint weight
   * @param {boolean} [o.derivativeOnMeasurement=true] c = 0 when true, c = 1 when false
   * @param {number} [o.uMin=-Infinity] output lower limit
   * @param {number} [o.uMax=Infinity] output upper limit
   * @param {'none'|'clamp'|'backcalc'} [o.antiWindup='clamp']
   * @param {number} [o.Tt] back-calculation tracking time constant (s); default autoTrackingTime()
   */
  constructor(o = {}) {
    this.Kp = o.Kp ?? 1;
    this.Ki = o.Ki ?? 0;
    this.Kd = o.Kd ?? 0;
    this.Ts = o.Ts ?? 0.01;
    if (!(this.Ts > 0)) throw new Error('PID: Ts must be > 0');
    this.N = o.N ?? Infinity;
    this.tfOverride = o.tf;
    this.b = o.b ?? 1;
    this.derivativeOnMeasurement = o.derivativeOnMeasurement ?? true;
    this.uMin = o.uMin ?? -Infinity;
    this.uMax = o.uMax ?? Infinity;
    this.antiWindup = o.antiWindup ?? AW_CLAMP;
    this.TtOverride = o.Tt;
    this.reset();
  }

  /** Derivative setpoint weight c. */
  get c() { return this.derivativeOnMeasurement ? 0 : 1; }
  get Tf() { return filterTimeConstant({ tf: this.tfOverride, N: this.N }); }
  get Tt() { return this.TtOverride > 0 ? this.TtOverride : autoTrackingTime(this.Kp, this.Ki, this.Ts); }

  /** Clear all dynamic state. Optional I0 preloads the integrator (e.g. a feed-forward bias). */
  reset(I0 = 0) {
    this.I = I0;        // integral term, output units
    this.D = 0;         // filtered derivative term, output units
    this.edPrev = 0;    // previous c*r - y
    this.started = false;
    this.last = { P: 0, I: I0, D: 0, v: I0, u: clamp(I0, this.uMin, this.uMax), e: 0, sat: 0 };
  }

  /**
   * One controller sample. Call exactly every Ts seconds.
   * @returns {number} saturated output u[k]
   */
  update(r, y) {
    const { Kp, Ki, Kd, Ts, b } = this;
    const e = r - y;
    const ed = this.c * r - y;
    if (!this.started) { this.edPrev = ed; this.started = true; }

    // Proportional (with setpoint weight b; b < 1 softens the response to setpoint steps)
    const P = Kp * (b * r - y);

    // Filtered derivative, backward Euler:  D[k] = a*D[k-1] + Kd/(Tf+Ts) * (ed[k] - ed[k-1])
    const Tf = this.Tf;
    const a = Tf / (Tf + Ts);
    const D = a * this.D + (Kd / (Tf + Ts)) * (ed - this.edPrev);

    // Output and saturation
    const I = this.I;
    const v = P + I + D;
    const u = clamp(v, this.uMin, this.uMax);
    const sat = v > this.uMax ? 1 : v < this.uMin ? -1 : 0;

    // Integral update for the next sample, with anti-windup
    let dI = Ki * Ts * e;
    if (this.antiWindup === AW_CLAMP) {
      // Conditional integration: freeze while the output is saturated and the error
      // would drive it further into saturation. Integration resumes as soon as the
      // error changes sign, so the controller comes out of saturation promptly.
      if ((sat > 0 && e > 0) || (sat < 0 && e < 0)) dI = 0;
    } else if (this.antiWindup === AW_BACKCALC) {
      // Back-calculation: feed the saturation excess back into the integrator.
      dI += (Ts / this.Tt) * (u - v);
    }
    this.I = I + dI;
    this.D = D;
    this.edPrev = ed;

    this.last = { P, I, D, v, u, e, sat };
    return u;
  }

  /**
   * Change gains without a bump in the output. The integrator absorbs the step that the
   * new Kp/b/Kd would otherwise cause, evaluated at the latest (r, y). Ki needs no
   * compensation because I is stored in output units.
   */
  setGains({ Kp = this.Kp, Ki = this.Ki, Kd = this.Kd, b = this.b } = {}, r, y) {
    if (this.started && Number.isFinite(r) && Number.isFinite(y)) {
      const pOld = this.Kp * (this.b * r - y);
      const pNew = Kp * (b * r - y);
      const dOld = this.D;
      const dNew = this.Kd !== 0 ? this.D * (Kd / this.Kd) : 0;
      this.I += (pOld - pNew) + (dOld - dNew);
      this.D = dNew;
    }
    this.Kp = Kp; this.Ki = Ki; this.Kd = Kd; this.b = b;
  }

  /** Change limits or other options; the state is kept. */
  configure(o = {}) {
    for (const k of ['N', 'uMin', 'uMax', 'antiWindup', 'derivativeOnMeasurement']) {
      if (o[k] !== undefined) this[k] = o[k];
    }
    if (o.tf !== undefined) this.tfOverride = o.tf;
    if (o.Tt !== undefined) this.TtOverride = o.Tt;
  }
}
