import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, ClosedLoop, mulberry32, gaussian, scheduleValue, stepResponse } from '../src/sim.js';
import { stepMetrics } from '../src/metrics.js';
import { PLANTS, PLANT_IDS } from '../src/plants.js';

test('seeded noise is deterministic; different seeds differ; std is right', () => {
  const o = { plant: 'drone', duration: 3, noise: { std: 0.05, seed: 42 } };
  const a = simulate(o), b = simulate(o);
  assert.deepEqual(Array.from(a.y), Array.from(b.y));
  assert.deepEqual(Array.from(a.u), Array.from(b.u));
  const c = simulate({ ...o, noise: { std: 0.05, seed: 43 } });
  assert.notDeepEqual(Array.from(a.y), Array.from(c.y));

  const g = gaussian(mulberry32(7));
  let s = 0, s2 = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) { const x = g(); s += x; s2 += x * x; }
  assert.ok(Math.abs(s / n) < 0.03 && Math.abs(Math.sqrt(s2 / n) - 1) < 0.03);
});

test('stepping in uneven chunks gives the identical trajectory (frame-rate independent)', () => {
  const o = { plant: 'motor-speed', noise: { std: 1, seed: 5 }, disturbance: [{ t: 0.3, value: 0.05 }] };
  const ref = simulate({ ...o, duration: 1 });
  const loop = new ClosedLoop(o);
  const ys = [];
  const chunks = [1, 7, 3, 33, 2, 0, 19];
  let i = 0;
  while (ys.length < ref.n) {
    const c = Math.min(chunks[i++ % chunks.length], ref.n - ys.length);
    for (let k = 0; k < c; k++) ys.push(loop.tick().y);
  }
  assert.deepEqual(ys, Array.from(ref.y));
});

test('sensor quantisation and actuator rate limit', () => {
  const q = 0.0625;
  const s = simulate({ plant: 'heater', duration: 60, quant: q, noise: { std: 0.1, seed: 1 } });
  assert.ok(s.y.every((y) => Math.abs(y / q - Math.round(y / q)) < 1e-9));
  const r = simulate({ plant: 'motor-speed', duration: 0.5, rateLimit: 100 });
  for (let i = 1; i < r.n; i++) assert.ok(Math.abs(r.u[i] - r.u[i - 1]) <= 100 * r.Ts + 1e-12);
});

test('schedules are piecewise constant', () => {
  const sch = [{ t: 0, value: 1 }, { t: 2, value: 5 }];
  assert.equal(scheduleValue(sch, 1.99), 1);
  assert.equal(scheduleValue(sch, 2), 5);
  assert.equal(scheduleValue(3, 10), 3);
});

test('metrics: first-order step matches analytic rise, settling, IAE, ITAE', () => {
  // y = 1 - e^{-t/tau}: rise(10-90) = tau ln 9, settle(2%) = tau ln 50, IAE = tau, ITAE = tau^2
  const tau = 0.5, Ts = 1e-3, n = 10000;
  const s = { t: [], sp: [], y: [], u: [] };
  for (let i = 0; i < n; i++) {
    const t = i * Ts;
    s.t.push(t); s.sp.push(1); s.y.push(1 - Math.exp(-t / tau)); s.u.push(1);
  }
  const m = stepMetrics(s, { y0: 0, r: 1 });
  assert.ok(Math.abs(m.rise - tau * Math.log(9)) < 2e-3, `rise ${m.rise}`);
  assert.ok(Math.abs(m.settle - tau * Math.log(50)) < 2e-3, `settle ${m.settle}`);
  assert.equal(m.overshoot, 0);
  assert.ok(Math.abs(m.iae - tau) < 2e-3, `iae ${m.iae}`);
  assert.ok(Math.abs(m.itae - tau * tau) < 2e-3, `itae ${m.itae}`);
  assert.ok(Math.abs(m.ise - tau / 2) < 2e-3);
  assert.ok(Math.abs(m.sse) < 1e-3);
  assert.ok(Math.abs(m.effortL1 - 10) < 1e-9 && m.satPct === 0);
});

test('metrics: underdamped 2nd-order overshoot = exp(-zeta*pi/sqrt(1-zeta^2)), step down works too', () => {
  const z = 0.3, wn = 5, Ts = 1e-3, n = 8000;
  const wd = wn * Math.sqrt(1 - z * z), phi = Math.acos(z);
  const mk = (sign) => {
    const s = { t: [], sp: [], y: [], u: [] };
    for (let i = 0; i < n; i++) {
      const t = i * Ts;
      const y = 1 - Math.exp(-z * wn * t) * Math.sin(wd * t + phi) / Math.sqrt(1 - z * z);
      s.t.push(t); s.sp.push(sign); s.y.push(sign * y); s.u.push(i % 2 ? 1 : -1);
    }
    return stepMetrics(s, { y0: 0, uMin: -1, uMax: 1 });
  };
  const expected = 100 * Math.exp(-z * Math.PI / Math.sqrt(1 - z * z));
  const up = mk(1), down = mk(-1);
  assert.ok(Math.abs(up.overshoot - expected) < 0.05, `os ${up.overshoot} vs ${expected}`);
  assert.ok(Math.abs(down.overshoot - expected) < 0.05);
  assert.ok(Math.abs(up.peakTime - Math.PI / wd) < 2e-3);
  assert.equal(up.satPct, 100);
});

/*
 * Documented bounds for the default gains (README "Default gains" table). Noise-free
 * standard step: plant at rest, setpoint step[0] -> step[1] at t = 0.
 */
const BOUNDS = {
  'motor-speed':    { os: 3,  settle: 0.3,  sse: 0.5 },
  'motor-position': { os: 3,  settle: 0.2,  sse: 0.05 },
  drone:            { os: 3,  settle: 4,    sse: 0.02 },
  heater:           { os: 4,  settle: 80,   sse: 0.05 },
  'ball-beam':      { os: 3,  settle: 2,    sse: 0.005 },
};

test('closed-loop metrics for the default gains stay within documented bounds', () => {
  for (const id of PLANT_IDS) {
    const def = PLANTS[id];
    const m = stepMetrics(stepResponse(id), { yKey: 'yTrue', y0: def.step[0] });
    const b = BOUNDS[id];
    assert.ok(m.overshoot <= b.os, `${id} overshoot ${m.overshoot}`);
    assert.ok(m.settle <= b.settle, `${id} settling ${m.settle}`);
    assert.ok(Math.abs(m.sse) <= b.sse, `${id} sse ${m.sse}`);
    assert.ok(Number.isFinite(m.rise), `${id} rise`);
  }
});

test('P vs PI vs PID on the drone: P leaves offset, PI overshoots, PID settles', () => {
  const pr = PLANTS.drone.presets;
  const m = (g) => stepMetrics(stepResponse('drone', g), { yKey: 'yTrue', y0: 0 });
  const P = m(pr.P), PI = m(pr.PI), PID = m(pr.PID);
  assert.ok(P.sse > 1, `P offset ${P.sse}`);                 // gravity: offset ~ m*g/Kp
  assert.ok(PI.overshoot > 10, `PI overshoot ${PI.overshoot}`);
  assert.ok(PID.overshoot < 3 && Number.isFinite(PID.settle));
  assert.ok(PID.itae < PI.itae && PI.itae < P.itae);
});
