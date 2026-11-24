/**
 * golden.js - scripted scenarios that produce the JS <-> C parity "golden" files.
 *
 * Each scenario runs a real closed loop in JS (plant + noise + PID), with gain changes
 * and resets at scripted samples. The CSV records, per sample, the controller inputs
 * (sp, y), the gains in force, a reset flag, and the JS controller outputs (u, P, I, D).
 * firmware/tests/test_pid.c replays the inputs through the C controller and checks every
 * output matches within 1e-4.
 *
 * CSV layout (plain text, parsed with fgets/sscanf in C):
 *   # <name>: <description>
 *   kp,ki,kd,ts,tf,b,c,umin,umax,aw,tt          <- config header
 *   <values>                                    aw: 0 none, 1 clamp, 2 backcalc; tt 0 = auto
 *   k,sp,y,kp,ki,kd,reset,u,p,i,d               <- data header
 *   <one row per sample>
 */
import { ClosedLoop } from '../src/sim.js';
import { filterTimeConstant } from '../src/pid.js';

const AW_CODE = { none: 0, clamp: 1, backcalc: 2 };
const f = (x) => (Number.isInteger(x) ? String(x) : Number(x.toPrecision(9)).toString());

export const SCENARIOS = [
  {
    name: 'drone_clamp',
    description: 'drone altitude, clamping anti-windup, noisy sensor, gain change at k=350',
    loop: {
      plant: 'drone', pid: { Kp: 8, Ki: 3, Kd: 5, N: 20, antiWindup: 'clamp' },
      setpoint: [{ t: 0, value: 5 }, { t: 3, value: 2 }],
      disturbance: [{ t: 0, value: 0 }, { t: 4.5, value: -4 }],
      noise: { std: 0.02, seed: 3 },
    },
    n: 600,
    gainChanges: { 350: { Kp: 6, Ki: 2, Kd: 4 } },
    resets: [],
  },
  {
    name: 'motor_backcalc',
    description: 'motor speed, back-calculation anti-windup, b=0.7, saturating steps, reset at k=250',
    loop: {
      plant: 'motor-speed', pid: { Kp: 0.12, Ki: 0.9, Kd: 0.0005, N: 100, b: 0.7, antiWindup: 'backcalc' },
      setpoint: [{ t: 0, value: 200 }, { t: 0.8, value: -150 }],
      disturbance: [{ t: 0, value: 0 }, { t: 0.5, value: 0.05 }],
      noise: { std: 1, seed: 11 },
    },
    n: 400,
    gainChanges: { 120: { Kp: 0.2, Ki: 1.5, Kd: 0.001 } },
    resets: [250],
  },
  {
    name: 'heater_none',
    description: 'heater, no anti-windup, derivative on error (kick), quantised sensor',
    loop: {
      plant: 'heater',
      pid: { Kp: 5, Ki: 0.2, Kd: 5, N: 0.5, antiWindup: 'none', derivativeOnMeasurement: false },
      setpoint: [{ t: 0, value: 50 }, { t: 90, value: 40 }],
      noise: { std: 0.1, seed: 5 }, quant: 0.0625,
    },
    n: 300,
    gainChanges: { 200: { Kp: 3, Ki: 0.1, Kd: 8 } },
    resets: [],
  },
];

/** Run one scenario and return its CSV text. */
export function scenarioCSV(sc) {
  const loop = new ClosedLoop(sc.loop);
  const pid = loop.pid;
  const lines = [];
  lines.push(`# ${sc.name}: ${sc.description}`);
  lines.push('kp,ki,kd,ts,tf,b,c,umin,umax,aw,tt');
  lines.push([pid.Kp, pid.Ki, pid.Kd, pid.Ts, filterTimeConstant({ tf: pid.tfOverride, N: pid.N }),
    pid.b, pid.c, pid.uMin, pid.uMax, AW_CODE[pid.antiWindup], 0].map(f).join(','));
  lines.push('k,sp,y,kp,ki,kd,reset,u,p,i,d');
  let last = null;
  for (let k = 0; k < sc.n; k++) {
    const g = sc.gainChanges[k];
    if (g && last) pid.setGains(g, last.sp, last.y);   // bumpless, at the latest (r, y)
    const reset = sc.resets.includes(k) ? 1 : 0;
    if (reset) pid.reset();
    const s = loop.tick();
    const { P, I, D, u } = pid.last;
    lines.push([k, s.sp, s.y, pid.Kp, pid.Ki, pid.Kd, reset, u, P, I, D].map(f).join(','));
    last = s;
  }
  return lines.join('\n') + '\n';
}
