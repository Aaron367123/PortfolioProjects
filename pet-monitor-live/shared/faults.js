/**
 * Sensor fault detection, per metric:
 *   - stuck:        ADC channel returns the identical value N times in a row. A live 16-bit
 *                   ADC always has a little noise, so a frozen value means a dead I2C read
 *                   or a disconnected probe. (Not applied to the DHT22: 0.1 °C resolution
 *                   and its 2 s read cache make repeated values normal.)
 *   - spike:        temperature deviates from the median of the last 5 samples by more
 *                   than maxTempJumpC. A median is robust to the spike itself, and a real
 *                   level change is accepted once it dominates the window.
 *   - out_of_range: FSR saturated at the ADC rail, pH probe voltage near 0 V / supply,
 *                   or a calibrated pH outside 0-14.
 *   - no_data:      the sensor returned null (failed read) N times in a row.
 * A fault clears after `clearReadings` healthy samples (hysteresis again).
 * Samples that are currently faulty are excluded from charts and threshold alerts.
 */
import { median, pushBounded } from './util.js';

export const FAULT_METRICS = ['temperatureC', 'weightRaw', 'phVoltage'];
export const METRIC_LABELS = {
  temperatureC: 'Temperature sensor (DHT22)',
  weightRaw: 'Bowl load sensor (FSR)',
  phVoltage: 'pH probe (PH-4502C)',
};
const ADC_MAX = 32767;
const ADC_MIN = -32768;
const PH_V_MIN = 0.1;
const PH_V_MAX = 4.5;

function freshState() {
  return { active: false, reason: null, healthy: 0, nullStreak: 0, sameCount: 0, lastValue: undefined };
}

export class FaultDetector {
  constructor() {
    this.state = Object.fromEntries(FAULT_METRICS.map((m) => [m, freshState()]));
    this.tempWindow = [];
  }

  isActive(metric) {
    return this.state[metric].active;
  }

  /** Why the current sample of `metric` is bad, or null. */
  #reason(metric, v, calibrated, cfg) {
    const s = this.state[metric];
    if (v == null) {
      s.nullStreak++;
      return s.nullStreak >= cfg.maxNullReadings ? 'no_data' : null;
    }
    s.nullStreak = 0;

    if (metric === 'temperatureC') {
      const ref = this.tempWindow.length >= 3 ? median(this.tempWindow) : null;
      pushBounded(this.tempWindow, v, 5);
      return ref != null && Math.abs(v - ref) > cfg.maxTempJumpC ? 'spike' : null;
    }

    s.sameCount = s.lastValue === v ? s.sameCount + 1 : 1;
    s.lastValue = v;
    if (metric === 'weightRaw' && (v >= ADC_MAX || v <= ADC_MIN)) return 'out_of_range';
    if (metric === 'phVoltage') {
      if (v < PH_V_MIN || v > PH_V_MAX) return 'out_of_range';
      if (calibrated.pH != null && (calibrated.pH < 0 || calibrated.pH > 14)) return 'out_of_range';
    }
    return s.sameCount >= cfg.stuckReadings ? 'stuck' : null;
  }

  /**
   * @returns {{bad:Set<string>, changes:{metric,active,reason,value}[]}}
   *   bad: metrics whose current sample must not be trusted
   */
  update(reading, calibrated, cfg) {
    const bad = new Set();
    const changes = [];
    for (const metric of FAULT_METRICS) {
      const v = reading[metric];
      const s = this.state[metric];
      const reason = this.#reason(metric, v, calibrated, cfg);
      if (reason || v == null) bad.add(metric);
      if (reason) {
        s.healthy = 0;
        if (!s.active) {
          s.active = true;
          s.reason = reason;
          changes.push({ metric, active: true, reason, value: v });
        }
      } else if (s.active && v != null) {
        s.healthy++;
        if (s.healthy >= cfg.clearReadings) {
          s.active = false;
          changes.push({ metric, active: false, reason: s.reason, value: v });
          s.reason = null;
        }
      }
    }
    return { bad, changes };
  }
}

const RAW_UNITS = { temperatureC: ' °C', weightRaw: ' raw', phVoltage: ' V' };

export function faultMessage(metric, reason, value) {
  const label = METRIC_LABELS[metric] ?? metric;
  const shown = `${value}${RAW_UNITS[metric] ?? ''}`;
  switch (reason) {
    case 'stuck':
      return `${label} stuck at ${shown}`;
    case 'spike':
      return `${label} spike: ${shown} rejected`;
    case 'out_of_range':
      return `${label} out of range (${shown})`;
    case 'no_data':
      return `${label} not responding`;
    default:
      return `${label} fault`;
  }
}
