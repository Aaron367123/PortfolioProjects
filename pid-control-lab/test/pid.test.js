import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PID, autoTrackingTime, filterTimeConstant } from '../src/pid.js';
import { stepResponse } from '../src/sim.js';
import { stepMetrics } from '../src/metrics.js';

const near = (a, b, tol = 1e-12, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

test('P term: u = Kp*(b*r - y), setpoint weight b', () => {
  const pid = new PID({ Kp: 2, Ts: 0.01 });
  near(pid.update(1, 0.25), 1.5);
  const w = new PID({ Kp: 2, Ts: 0.01, b: 0.5 });
  near(w.update(1, 0.25), 0.5);              // 2*(0.5*1 - 0.25)
});

test('PI difference equation matches hand-computed steps', () => {
  // Kp = 1, Ki = 10, Ts = 0.1, constant e = 1:
  //   k=0: P=1, I=0 -> u=1; I <- 0 + 10*0.1*1 = 1
  //   k=1: u = 1 + 1 = 2; I <- 2       k=2: u = 3
  const pid = new PID({ Kp: 1, Ki: 10, Ts: 0.1 });
  near(pid.update(1, 0), 1);
  near(pid.update(1, 0), 2);
  near(pid.update(1, 0), 3);
  near(pid.last.I, 2);
  // error halves -> integral increment halves
  near(pid.update(1, 0.5), 0.5 + 3);        // P = 0.5, I = 3
  near(pid.I, 3.5);
});

test('filtered derivative matches hand-computed backward-Euler steps', () => {
  // Kd = 0.5, Tf = 0.05, Ts = 0.01 -> a = 0.05/0.06, kd' = 0.5/0.06
  const pid = new PID({ Kp: 0, Kd: 0.5, tf: 0.05, Ts: 0.01 });
  near(pid.update(0, 0), 0);
  const D1 = -(0.5 / 0.06) * 1;             // measurement steps 0 -> 1
  near(pid.update(0, 1), D1, 1e-12);
  const D2 = (0.05 / 0.06) * D1;             // then holds -> decays geometrically
  near(pid.update(0, 1), D2, 1e-12);
  // N option: Tf = 1/N
  near(filterTimeConstant({ N: 20 }), 0.05);
  near(filterTimeConstant({ N: Infinity }), 0);
});

test('derivative on a ramp converges to -Kd * slope', () => {
  const pid = new PID({ Kp: 0, Kd: 2, N: 50, Ts: 0.01 });
  let u = 0;
  for (let k = 0; k < 300; k++) u = pid.update(0, 3 * k * 0.01);
  near(u, -6, 1e-9);
});

test('no derivative kick on a setpoint step with derivative on measurement', () => {
  const onMeas = new PID({ Kp: 0, Kd: 0.5, tf: 0.05, Ts: 0.01, derivativeOnMeasurement: true });
  onMeas.update(0, 0);
  near(onMeas.update(1, 0), 0);
  const onErr = new PID({ Kp: 0, Kd: 0.5, tf: 0.05, Ts: 0.01, derivativeOnMeasurement: false });
  onErr.update(0, 0);
  near(onErr.update(1, 0), 0.5 / 0.06, 1e-12);   // the kick: Kd/(Tf+Ts) * dr

  // In closed loop: peak |u| right after the step is far smaller without the kick.
  const sp = { setpoint: [{ t: 0, value: 20 }, { t: 5, value: 60 }] };
  const kick = stepResponse('heater', { derivativeOnMeasurement: false }, sp);
  const noKick = stepResponse('heater', { derivativeOnMeasurement: true }, sp);
  const k = Math.round(5 / kick.Ts);          // sample of the setpoint step
  near(kick.D[k], 5 / (2 + 0.5) * 40, 1e-9, 'derivative on error kicks: Kd/(Tf+Ts)*dr =');
  near(noKick.D[k], 0, 0, 'derivative on measurement does not');
  assert.ok(Math.max(...kick.u.slice(k, k + 4)) === 100, 'the kick saturates the heater');
});

test('first sample after reset produces no derivative spike', () => {
  const pid = new PID({ Kp: 0, Kd: 1, Ts: 0.01 });
  near(pid.update(0, 5), 0);
  pid.update(0, 6);
  pid.reset();
  near(pid.update(0, 10), 0);
  near(pid.I, 0);
});

test('clamping anti-windup: the integrator stops growing in saturation', () => {
  const clamp = new PID({ Kp: 1, Ki: 5, Ts: 0.01, uMin: -1, uMax: 1, antiWindup: 'clamp' });
  const none = new PID({ Kp: 1, Ki: 5, Ts: 0.01, uMin: -1, uMax: 1, antiWindup: 'none' });
  for (let k = 0; k < 100; k++) { clamp.update(10, 0); none.update(10, 0); }
  near(clamp.I, 0);
  assert.equal(clamp.last.sat, 1);
  near(none.I, 50, 1e-9);                    // 100 * Ki*Ts*e = 100*0.5
  // Back inside the limits -> integration resumes immediately (no wound-up state to unwind)
  clamp.update(0.5, 0);
  near(clamp.I, 5 * 0.01 * 0.5, 1e-12);
});

test('back-calculation anti-windup converges to the analytic fixed point', () => {
  // Fixed point: Ki*e + (u - P - I)/Tt = 0  ->  I = u - P + Ki*e*Tt = 1 - 10 + 5*10*0.1 = -4
  const pid = new PID({ Kp: 1, Ki: 5, Ts: 0.01, uMin: -1, uMax: 1, antiWindup: 'backcalc', Tt: 0.1 });
  for (let k = 0; k < 500; k++) pid.update(10, 0);
  near(pid.I, -4, 1e-9);
  near(autoTrackingTime(2, 1, 0.01), 1);     // Ti/2
  near(autoTrackingTime(0.001, 100, 0.01), 0.01);   // never below Ts
});

test('windup vs anti-windup in closed loop: windup overshoots much more', () => {
  const m = (aw) => stepMetrics(stepResponse('heater', { antiWindup: aw }), { yKey: 'yTrue', y0: 20 });
  const none = m('none'), clamp = m('clamp'), back = m('backcalc');
  assert.ok(none.overshoot > 30, `no anti-windup overshoot ${none.overshoot}`);
  assert.ok(clamp.overshoot < 5, `clamp overshoot ${clamp.overshoot}`);
  assert.ok(back.overshoot < 10, `back-calc overshoot ${back.overshoot}`);
  assert.ok(none.settle > 1.5 * clamp.settle);
});

test('setGains is bumpless for the same (r, y)', () => {
  const pid = new PID({ Kp: 2, Ki: 1, Kd: 0.3, N: 20, Ts: 0.01 });
  pid.update(1, 0.2);
  pid.update(1, 0.3);
  const before = pid.Kp * (pid.b * 1 - 0.3) + pid.I + pid.D;
  pid.setGains({ Kp: 5, Ki: 2, Kd: 0.1 }, 1, 0.3);
  const after = pid.Kp * (pid.b * 1 - 0.3) + pid.I + pid.D;
  near(after, before, 1e-12);
  assert.equal(pid.Kp, 5);
});

test('output saturation and Ts validation', () => {
  const pid = new PID({ Kp: 100, Ts: 0.01, uMin: -2, uMax: 3 });
  assert.equal(pid.update(1, 0), 3);
  assert.equal(pid.update(-1, 0), -2);
  assert.throws(() => new PID({ Ts: 0 }));
});
