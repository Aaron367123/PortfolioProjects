/**
 * Alerting primitives.
 *
 * AlertTracker is a Schmitt trigger with confirmation and cooldown:
 *   - fires only after `confirm` consecutive readings meet the trigger condition,
 *   - resolves only when the separate (stricter) clear condition holds - the gap
 *     between trigger and clear is the hysteresis band, so a value hovering around
 *     the threshold cannot make the alert flap,
 *   - never fires again within `cooldownMs` of its previous firing.
 */

export class AlertTracker {
  constructor() {
    this.active = false;
    this.pending = 0; // consecutive readings meeting the trigger condition
    this.lastFiredAt = null;
  }

  /**
   * @param {number} ts             time of the evaluation (ms)
   * @param {boolean} triggered      condition to fire (e.g. temp > high)
   * @param {boolean} cleared        condition to resolve (e.g. temp <= high - hysteresis)
   * @returns {'fire'|'resolve'|null}
   */
  update(ts, triggered, cleared, { confirm = 1, cooldownMs = 0 } = {}) {
    if (!this.active) {
      this.pending = triggered ? this.pending + 1 : 0;
      const coolingDown = this.lastFiredAt != null && ts - this.lastFiredAt < cooldownMs;
      if (this.pending >= confirm && !coolingDown) {
        this.active = true;
        this.pending = 0;
        this.lastFiredAt = ts;
        return 'fire';
      }
      return null;
    }
    if (cleared) {
      this.active = false;
      return 'resolve';
    }
    return null;
  }
}

export const SEVERITY = { info: 'info', warning: 'warning', critical: 'critical' };

/**
 * Threshold rules derived from the current config. Each rule reads one calibrated metric.
 * trigger/clear are deliberately asymmetric (hysteresis).
 */
export function thresholdRules(config) {
  const t = config.alerts.temperature;
  const p = config.alerts.ph;
  return [
    {
      key: 'temp_high',
      rule: 'temperature',
      metric: 'temperatureC',
      severity: SEVERITY.warning,
      threshold: t.highC,
      trigger: (v) => v > t.highC,
      clear: (v) => v <= t.highC - t.hysteresisC,
      message: (v) => `Room too hot: ${v.toFixed(1)} °C (limit ${t.highC} °C)`,
    },
    {
      key: 'temp_low',
      rule: 'temperature',
      metric: 'temperatureC',
      severity: SEVERITY.warning,
      threshold: t.lowC,
      trigger: (v) => v < t.lowC,
      clear: (v) => v >= t.lowC + t.hysteresisC,
      message: (v) => `Room too cold: ${v.toFixed(1)} °C (limit ${t.lowC} °C)`,
    },
    {
      key: 'ph_low',
      rule: 'water_ph',
      metric: 'pH',
      severity: SEVERITY.warning,
      threshold: p.min,
      trigger: (v) => v < p.min,
      clear: (v) => v >= p.min + p.hysteresis,
      message: (v) => `Water too acidic: pH ${v.toFixed(2)} (safe ≥ ${p.min}) - time to refill`,
    },
    {
      key: 'ph_high',
      rule: 'water_ph',
      metric: 'pH',
      severity: SEVERITY.warning,
      threshold: p.max,
      trigger: (v) => v > p.max,
      clear: (v) => v <= p.max - p.hysteresis,
      message: (v) => `Water too alkaline: pH ${v.toFixed(2)} (safe ≤ ${p.max})`,
    },
  ];
}
