/**
 * DemoSource - runs the whole backend pipeline in the browser for the static portfolio demo.
 *
 * It imports the *same* shared modules the server uses (simulator, validation, Monitor with
 * calibration / sessions / alerts) and emits the same {type, data} messages the WebSocket
 * would, so the UI cannot tell the difference. History comes from an in-memory ring buffer
 * (short windows) plus 1-minute rollups (long windows) instead of SQLite.
 */
import { PetSimulator } from '../shared/simulator.js';
import { validateReading } from '../shared/validation.js';
import { Monitor } from '../shared/monitor.js';
import { applyConfigPatch, defaultConfig } from '../shared/config.js';
import { RingBuffer } from '../shared/ringbuffer.js';
import { RollupStore, bucketize } from '../shared/history.js';

const TICK_MS = 100;
const DEVICE_ID = 'demo-pi';

export class DemoSource {
  constructor({ speed = 10, seed = 20240611, prefillHours = 24 } = {}) {
    this.kind = 'demo';
    this.speed = speed;
    this.seed = seed;
    this.prefillHours = prefillHours;
    this.raw = new RingBuffer(6000); // recent raw readings for 1 min / 10 min / 1 h windows
    this.rollups = new RollupStore({ resolutionMs: 60_000, maxBuckets: 2000 });
  }

  connect({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    const config = defaultConfig();
    this.monitor = new Monitor({ config, ringSize: 3600 });
    const now = Date.now();
    this.sim = new PetSimulator({ deviceId: DEVICE_ID, seed: this.seed, startTs: now - this.prefillHours * 3_600_000, calibration: config.calibration });

    // Prefill: the last day at 5 s resolution, the final 15 minutes at 1 s, so every chart
    // window has data immediately. Messages are not emitted; the snapshot carries the result.
    // The water was last refilled 12.85 h ago, so its pH (~6.5) is about to cross the safe
    // minimum shortly after the page opens.
    const refillAt = now - 12.85 * 3_600_000;
    let refilled = false;
    while (this.sim.t < now - 15 * 60_000) {
      if (!refilled && this.sim.t >= refillAt) {
        this.sim.refillWater(13.6);
        refilled = true;
      }
      this.#ingest(this.sim.step(5), now);
    }
    while (this.sim.t < now) this.#ingest(this.sim.step(1), now);
    this.sim.queueHighlights();

    onStatus({ state: 'demo', speed: this.speed });
    onMessage({ type: 'snapshot', data: this.monitor.snapshot() });

    this.lastTick = performance.now();
    this.carry = 0;
    // Simulated Wi-Fi drop every ~2.5 minutes so the "device offline" path is visible too.
    this.nextDropout = Date.now() + 75_000;
    this.pausedUntil = 0;
    this.timer = setInterval(() => this.#tick(), TICK_MS);
  }

  /** One reading through validation + Monitor, recorded for history. Returns messages. */
  #ingest(raw, receivedAt) {
    const v = validateReading(raw, { now: raw.ts });
    if (!v.ok) {
      console.warn('demo reading rejected', v.errors);
      return [];
    }
    const { reading, messages } = this.monitor.ingest(v.value, { receivedAt });
    this.raw.push(reading);
    this.rollups.add(reading);
    return messages;
  }

  #tick() {
    const nowPerf = performance.now();
    const wall = Date.now();
    // Model seconds owed since the last tick at the current speed (fractional carry).
    this.carry += ((nowPerf - this.lastTick) / 1000) * this.speed;
    this.lastTick = nowPerf;
    const steps = Math.min(Math.floor(this.carry), 600);
    this.carry -= Math.floor(this.carry);

    if (wall >= this.nextDropout) {
      this.pausedUntil = wall + 13_000;
      this.nextDropout = wall + 150_000;
    }
    const paused = wall < this.pausedUntil;
    for (let i = 0; i < steps; i++) {
      const raw = this.sim.step(1);
      if (paused) continue; // the reading never reaches the "server"
      for (const m of this.#ingest(raw, wall)) this.onMessage(m);
    }
    for (const m of this.monitor.tick(wall)) this.onMessage(m);
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  async getHistory({ metric, from, to, bucketMs }) {
    const oldestRaw = this.raw.at(0)?.ts ?? Infinity;
    const points = oldestRaw <= from
      ? bucketize(this.raw.toArray(), metric, from, to, bucketMs)
      : this.rollups.query(metric, from, to, bucketMs);
    const effective = oldestRaw <= from ? bucketMs : Math.max(60_000, bucketMs);
    return { metric, from, to, bucketMs: effective, points };
  }

  async putConfig(patch) {
    const r = applyConfigPatch(this.monitor.config, patch);
    if (!r.ok) return { ok: false, errors: r.errors };
    this.onMessage(this.monitor.setConfig(r.value));
    return { ok: true, config: r.value };
  }

  async acknowledge(alertId) {
    const msg = this.monitor.acknowledge(alertId);
    if (msg) this.onMessage(msg);
  }

  close() {
    clearInterval(this.timer);
  }
}
