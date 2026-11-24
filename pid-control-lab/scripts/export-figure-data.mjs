/**
 * Export simulation traces for the README figures (drawn by scripts/make_figures.py).
 *   node scripts/export-figure-data.mjs  ->  docs/figure-data.json
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLANTS } from '../src/plants.js';
import { stepResponse } from '../src/sim.js';
import { stepMetrics } from '../src/metrics.js';
import { relayAutotune } from '../src/tuning.js';

const pick = (s, keys, every = 1) => Object.fromEntries(keys.map((k) => [k, Array.from(s[k]).filter((_, i) => i % every === 0).map((v) => +v.toFixed(5))]));
const run = (plant, label, pid, every) => {
  const s = stepResponse(plant, pid);
  const m = stepMetrics(s, { yKey: 'yTrue', y0: PLANTS[plant].step[0] });
  return { label, pid, metrics: m, ...pick(s, ['t', 'sp', 'yTrue', 'u', 'I'], every) };
};

const heater = PLANTS.heater;
const windup = ['none', 'clamp', 'backcalc'].map((aw) =>
  run('heater', { none: 'No anti-windup', clamp: 'Clamping', backcalc: 'Back-calculation' }[aw], { antiWindup: aw }, 2));

const drone = PLANTS.drone;
const ppid = Object.entries(drone.presets).map(([k, g]) => run('drone', k, g, 2));

const relay = relayAutotune('drone');
const every = 2;
const relayTrace = {
  t: relay.trace.t.filter((_, i) => i % every === 0), y: relay.trace.y.filter((_, i) => i % every === 0),
  u: relay.trace.u.filter((_, i) => i % every === 0), Ku: relay.Ku, Tu: relay.Tu, a: relay.a, h: relay.h, bias: relay.bias,
  tStart: relay.tStart, tEnd: relay.tEnd,
};
const zn = run('drone', 'ZN PID from relay', relay.gains['zn-pid'], 2);
const tl = run('drone', 'Tyreus-Luyben PID', relay.gains['tl-pid'], 2);

const out = {
  windup: { plant: heater.name, units: heater.units, step: heater.step, uMin: heater.uMin, uMax: heater.uMax, gains: heater.defaultGains, runs: windup },
  ppid: { plant: drone.name, units: drone.units, step: drone.step, uMin: drone.uMin, uMax: drone.uMax, runs: ppid },
  relay: { plant: drone.name, units: drone.units, trace: relayTrace, after: [zn, tl] },
};
const path = fileURLToPath(new URL('../docs/figure-data.json', import.meta.url));
writeFileSync(path, JSON.stringify(out));
console.log('wrote', path);
for (const r of windup) console.log('windup', r.label, r.metrics.overshoot.toFixed(1), '%', r.metrics.settle.toFixed(1), 's');
for (const r of ppid) console.log('ppid', r.label, r.metrics.overshoot.toFixed(1), '%', r.metrics.sse.toFixed(3));
console.log('relay', relay.Ku.toFixed(3), relay.Tu.toFixed(3), 'ZN', zn.metrics.overshoot.toFixed(1), zn.metrics.settle.toFixed(2), 'TL', tl.metrics.overshoot.toFixed(1), tl.metrics.settle);
