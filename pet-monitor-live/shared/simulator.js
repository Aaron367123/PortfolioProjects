/**
 * PetSimulator - a physical model of the bowl station that emits the same raw values the
 * Pi sends (temperatureC, weightRaw, phVoltage, faces). Used by `npm run simulate` and by
 * the browser demo.
 *
 * Model:
 *   temperature  day cycle (min ~03:00, max ~15:00) + slow random drift + sensor noise,
 *                plus occasional hot/cold episodes (sun on the window, heating off).
 *   water pH     fresh water ~7.3 drifting down as it ages (CO2 absorption, food bits);
 *                the owner refills every 10-20 h. Converted to probe voltage with the
 *                inverse of the pH calibration.
 *   bowl weight  food mass -> raw via the inverse weight calibration + ADC noise; the pet
 *                pressing on the bowl adds a jittery offset; eating removes food;
 *                the owner tops the bowl up when it runs low.
 *   presence     faces = 1 during a visit with ~8% dropouts, rare false positives.
 *   faults       stuck pH channel, temperature spikes, saturated FSR, DHT read failures.
 *
 * Deterministic for a given seed (mulberry32 PRNG), so tests and demos are repeatable.
 */
import { defaultConfig } from './config.js';
import { gramsToRaw, phToVoltage } from './calibration.js';

/** mulberry32: tiny, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const HOUR = 3_600_000;

export class PetSimulator {
  /**
   * @param {object} o
   * @param {string} [o.deviceId]
   * @param {number} [o.seed]
   * @param {number} [o.startTs]   model clock start (ms)
   * @param {object} [o.calibration] the calibration the *server* uses, so values round-trip
   * @param {boolean} [o.faults]   inject sensor faults
   * @param {boolean} [o.script]   schedule interesting events early (demos, screenshots)
   */
  constructor({ deviceId = 'sim-1', seed = 1, startTs = Date.now(), calibration = defaultConfig().calibration, faults = true, script = true } = {}) {
    this.deviceId = deviceId;
    this.rand = mulberry32(seed);
    this.t = startTs;
    this.cal = calibration;
    this.faultsEnabled = faults;

    this.tempDrift = 0; // Ornstein-Uhlenbeck drift around the day cycle (°C)
    this.episode = null; // {start, end, peak} temporary hot/cold excursion
    this.forceHot = false;
    this.waterAgeH = script ? 12.3 : this.uniform(0, 10);
    this.nextRefillAgeH = script ? 14.5 : this.uniform(10, 20);
    this.food = script ? 240 : this.uniform(120, 300);
    this.foodRefillAt = null;
    this.visit = null; // {kind, end, push, eatRate}
    this.fault = null; // {type, end, value}
    this.lastPh = null;

    this.nextVisit = this.t + (script ? 2 * MIN : this.expo(40 * MIN));
    this.nextEpisode = this.t + (script ? 6 * MIN : this.expo(5 * HOUR));
    this.nextFault = this.t + (script ? 25 * MIN : this.expo(3 * HOUR));
  }

  /** The owner refills the water bowl now; the next refill happens at `nextRefillAgeH`. */
  refillWater(nextRefillAgeH = this.uniform(10, 20)) {
    this.waterAgeH = 0;
    this.nextRefillAgeH = nextRefillAgeH;
  }

  /**
   * Schedules a visit, a heat episode and a sensor fault within the next few model minutes -
   * used by the browser demo so a visitor sees the interesting paths quickly instead of
   * waiting for random events.
   */
  queueHighlights() {
    this.nextVisit = this.t + 50_000;
    this.nextEpisode = this.t + 4 * MIN;
    this.forceHot = true;
    this.nextFault = this.t + 7 * MIN;
  }

  uniform(a, b) {
    return a + (b - a) * this.rand();
  }

  gauss() {
    let u = 0;
    while (u === 0) u = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  expo(mean) {
    return -Math.log(1 - this.rand()) * mean;
  }

  hourOfDay() {
    const d = new Date(this.t);
    return d.getHours() + d.getMinutes() / 60;
  }

  /** Advance the model by dtS seconds and return one raw reading. */
  step(dtS = 1) {
    this.t += Math.round(dtS * 1000);
    const dtMs = dtS * 1000;
    return {
      deviceId: this.deviceId,
      ts: this.t,
      temperatureC: this.#temperature(dtS),
      phVoltage: this.#phVoltage(dtS),
      ...this.#bowl(dtS, dtMs),
    };
  }

  #temperature(dtS) {
    const hour = this.hourOfDay();
    const dayCycle = 21.5 + 2.5 * Math.sin((2 * Math.PI * (hour - 9)) / 24);
    // OU process: mean-reverting random walk (time constant 30 min).
    this.tempDrift += (-this.tempDrift * dtS) / 1800 + 0.03 * Math.sqrt(dtS) * this.gauss();

    if (!this.episode && this.t >= this.nextEpisode) {
      const hot = this.forceHot || this.rand() < 0.7;
      this.forceHot = false;
      const dur = this.uniform(25, 50) * MIN;
      this.episode = { start: this.t, end: this.t + dur, peak: hot ? this.uniform(10, 12.5) : -this.uniform(8.5, 10) };
    }
    let excursion = 0;
    if (this.episode) {
      const { start, end, peak } = this.episode;
      excursion = peak * Math.sin((Math.PI * (this.t - start)) / (end - start)) ** 2; // smooth bump
      if (this.t >= end) {
        this.episode = null;
        this.nextEpisode = this.t + Math.max(90 * MIN, this.expo(6 * HOUR));
      }
    }

    let v = Math.round((dayCycle + this.tempDrift + excursion + 0.08 * this.gauss()) * 10) / 10;
    if (this.fault?.type === 'spike_temp') v = this.fault.value;
    if (this.fault?.type === 'dht_dead') return null;
    if (this.rand() < 0.004) return null; // ordinary DHT22 checksum failure
    return v;
  }

  #phVoltage(dtS) {
    this.waterAgeH += dtS / 3600;
    if (this.waterAgeH >= this.nextRefillAgeH) this.refillWater(); // owner refills the water
    const ph = 7.3 - 0.062 * this.waterAgeH + 0.006 * this.gauss();
    const v = Math.round((phToVoltage(ph, this.cal.ph) + 0.0008 * this.gauss()) * 10000) / 10000;
    if (this.fault?.type === 'stuck_ph') return this.fault.value;
    this.lastPh = v;
    return v;
  }

  #bowl(dtS, dtMs) {
    this.#schedule(dtMs);
    let push = 0;
    let faces = 0;
    if (this.visit) {
      if (this.visit.kind === 'eating') this.food = Math.max(0, this.food - this.visit.eatRate * dtS);
      push = this.visit.push * (0.75 + 0.5 * this.rand()); // head/paws on the bowl
      faces = this.rand() < 0.08 ? 0 : 1; // the face sensor misses some frames
    } else if (this.rand() < 0.003) {
      faces = 1; // rare false positive
    }
    let weightRaw = Math.round(gramsToRaw(this.food, this.cal.weight) + push + 12 * this.gauss());
    weightRaw = Math.max(-32768, Math.min(32767, weightRaw));
    if (this.fault?.type === 'saturated') weightRaw = 32767;
    return { weightRaw, faces };
  }

  /** Visits, food refills and fault injection. */
  #schedule(dtMs) {
    const t = this.t;
    if (this.visit && t >= this.visit.end) {
      this.visit = null;
      const h = this.hourOfDay();
      const daytime = h >= 7 && h < 22;
      this.nextVisit = t + Math.max(12 * MIN, this.expo(daytime ? 70 * MIN : 3.5 * HOUR));
    }
    if (!this.visit && t >= this.nextVisit) {
      const eating = this.food > 15 && this.rand() < 0.6;
      this.visit = {
        kind: eating ? 'eating' : 'drinking',
        end: t + (eating ? this.uniform(150, 420) : this.uniform(40, 120)) * 1000,
        push: this.uniform(1500, 3500),
        eatRate: this.uniform(0.05, 0.11), // g/s - roughly 10-45 g per meal
      };
    }
    if (!this.visit && this.food < 60 && this.foodRefillAt == null) this.foodRefillAt = t + this.uniform(0.5, 3) * HOUR;
    if (!this.visit && this.foodRefillAt != null && t >= this.foodRefillAt) {
      this.food = this.uniform(280, 320);
      this.foodRefillAt = null;
    }

    if (this.fault && t >= this.fault.end) this.fault = null;
    if (this.faultsEnabled && !this.fault && t >= this.nextFault) {
      const r = this.rand();
      if (r < 0.4) this.fault = { type: 'stuck_ph', end: t + this.uniform(240, 480) * 1000, value: this.lastPh ?? 2.5 };
      else if (r < 0.7) this.fault = { type: 'spike_temp', end: t + dtMs, value: Math.round(this.uniform(58, 75) * 10) / 10 };
      else if (r < 0.85) this.fault = { type: 'saturated', end: t + this.uniform(5, 20) * 1000 };
      else this.fault = { type: 'dht_dead', end: t + this.uniform(30, 90) * 1000 };
      this.nextFault = t + Math.max(30 * MIN, this.expo(3 * HOUR));
    }
  }
}
