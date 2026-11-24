/**
 * Print the README metrics tables (noise-free standard step for every plant with its
 * default gains, and P vs PI vs PID presets on the drone).
 *   node scripts/metrics-table.mjs
 */
import { PLANTS, PLANT_IDS } from '../src/plants.js';
import { stepResponse } from '../src/sim.js';
import { stepMetrics, fmtMetric } from '../src/metrics.js';

const row = (cells) => `| ${cells.join(' | ')} |`;
const metricsFor = (id, gains) => {
  const def = PLANTS[id];
  return stepMetrics(stepResponse(id, gains), { yKey: 'yTrue', y0: def.step[0] });
};

console.log(row(['Plant', 'Step', 'Kp / Ki / Kd', 'Rise', 'Overshoot', 'Settling (2 %)', 'SSE', 'ITAE', 'Sat. time']));
console.log(row(Array(9).fill('---')));
for (const id of PLANT_IDS) {
  const def = PLANTS[id];
  const g = def.defaultGains;
  const m = metricsFor(id, {});
  const u = def.units;
  console.log(row([def.name, `${def.step[0]} → ${def.step[1]} ${u.y}`, `${g.Kp} / ${g.Ki} / ${g.Kd}`,
    `${fmtMetric(m.rise)} s`, `${fmtMetric(m.overshoot, 2)} %`, `${fmtMetric(m.settle)} s`,
    `${fmtMetric(m.sse, 2)} ${u.y}`, fmtMetric(m.itae), `${fmtMetric(m.satPct, 2)} %`]));
}
const cmp = process.argv[2] ?? 'drone';
console.log(`\nP vs PI vs PID on ${PLANTS[cmp].name}:\n`);
console.log(row(['Controller', 'Kp / Ki / Kd', 'Rise', 'Overshoot', 'Settling (2 %)', 'SSE', 'ITAE']));
console.log(row(Array(7).fill('---')));
for (const [name, g] of Object.entries(PLANTS[cmp].presets)) {
  const m = metricsFor(cmp, g);
  console.log(row([name, `${g.Kp} / ${g.Ki} / ${g.Kd}`, `${fmtMetric(m.rise)} s`, `${fmtMetric(m.overshoot, 2)} %`,
    `${fmtMetric(m.settle)} s`, `${fmtMetric(m.sse, 2)} ${PLANTS[cmp].units.y}`, fmtMetric(m.itae)]));
}
