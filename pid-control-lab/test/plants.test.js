import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANTS, PLANT_IDS, PlantSim, rk4Step, firstOrderPlant } from '../src/plants.js';

const run = (id, u, seconds, d = 0, params) => {
  const p = new PlantSim(id, params);
  const Ts = p.def.Ts;
  const n = Math.round(seconds / Ts);
  const ys = [];
  for (let k = 0; k < n; k++) ys.push(p.step(u, d, Ts));
  return { p, ys };
};

test('RK4 matches the analytic first-order step response to < 1e-6', () => {
  // tau dy/dt = -y + K u,  y(t) = K u (1 - e^{-t/tau})
  const def = firstOrderPlant(2, 0.1);
  const p = new PlantSim(def);
  let maxErr = 0;
  for (let k = 1; k <= 1000; k++) {
    p.step(1, 0, 1e-3);
    const exact = 2 * (1 - Math.exp(-(k * 1e-3) / 0.1));
    maxErr = Math.max(maxErr, Math.abs(p.y - exact));
  }
  assert.ok(maxErr < 1e-6, `max error ${maxErr}`);
});

test('RK4 is 4th-order: halving h cuts the error ~16x', () => {
  const f = (x) => [-x[0] / 0.1];
  const err = (h) => {
    let x = [1];
    for (let t = 0; t < 0.5 - 1e-12; t += h) x = rk4Step(f, x, h);
    return Math.abs(x[0] - Math.exp(-5));
  };
  const ratio = err(0.01) / err(0.005);
  assert.ok(ratio > 14 && ratio < 18, `ratio ${ratio}`);
});

test('every plant declares units, ranges, gains and a working model', () => {
  for (const id of PLANT_IDS) {
    const d = PLANTS[id];
    for (const k of ['u', 'y', 'd', 't']) assert.ok(d.units[k], `${id} unit ${k}`);
    assert.ok(d.uMin < d.uMax && d.Ts > 0 && d.h > 0 && d.h <= d.Ts, `${id} ranges`);
    assert.ok(Number.isInteger(Math.round(d.Ts / d.h)) && Math.abs(d.Ts / d.h - Math.round(d.Ts / d.h)) < 1e-9);
    for (const g of ['Kp', 'Ki', 'Kd']) assert.ok(d.defaultGains[g] >= 0 && d.gainRange[g][0] > 0);
    assert.ok(d.presets.P && d.presets.PI && d.presets.PID);
    assert.equal(d.init(d.params).length, d.deriv(d.init(d.params), 0, 0, d.params).length);
  }
});

test('motor speed: 12 V settles at Kt/(R B + Kt Ke) * V and draws the right current', () => {
  const { p } = run('motor-speed', 12, 2);
  const { R, B, Kt, Ke } = p.p;
  const wss = 12 * Kt / (R * B + Kt * Ke);
  assert.ok(Math.abs(p.y - wss) / wss < 1e-4, `w ${p.y} vs ${wss}`);
  const iss = (12 - Ke * wss) / R;
  assert.ok(Math.abs(p.x[0] - iss) < 1e-4, `i ${p.x[0]} vs ${iss}`);
  // load torque slows it down
  const loaded = run('motor-speed', 12, 2, 0.05).p.y;
  assert.ok(loaded < p.y - 30);
});

test('motor position: angle is the integral of speed, 0 V holds still', () => {
  const still = run('motor-position', 0, 1).p;
  assert.equal(still.y, 0);
  const { p, ys } = run('motor-position', 1, 2);
  // after the transient, dtheta/dt -> w_ss = 19.8 rad/s per volt
  const slope = (ys[ys.length - 1] - ys[ys.length - 101]) / (100 * p.def.Ts);
  assert.ok(Math.abs(slope - p.x[1]) < 1e-3, `slope ${slope} vs w ${p.x[1]}`);
  assert.ok(Math.abs(slope - 19.84) < 0.05);
});

test('drone: hover thrust stays on the ground, more thrust climbs to terminal velocity', () => {
  const hover = run('drone', 9.81, 3).p;
  assert.ok(hover.y < 1e-6, `hover from rest ${hover.y}`);
  const climb = run('drone', 12, 10).p;
  const vt = Math.sqrt((12 - 9.81) / 0.3);
  assert.ok(Math.abs(climb.x[1] - vt) < 1e-3, `v ${climb.x[1]} vs ${vt}`);
  assert.ok(climb.y > 15);
  // thrust can't go negative even if commanded
  const neg = run('drone', -50, 1).p;
  assert.ok(neg.x[2] >= 0 && neg.y === 0);
});

test('heater: steady state Tamb + K*P, transport delay of L seconds, heat only', () => {
  const { p, ys } = run('heater', 50, 1200);
  assert.ok(Math.abs(p.y - 60) < 0.01, `T ${p.y}`);
  // nothing reaches the sensor during the first L = 8 s
  const Ts = p.def.Ts;
  assert.ok(ys.slice(0, Math.floor(7.9 / Ts)).every((y) => y === 20));
  assert.ok(ys[Math.round(9 / Ts)] > 20);
  // negative command can't cool below ambient
  assert.equal(run('heater', -100, 100).p.y, 20);
  // ambient drop disturbance
  assert.ok(Math.abs(run('heater', 0, 1200, -10).p.y - 10) < 0.01);
});

test('ball on beam: open-loop unstable, end stops hold the ball on the beam', () => {
  assert.equal(run('ball-beam', 0, 2).p.y, 0);
  const { p, ys } = run('ball-beam', 0.05, 5);
  assert.ok(ys[50] > 0 && ys[100] > ys[50]);          // keeps accelerating
  assert.equal(p.y, 0.5);                              // stopped at the end
});
