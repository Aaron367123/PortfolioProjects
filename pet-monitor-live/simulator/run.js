#!/usr/bin/env node
/**
 * Device simulator: `npm run simulate -- [options]`
 *
 *   --url <base>       server base URL            (default http://127.0.0.1:5602, env SERVER_URL)
 *   --key <key>        X-Device-Key               (default env DEVICE_KEY or dev-device-key)
 *   --devices <n>      number of simulated bowls  (default 1; ids sim-1, sim-2, ...)
 *   --speed <x>        model seconds per real second (default 1). 60 = an hour per minute.
 *   --seed <n>         PRNG seed for repeatable runs (default: random)
 *   --start <h|now>    model clock start, hours ago (default: now at 1x, 24 h ago when sped up)
 *   --duration <s>     stop after s real seconds  (default: run until Ctrl+C)
 *   --no-faults        disable injected sensor faults
 *   --dropout          occasionally stop posting for 15 s (triggers "device offline")
 *
 * One reading per model second is always generated, so at --speed 60 the server receives
 * 60 readings per real second (sent as small batches). When sped up, the model clock starts
 * in the past and drops to 1x once it catches up with the wall clock, so no reading is
 * ever timestamped in the future.
 */
import { parseArgs } from 'node:util';
import { PetSimulator } from '../shared/simulator.js';
import { defaultConfig } from '../shared/config.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.SERVER_URL ?? 'http://127.0.0.1:5602' },
    key: { type: 'string', default: process.env.DEVICE_KEY ?? 'dev-device-key' },
    devices: { type: 'string', default: '1' },
    speed: { type: 'string', default: '1' },
    seed: { type: 'string' },
    start: { type: 'string' },
    duration: { type: 'string' },
    'no-faults': { type: 'boolean', default: false },
    dropout: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

const speed = Number(args.speed);
const deviceCount = Number(args.devices);
if (!(speed > 0 && speed <= 1000)) throw new Error('--speed must be between 0 and 1000');
if (!(Number.isInteger(deviceCount) && deviceCount >= 1 && deviceCount <= 20)) throw new Error('--devices must be 1-20');
const seed = args.seed != null ? Number(args.seed) : Math.floor(Math.random() * 2 ** 31);
const startHoursAgo = args.start == null ? (speed > 1 ? 24 : 0) : args.start === 'now' ? 0 : Number(args.start);
const endpoint = new URL('api/readings', args.url.endsWith('/') ? args.url : `${args.url}/`).href;

// Calibration should match the server's so simulated raw values convert back to sane units.
let calibration = defaultConfig().calibration;
try {
  const res = await fetch(new URL('api/config', endpoint));
  if (res.ok) calibration = (await res.json()).calibration;
} catch {
  console.warn(`server not reachable yet at ${args.url} - using default calibration`);
}

const startTs = Date.now() - startHoursAgo * 3_600_000;
const devices = Array.from({ length: deviceCount }, (_, i) => ({
  sim: new PetSimulator({ deviceId: `sim-${i + 1}`, seed: seed + i * 7919, startTs, calibration, faults: !args['no-faults'] }),
  queue: [],
  inFlight: false,
  sent: 0,
  failed: 0,
}));

console.log(`Simulating ${deviceCount} device(s) -> ${endpoint}`);
console.log(`  speed ${speed}x, seed ${seed}, model clock starts ${startHoursAgo} h ago${args.dropout ? ', with dropouts' : ''}`);

const TICK_MS = 100;
const realStart = Date.now();
let produced = 0; // model seconds generated so far
let pausedUntil = 0;
let nextDropout = Date.now() + 60_000 + Math.random() * 120_000;

async function flush(dev) {
  if (dev.inFlight || dev.queue.length === 0) return;
  dev.inFlight = true;
  const batch = dev.queue.splice(0, 500);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': args.key },
      body: JSON.stringify(batch),
    });
    if (res.ok) dev.sent += batch.length;
    else {
      dev.failed += batch.length;
      console.error(`POST ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    dev.failed += batch.length; // simulator does not buffer: a real device would (see device/pi_client.py)
    if (dev.failed === batch.length || dev.failed % 600 < batch.length) console.error(`POST failed: ${err.cause?.code ?? err.message}`);
  } finally {
    dev.inFlight = false;
  }
}

const timer = setInterval(() => {
  const now = Date.now();
  if (args.dropout && now >= nextDropout) {
    pausedUntil = now + 15_000;
    nextDropout = now + 120_000 + Math.random() * 120_000;
    if (!args.quiet) console.log('[dropout] simulating Wi-Fi loss for 15 s');
  }
  // How many model seconds should exist by now? Capped so the model never passes the wall clock.
  const target = Math.floor(((now - realStart) / 1000) * speed);
  const maxByClock = Math.floor((now - startTs) / 1000);
  const due = Math.min(target, maxByClock, produced + 2000) - produced;
  for (let i = 0; i < due; i++) {
    for (const dev of devices) {
      const reading = dev.sim.step(1);
      if (now >= pausedUntil) dev.queue.push(reading);
    }
  }
  produced += Math.max(0, due);
  for (const dev of devices) flush(dev);
}, TICK_MS);

const stats = setInterval(() => {
  if (args.quiet) return;
  const d = devices[0];
  const last = new Date(d.sim.t).toLocaleTimeString();
  console.log(`model time ${last} | sent ${devices.reduce((s, x) => s + x.sent, 0)} | failed ${devices.reduce((s, x) => s + x.failed, 0)}`);
}, 5000);

function stop() {
  clearInterval(timer);
  clearInterval(stats);
  Promise.all(devices.map(flush)).finally(() => process.exit(0));
}
if (args.duration) setTimeout(stop, Number(args.duration) * 1000);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
