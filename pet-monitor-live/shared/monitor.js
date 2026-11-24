/**
 * Monitor - the processing pipeline, independent of transport and storage.
 *
 *   validated reading -> calibration -> fault detection -> session state machine
 *                     -> alert rules -> outgoing messages {type, data}
 *
 * The server feeds it from POST /api/readings and fans the messages out over WebSocket;
 * the static demo feeds it from the in-browser simulator. Same code, same messages.
 *
 * Time: readings carry their own timestamp (event time) and everything derived from
 * readings (visits, durations, no-visit, cooldowns) uses it. Only "device offline" uses
 * the wall clock, because it is about when data *arrived*.
 */
import { defaultConfig } from './config.js';
import { calibrateReading } from './calibration.js';
import { SessionTracker } from './sessions.js';
import { AlertTracker, SEVERITY, thresholdRules } from './alerts.js';
import { FaultDetector, FAULT_METRICS, METRIC_LABELS, faultMessage } from './faults.js';
import { RingBuffer } from './ringbuffer.js';
import { dayKey, makeId } from './util.js';

const MAX_DAYS = 14;

class DeviceState {
  constructor(deviceId, ringSize) {
    this.deviceId = deviceId;
    this.ring = new RingBuffer(ringSize);
    this.online = false;
    this.lastReceivedAt = null; // wall clock (ms)
    this.lastTs = null; // event time of the latest live reading
    this.firstTs = null;
    this.lastVisitTs = null;
    this.resetTimeState();
    this.trackers = new Map(); // alert key -> AlertTracker
    this.activeAlerts = new Map(); // alert key -> alert id
    this.daily = new Map(); // dayKey -> totals
  }

  /** Called on first contact and when a device's clock jumps backwards. */
  resetTimeState() {
    this.session = new SessionTracker();
    this.faults = new FaultDetector();
  }

  tracker(key) {
    let t = this.trackers.get(key);
    if (!t) this.trackers.set(key, (t = new AlertTracker()));
    return t;
  }
}

export class Monitor {
  constructor({ config = defaultConfig(), ringSize = 3600, maxAlerts = 200, maxEvents = 300 } = {}) {
    this.config = config;
    this.ringSize = ringSize;
    this.maxAlerts = maxAlerts;
    this.maxEvents = maxEvents;
    this.devices = new Map();
    this.alerts = new Map(); // id -> alert record, insertion ordered (oldest first)
    this.events = []; // recent visit events, oldest first
  }

  device(deviceId) {
    let d = this.devices.get(deviceId);
    if (!d) this.devices.set(deviceId, (d = new DeviceState(deviceId, this.ringSize)));
    return d;
  }

  get #trackerOpts() {
    const a = this.config.alerts;
    return { confirm: a.confirmReadings, cooldownMs: a.cooldownMinutes * 60_000 };
  }

  /**
   * Process one validated reading.
   * @returns {{reading:object, live:boolean, messages:{type,data}[]}}
   *   reading is the enriched record to persist; messages are to be broadcast.
   */
  ingest(input, { receivedAt = Date.now() } = {}) {
    const dev = this.device(input.deviceId);
    const messages = [];
    dev.lastReceivedAt = receivedAt;
    if (!dev.online) {
      dev.online = true;
      messages.push({ type: 'status', data: this.deviceStatus(dev) });
    }
    messages.push(...this.#evaluate(dev, 'device_offline', receivedAt, false, true));

    const calibrated = calibrateReading(input, this.config.calibration);
    const reading = {
      deviceId: input.deviceId,
      ts: input.ts,
      receivedAt,
      temperatureRaw: input.temperatureC,
      weightRaw: input.weightRaw,
      phVoltage: input.phVoltage,
      faces: input.faces,
      temperatureC: input.temperatureC,
      weightG: calibrated.weightG,
      pH: calibrated.pH,
      presence: input.faces == null ? null : input.faces > 0,
      faults: [],
      replay: input.replay === true,
    };

    // Replayed readings (from the Pi's offline buffer) are history only: they must not
    // drive the live state machine with stale timestamps.
    if (reading.replay) return { reading, live: false, messages };

    if (dev.lastTs != null && reading.ts < dev.lastTs) {
      // Device clock jumped backwards (reboot without NTP, new simulator run): re-anchor.
      dev.resetTimeState();
      dev.firstTs = null;
      dev.lastVisitTs = null;
    }
    if (dev.firstTs == null) dev.firstTs = reading.ts;
    dev.lastTs = reading.ts;

    // 1. Fault detection: untrusted samples are blanked so they cannot trigger alerts.
    const { bad, changes } = dev.faults.update(input, calibrated, this.config.alerts.fault);
    if (bad.has('temperatureC')) reading.temperatureC = null;
    if (bad.has('weightRaw')) reading.weightG = null;
    if (bad.has('phVoltage')) reading.pH = null;
    reading.faults = FAULT_METRICS.filter((m) => dev.faults.isActive(m));

    dev.ring.push(reading);
    messages.push({ type: 'reading', data: reading });

    // 2. Visit sessions.
    for (const ev of dev.session.update(reading, this.config.session)) messages.push(this.#visitEvent(dev, ev));

    // 3. Alerts.
    const ts = reading.ts;
    for (const rule of thresholdRules(this.config)) {
      const v = reading[rule.metric];
      if (v == null) continue; // no trustworthy sample: no evidence either way
      messages.push(...this.#evaluate(dev, rule.key, ts, rule.trigger(v), rule.clear(v), () => ({
        rule: rule.rule,
        severity: rule.severity,
        message: rule.message(v),
        value: v,
        threshold: rule.threshold,
      })));
    }

    const change = new Map(changes.map((c) => [c.metric, c]));
    for (const metric of FAULT_METRICS) {
      const active = dev.faults.isActive(metric);
      const info = change.get(metric) ?? { reason: dev.faults.state[metric].reason, value: input[metric] };
      messages.push(...this.#evaluate(dev, `sensor_fault:${metric}`, ts, active, !active, () => ({
        rule: 'sensor_fault',
        severity: SEVERITY.warning,
        message: faultMessage(metric, info.reason, info.value),
        value: info.value,
        metric,
        reason: info.reason,
      }), { confirm: 1 })); // detection is already debounced by the FaultDetector
    }

    const anchor = dev.session.visiting ? ts : (dev.lastVisitTs ?? dev.firstTs);
    const idleH = (ts - anchor) / 3.6e6;
    const limitH = this.config.alerts.noVisitHours;
    messages.push(...this.#evaluate(dev, 'no_visit', ts, idleH > limitH, idleH <= limitH, () => ({
      rule: 'no_visit',
      severity: SEVERITY.info,
      message: `No visit to the bowl for ${limitH} h`,
      value: Math.round(idleH * 10) / 10,
      threshold: limitH,
    }), { confirm: 1 }));

    return { reading, live: true, messages };
  }

  /** Wall-clock checks (device offline). Call about once per second. */
  tick(now = Date.now()) {
    const messages = [];
    const limitMs = this.config.alerts.offlineSeconds * 1000;
    for (const dev of this.devices.values()) {
      if (dev.lastReceivedAt == null) continue;
      const silentMs = now - dev.lastReceivedAt;
      const offline = silentMs > limitMs;
      if (offline && dev.online) {
        dev.online = false;
        messages.push({ type: 'status', data: this.deviceStatus(dev) });
      }
      messages.push(...this.#evaluate(dev, 'device_offline', now, offline, !offline, () => ({
        rule: 'device_offline',
        severity: SEVERITY.critical,
        message: `Device ${dev.deviceId} offline - no reading for ${Math.round(silentMs / 1000)} s`,
        value: Math.round(silentMs / 1000),
        threshold: this.config.alerts.offlineSeconds,
      }), { confirm: 1 }));
    }
    return messages;
  }

  /** Runs one AlertTracker and turns fire/resolve into alert messages. */
  #evaluate(dev, key, ts, triggered, cleared, describe, overrides = {}) {
    const result = dev.tracker(key).update(ts, triggered, cleared, { ...this.#trackerOpts, ...overrides });
    if (result === 'fire') {
      const alert = {
        id: makeId('al', ts),
        key,
        deviceId: dev.deviceId,
        status: 'active',
        ts,
        resolvedTs: null,
        acknowledged: false,
        ...describe(),
      };
      dev.activeAlerts.set(key, alert.id);
      this.alerts.set(alert.id, alert);
      if (this.alerts.size > this.maxAlerts) this.alerts.delete(this.alerts.keys().next().value);
      return [{ type: 'alert', data: { ...alert } }]; // copy: the record is mutated on resolve
    }
    if (result === 'resolve') {
      const id = dev.activeAlerts.get(key);
      dev.activeAlerts.delete(key);
      const alert = this.alerts.get(id);
      if (!alert) return [];
      alert.status = 'resolved';
      alert.resolvedTs = ts;
      return [{ type: 'alert', data: { ...alert } }];
    }
    return [];
  }

  #visitEvent(dev, ev) {
    const event = { id: makeId('ev', ev.ts), deviceId: dev.deviceId, ...ev };
    if (ev.type === 'visit_start') {
      dev.lastVisitTs = ev.ts;
    } else {
      dev.lastVisitTs = ev.endTs;
      const day = this.#day(dev, dayKey(ev.startTs));
      day.visits++;
      day[ev.kind === 'eating' ? 'eatingS' : 'drinkingS'] += ev.durationS;
      day.foodEatenG = Math.round((day.foodEatenG + (ev.foodEatenG ?? 0)) * 10) / 10;
      event.daily = { ...day };
    }
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return { type: 'event', data: event };
  }

  #day(dev, key) {
    let d = dev.daily.get(key);
    if (!d) {
      dev.daily.set(key, (d = { date: key, visits: 0, eatingS: 0, drinkingS: 0, foodEatenG: 0 }));
      if (dev.daily.size > MAX_DAYS) dev.daily.delete(dev.daily.keys().next().value);
    }
    return d;
  }

  /** Replace the configuration (already validated by applyConfigPatch). */
  setConfig(config) {
    this.config = config;
    return { type: 'config', data: config };
  }

  acknowledge(alertId) {
    const alert = this.alerts.get(alertId);
    if (!alert) return null;
    alert.acknowledged = true;
    return { type: 'alert', data: { ...alert } };
  }

  /** Seed the visit timeline (e.g. from the database after a restart). */
  restoreEvents(events) {
    this.events = events.slice(-this.maxEvents);
    for (const ev of this.events) {
      const dev = this.device(ev.deviceId);
      if (ev.type === 'visit_end') dev.lastVisitTs = Math.max(dev.lastVisitTs ?? 0, ev.endTs);
      if (ev.daily) dev.daily.set(ev.daily.date, { ...ev.daily });
    }
  }

  deviceStatus(dev) {
    const today = dev.lastTs != null ? dev.daily.get(dayKey(dev.lastTs)) : null;
    return {
      deviceId: dev.deviceId,
      online: dev.online,
      lastReceivedAt: dev.lastReceivedAt,
      lastTs: dev.lastTs,
      lastReading: dev.ring.latest() ?? null,
      session: dev.session.visiting ? { visiting: true, startTs: dev.session.current.startTs } : { visiting: false },
      lastVisitTs: dev.lastVisitTs,
      today: today ? { ...today } : null,
      faults: dev.ring.latest()?.faults ?? [],
    };
  }

  /** Everything a freshly connected dashboard needs. */
  snapshot({ readings = 600 } = {}) {
    return {
      serverTime: Date.now(),
      config: this.config,
      metricLabels: METRIC_LABELS,
      devices: [...this.devices.values()].map((d) => ({ ...this.deviceStatus(d), readings: d.ring.last(readings) })),
      alerts: [...this.alerts.values()].slice(-100).reverse(),
      events: this.events.slice(-200),
    };
  }
}
