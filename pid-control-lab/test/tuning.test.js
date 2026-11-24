import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayAutotune, gainsFromRule, nelderMead, optimiseGains, tuningCost, TUNING_RULES } from '../src/tuning.js';
import { thirdOrderPlant, PLANTS, PLANT_IDS } from '../src/plants.js';

test('relay autotune finds Ku and Tu of K/(tau s + 1)^3 within 5 % of analytic', () => {
  // Phase -180 deg where 3*atan(w*tau) = pi  ->  w = sqrt(3)/tau
  // |G(jw)| = K / (1 + 3)^(3/2) = K/8        ->  Ku = 8/K, Tu = 2*pi*tau/sqrt(3)
  for (const [K, tau] of [[1, 1], [2, 0.5]]) {
    const KuExact = 8 / K, TuExact = (2 * Math.PI * tau) / Math.sqrt(3);
    const r = relayAutotune(thirdOrderPlant(K, tau), { setpoint: 1, h: 1, Ts: tau / 200, maxTime: 200 * tau });
    assert.ok(r, 'relay produced a limit cycle');
    const eKu = Math.abs(r.Ku - KuExact) / KuExact, eTu = Math.abs(r.Tu - TuExact) / TuExact;
    assert.ok(eKu < 0.05, `Ku ${r.Ku} vs ${KuExact} (${(eKu * 100).toFixed(2)} %)`);
    assert.ok(eTu < 0.05, `Tu ${r.Tu} vs ${TuExact} (${(eTu * 100).toFixed(2)} %)`);
    // describing-function estimate is in the same ballpark
    assert.ok(Math.abs(r.KuDF - KuExact) / KuExact < 0.05);
  }
});

test('relay autotune on the heater (FOPDT) matches the analytic ultimate point; Fourier beats the DF', () => {
  // G = K e^{-Ls} / (tau s + 1): phase -180 deg where L*w + atan(tau*w) = pi, Ku = sqrt(1 + (tau w)^2) / K
  const { K, tau, L } = PLANTS.heater.params;
  let lo = 1e-3, hi = 1;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (L * m + Math.atan(tau * m) > Math.PI) hi = m; else lo = m; }
  const w = lo, KuExact = Math.hypot(1, tau * w) / K, TuExact = (2 * Math.PI) / w;
  const r = relayAutotune('heater');
  assert.ok(Math.abs(r.Ku - KuExact) / KuExact < 0.05, `Ku ${r.Ku} vs ${KuExact}`);
  assert.ok(Math.abs(r.Tu - TuExact) / TuExact < 0.05, `Tu ${r.Tu} vs ${TuExact}`);
  // The triangular limit cycle of a dead-time plant is far from a sine: the peak-based
  // describing-function estimate is >10 % low, the first-harmonic estimate isn't.
  assert.ok((KuExact - r.KuDF) / KuExact > 0.1);
});

test('relay autotune works with a bias (drone needs hover thrust) and on every plant', () => {
  for (const id of PLANT_IDS) {
    const r = relayAutotune(id);
    assert.ok(r && Number.isFinite(r.Ku) && r.Ku > 0 && r.Tu > 0, id);
  }
  const d = relayAutotune('drone');
  assert.ok(Math.abs(d.yMean - 5) < 0.3, `oscillates around the setpoint, mean ${d.yMean}`);
  assert.ok(Math.abs(d.bias - 9.81) < 0.5, `bias ${d.bias}`);
});

test('tuning rules: Ziegler-Nichols PID = 0.6 Ku, Tu/2, Tu/8', () => {
  const g = gainsFromRule(10, 2, 'zn-pid');
  assert.ok(Math.abs(g.Kp - 6) < 1e-12 && Math.abs(g.Ki - 6) < 1e-12 && Math.abs(g.Kd - 1.5) < 1e-12);
  const tl = gainsFromRule(2.2, 1, 'tl-pid');
  assert.ok(Math.abs(tl.Kp - 1) < 1e-12 && Math.abs(tl.Ki - 1 / 2.2) < 1e-12 && Math.abs(tl.Kd - 1 / 6.3) < 1e-12);
  assert.equal(Object.keys(TUNING_RULES).length, 6);
});

test('Nelder-Mead minimises the Rosenbrock function', () => {
  const rosen = ([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;
  const r = nelderMead(rosen, [-1.2, 1], { maxEvals: 2000, tol: 1e-14, step: 0.5 });
  assert.ok(Math.abs(r.x[0] - 1) < 1e-3 && Math.abs(r.x[1] - 1) < 1e-3, JSON.stringify(r));
});

test('optimiser lowers the cost from a poor starting point', () => {
  const start = { Kp: 2, Ki: 0.5, Kd: 2 };
  const J0 = tuningCost(PLANTS.drone, start).J;
  const r = optimiseGains('drone', start, { maxEvals: 80 });
  assert.ok(r.J < 0.6 * J0, `J ${r.J} vs start ${J0}`);
  assert.ok(r.m.overshoot < 10 && Number.isFinite(r.m.settle));
});
