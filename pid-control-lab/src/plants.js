/**
 * plants.js - continuous-time plant models integrated with classic RK4.
 *
 * Every plant is a plain definition object (parameters, units, ranges, default
 * gains) plus `deriv(x, u, d, p)` returning dx/dt. A PlantSim instance integrates it
 * with a fixed internal step h (0.5 ms - 10 ms depending on how fast the plant is),
 * completely independent of the controller sample time Ts. The input is held constant
 * between controller samples (zero-order hold), exactly like a DAC/PWM register.
 *
 * Units are SI unless noted. State vectors are plain arrays.
 */

/**
 * One classic 4th-order Runge-Kutta step for dx/dt = f(x).
 *   k1 = f(x)            k2 = f(x + h/2*k1)
 *   k3 = f(x + h/2*k2)   k4 = f(x + h*k3)
 *   x+ = x + h/6*(k1 + 2k2 + 2k3 + k4)          local error O(h^5), global O(h^4)
 * @param {(x:number[])=>number[]} f derivative (input u, disturbance d held constant)
 * @param {number[]} x state
 * @param {number} h step (s)
 * @returns {number[]} new state
 */
export function rk4Step(f, x, h) {
  const n = x.length;
  const tmp = new Array(n);
  const k1 = f(x);
  for (let i = 0; i < n; i++) tmp[i] = x[i] + 0.5 * h * k1[i];
  const k2 = f(tmp);
  for (let i = 0; i < n; i++) tmp[i] = x[i] + 0.5 * h * k2[i];
  const k3 = f(tmp);
  for (let i = 0; i < n; i++) tmp[i] = x[i] + h * k3[i];
  const k4 = f(tmp);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return out;
}

const G = 9.81;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/* ------------------------------------------------------------------------------------
 * DC motor (armature-controlled), shared by the speed and position plants.
 *   L di/dt = V - R i - Ke w            electrical: armature inductance + resistance + back-EMF
 *   J dw/dt = Kt i - B w - tau_load     mechanical: inertia + viscous friction + load torque
 * Steady state: w/V = Kt / (R B + Kt Ke)  (about 19.8 rad/s per volt with these numbers)
 * Time constants: electrical L/R = 5 ms, mechanical ~ J R / (Kt Ke + R B) = 0.16 s.
 * ---------------------------------------------------------------------------------- */
const MOTOR_PARAMS = { R: 2.0, L: 0.01, Kt: 0.05, Ke: 0.05, J: 2e-4, B: 1e-5 };

function motorDeriv(i, w, V, tauLoad, p) {
  const di = (V - p.R * i - p.Ke * w) / p.L;
  const dw = (p.Kt * i - p.B * w - tauLoad) / p.J;
  return [di, dw];
}
const motorGain = (p) => p.Kt / (p.R * p.B + p.Kt * p.Ke);

export const PLANTS = {
  'motor-speed': {
    id: 'motor-speed',
    name: 'DC motor - speed',
    short: 'Motor speed',
    description: 'Armature-controlled DC motor. Voltage in, shaft speed out. Fast and well damped; PI is the classic choice.',
    equations: ['L·di/dt = V − R·i − Ke·ω', 'J·dω/dt = Kt·i − B·ω − τ_load'],
    units: { u: 'V', y: 'rad/s', d: 'N·m', t: 's' },
    labels: { u: 'Voltage', y: 'Speed', d: 'Load torque' },
    params: { ...MOTOR_PARAMS },
    uMin: -12, uMax: 12,
    Ts: 0.005, h: 5e-4,
    spRange: [-200, 200], step: [0, 100], y0: 0,
    window: 1.5, duration: 1.0,
    defaultGains: { Kp: 0.12, Ki: 0.9, Kd: 0, N: 100 },
    presets: { P: { Kp: 0.12, Ki: 0, Kd: 0 }, PI: { Kp: 0.12, Ki: 0.9, Kd: 0 }, PID: { Kp: 0.12, Ki: 0.9, Kd: 0.0005 } },
    gainRange: { Kp: [1e-3, 2], Ki: [1e-2, 50], Kd: [1e-5, 0.05], N: [5, 1000] },
    disturbance: { value: 0.05, label: 'Load torque +0.05 N·m' },
    noiseStd: 1.0, quant: 0,
    relay: { h: 3, eps: 0 },
    init: () => [0, 0],
    deriv(x, u, d, p) { return motorDeriv(x[0], x[1], u, d, p); },
    output: (x) => x[1],
    equilibriumU: (y, p) => y / motorGain(p),
    staticGain: (p) => motorGain(p),
  },

  'motor-position': {
    id: 'motor-position',
    name: 'DC motor - position',
    short: 'Motor position',
    description: 'Same motor with an encoder on the shaft angle. The extra integrator means P alone already removes steady-state error for setpoint steps; D adds damping.',
    equations: ['L·di/dt = V − R·i − Ke·ω', 'J·dω/dt = Kt·i − B·ω − τ_load', 'dθ/dt = ω'],
    units: { u: 'V', y: 'rad', d: 'N·m', t: 's' },
    labels: { u: 'Voltage', y: 'Angle', d: 'Load torque' },
    params: { ...MOTOR_PARAMS },
    uMin: -12, uMax: 12,
    Ts: 0.005, h: 5e-4,
    spRange: [-6.28, 6.28], step: [0, 3.1416], y0: 0,
    window: 2.0, duration: 1.5,
    defaultGains: { Kp: 4, Ki: 0.5, Kd: 0.2, N: 100 },
    presets: { P: { Kp: 4, Ki: 0, Kd: 0 }, PI: { Kp: 4, Ki: 4, Kd: 0 }, PID: { Kp: 4, Ki: 0.5, Kd: 0.2 } },
    gainRange: { Kp: [1e-2, 50], Ki: [1e-2, 50], Kd: [1e-3, 2], N: [5, 1000] },
    disturbance: { value: 0.05, label: 'Load torque +0.05 N·m' },
    noiseStd: 0.002, quant: 2 * Math.PI / 4096,   // 1024-line quadrature encoder (x4)
    relay: { h: 2, eps: 0 },
    init: () => [0, 0, 0],
    deriv(x, u, d, p) {
      const [di, dw] = motorDeriv(x[0], x[1], u, d, p);
      return [di, dw, x[1]];
    },
    output: (x) => x[2],
    equilibriumU: () => 0,
    staticGain: () => Infinity,
  },

  /* ----------------------------------------------------------------------------------
   * Quadcopter altitude (vertical axis only).
   *   dT/dt = (clamp(u, 0, Tmax) - T) / tau_m     rotor thrust lag (props spin up)
   *   m dv/dt = T - m g - c v|v| + F_d             gravity, quadratic drag, disturbance
   *   dz/dt = v,  z >= 0 (the ground)
   * Thrust can't go negative, so the actuator is asymmetric: the drone can only "fall"
   * as fast as gravity allows. Hover needs u = m g, which the integrator must find.
   * -------------------------------------------------------------------------------- */
  drone: {
    id: 'drone',
    name: 'Quadcopter altitude',
    short: 'Drone altitude',
    description: 'Vertical axis of a 1 kg quadcopter. Thrust only pushes up (0-20 N), gravity pulls down and the integrator has to learn the hover thrust.',
    equations: ['τm·dT/dt = sat(u, 0, Tmax) − T', 'm·dv/dt = T − m·g − c·v·|v| + F_d', 'dz/dt = v,  z ≥ 0'],
    units: { u: 'N', y: 'm', d: 'N', t: 's' },
    labels: { u: 'Thrust', y: 'Altitude', d: 'Gust force' },
    params: { m: 1.0, c: 0.3, tauM: 0.05, Tmax: 20 },
    uMin: 0, uMax: 20,
    Ts: 0.01, h: 1e-3,
    spRange: [0, 10], step: [0, 5], y0: 0,
    window: 12, duration: 10,
    defaultGains: { Kp: 8, Ki: 3, Kd: 5, N: 20 },
    presets: { P: { Kp: 8, Ki: 0, Kd: 0 }, PI: { Kp: 8, Ki: 3, Kd: 0 }, PID: { Kp: 8, Ki: 3, Kd: 5 } },
    gainRange: { Kp: [1e-2, 30], Ki: [1e-3, 20], Kd: [1e-2, 20], N: [1, 200] },
    disturbance: { value: -4, label: 'Down-draft −4 N' },
    noiseStd: 0.02, quant: 0,
    relay: { h: 4, eps: 0 },
    init: () => [0, 0, 0],   // z, v, T
    deriv(x, u, d, p) {
      const [z, v, T] = x;
      const dT = (clamp(u, 0, p.Tmax) - T) / p.tauM;
      let dv = (T - p.m * G - p.c * v * Math.abs(v) + d) / p.m;
      if (z <= 0 && dv < 0 && v <= 0) dv = 0;   // resting on the ground
      return [v, dv, dT];
    },
    constrain(x) {                               // ground contact after each RK4 step
      if (x[0] < 0) { x[0] = 0; if (x[1] < 0) x[1] = 0; }
      return x;
    },
    output: (x) => x[0],
    equilibriumU: (y, p) => p.m * G,
    staticGain: () => Infinity,
  },

  /* ----------------------------------------------------------------------------------
   * Heater / thermal mass with transport delay (first-order plus dead time, FOPDT).
   *   tau dT/dt = -(T - (Tamb + d)) + K * sat(P(t - L), 0, 100)
   * Heat-only actuator (it can't cool), slow (tau = 60 s) and a 8 s dead time between
   * the heater and the sensor. Dead time is what makes it hard: aggressive gains
   * oscillate because the controller keeps reacting to old information.
   * -------------------------------------------------------------------------------- */
  heater: {
    id: 'heater',
    name: 'Heater with dead time',
    short: 'Heater',
    description: 'Thermal block with a 0-100 % heater, 60 s time constant and 8 s transport delay. Heat only - it cools just by losing heat to ambient.',
    equations: ['τ·dT/dt = −(T − T_amb − d) + K·sat(P(t − L), 0, 100)'],
    units: { u: '%', y: '°C', d: '°C', t: 's' },
    labels: { u: 'Heater power', y: 'Temperature', d: 'Ambient change' },
    params: { tau: 60, K: 0.8, L: 8, Tamb: 20 },
    uMin: 0, uMax: 100,
    Ts: 0.5, h: 0.01,
    spRange: [20, 95], step: [20, 60], y0: 20,
    window: 400, duration: 400,
    defaultGains: { Kp: 5, Ki: 0.2, Kd: 5, N: 0.5 },
    presets: { P: { Kp: 5, Ki: 0, Kd: 0 }, PI: { Kp: 5, Ki: 0.2, Kd: 0 }, PID: { Kp: 5, Ki: 0.2, Kd: 5 } },
    gainRange: { Kp: [1e-2, 50], Ki: [1e-4, 2], Kd: [1e-2, 200], N: [0.05, 20] },
    disturbance: { value: -10, label: 'Draft: ambient −10 °C' },
    noiseStd: 0.1, quant: 0.0625,                 // DS18B20-style 1/16 °C resolution
    relay: { h: 30, eps: 0 },
    delay: (p) => p.L,
    init: (p) => [p.Tamb],
    deriv(x, u, d, p) {
      return [(-(x[0] - p.Tamb - d) + p.K * clamp(u, 0, 100)) / p.tau];
    },
    output: (x) => x[0],
    equilibriumU: (y, p) => (y - p.Tamb) / p.K,
    staticGain: (p) => p.K,
  },

  /* ----------------------------------------------------------------------------------
   * Ball on beam (open-loop unstable: a double integrator).
   *   tau_s dα/dt = sat(u) - α                      beam-angle servo lag
   *   dx/dt = v,  dv/dt = (5/7) g sin α - f v       solid ball rolling without slipping
   * End stops at ±0.5 m. Without D the loop cannot be stabilised.
   * -------------------------------------------------------------------------------- */
  'ball-beam': {
    id: 'ball-beam',
    name: 'Ball on beam',
    short: 'Ball & beam',
    description: 'A rolling ball on a tilting beam: a double integrator, so it is unstable open loop. Proportional action alone just oscillates - you need D.',
    equations: ['τs·dα/dt = sat(u) − α', 'dv/dt = (5/7)·g·sin α − f·v', 'dx/dt = v,  |x| ≤ 0.5 m'],
    units: { u: 'rad', y: 'm', d: 'm/s²', t: 's' },
    labels: { u: 'Beam angle cmd', y: 'Ball position', d: 'Push' },
    params: { tauS: 0.05, f: 0.05, half: 0.5 },
    uMin: -0.25, uMax: 0.25,
    Ts: 0.01, h: 1e-3,
    spRange: [-0.4, 0.4], step: [0, 0.25], y0: 0,
    window: 8, duration: 6,
    defaultGains: { Kp: 3, Ki: 0.05, Kd: 1.2, N: 30 },
    presets: { P: { Kp: 3, Ki: 0, Kd: 0 }, PI: { Kp: 3, Ki: 0.05, Kd: 0 }, PID: { Kp: 3, Ki: 0.05, Kd: 1.2 } },
    gainRange: { Kp: [1e-3, 10], Ki: [1e-3, 5], Kd: [1e-3, 5], N: [1, 300] },
    disturbance: { value: 0.6, label: 'Push +0.6 m/s²' },
    noiseStd: 0.002, quant: 0,
    relay: { h: 0.05, eps: 0 },
    init: () => [0, 0, 0],   // x, v, alpha
    deriv(x, u, d, p) {
      const [pos, v, alpha] = x;
      return [v, (5 / 7) * G * Math.sin(alpha) - p.f * v + d, (clamp(u, -0.25, 0.25) - alpha) / p.tauS];
    },
    constrain(x, p) {
      if (x[0] > p.half) { x[0] = p.half; if (x[1] > 0) x[1] = 0; }
      if (x[0] < -p.half) { x[0] = -p.half; if (x[1] < 0) x[1] = 0; }
      return x;
    },
    output: (x) => x[0],
    equilibriumU: () => 0,
    staticGain: () => Infinity,
  },
};

export const PLANT_IDS = Object.keys(PLANTS);

/**
 * Runtime instance of a plant: owns the state vector, the internal clock and (for
 * dead-time plants) a FIFO of past inputs sampled at the internal step h.
 */
export class PlantSim {
  /**
   * @param {object|string} def plant definition or id
   * @param {object} [params] parameter overrides
   * @param {object} [opts] { h } internal step override
   */
  constructor(def, params = {}, opts = {}) {
    this.def = typeof def === 'string' ? PLANTS[def] : def;
    if (!this.def) throw new Error(`unknown plant ${def}`);
    this.p = { ...this.def.params, ...params };
    this.h = opts.h ?? this.def.h;
    this.reset();
  }

  reset(x0) {
    this.x = x0 ? x0.slice() : this.def.init(this.p);
    this.t = 0;
    const L = this.def.delay ? this.def.delay(this.p) : 0;
    // Dead time as a FIFO of n = L/h input samples; u(t - L) is the oldest entry.
    this.delayN = Math.round(L / this.h);
    this.fifo = new Float64Array(this.delayN);
    this.fifoIdx = 0;
    this.fifo.fill(this.def.uMin > 0 ? this.def.uMin : 0);
  }

  get y() { return this.def.output(this.x, this.p); }

  /**
   * Advance the plant by dt seconds with input u and disturbance d held constant.
   * dt is split into n = ceil(dt/h) equal RK4 steps of dt/n <= h, so any controller
   * sample time works. (The dead-time FIFO counts internal steps, so for plants with a
   * delay dt should be a multiple of h - true for all built-in plants.)
   */
  step(u, d, dt) {
    const steps = Math.max(1, Math.ceil(dt / this.h - 1e-9));
    const hh = dt / steps;
    const { def, p } = this;
    for (let s = 0; s < steps; s++) {
      let uEff = u;
      if (this.delayN > 0) {
        uEff = this.fifo[this.fifoIdx];          // input from L seconds ago
        this.fifo[this.fifoIdx] = u;
        this.fifoIdx = (this.fifoIdx + 1) % this.delayN;
      }
      this.x = rk4Step((x) => def.deriv(x, uEff, d, p), this.x, hh);
      if (def.constrain) this.x = def.constrain(this.x, p);
      this.t += hh;
    }
    return this.y;
  }
}

/** Generic first-order test plant  tau dy/dt = -y + K u  (used by the RK4 accuracy test). */
export function firstOrderPlant(K = 2, tau = 0.1) {
  return {
    id: 'first-order', params: { K, tau }, h: 1e-3, uMin: -Infinity, uMax: Infinity,
    init: () => [0],
    deriv: (x, u, d, p) => [(-x[0] + p.K * u + d) / p.tau],
    output: (x) => x[0],
  };
}

/** Third-order lag K/(tau s + 1)^3 - the classic relay-autotune benchmark. */
export function thirdOrderPlant(K = 1, tau = 1) {
  return {
    id: 'third-order', params: { K, tau }, h: 1e-3, uMin: -Infinity, uMax: Infinity,
    init: () => [0, 0, 0],
    deriv: (x, u, d, p) => [
      (p.K * u - x[0]) / p.tau,
      (x[0] - x[1]) / p.tau,
      (x[1] - x[2]) / p.tau,
    ],
    output: (x) => x[2],
    equilibriumU: (y, p) => y / p.K,
  };
}
