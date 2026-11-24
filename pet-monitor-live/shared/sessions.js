/**
 * "Pet at bowl" session detection - a two-state machine with debouncing.
 *
 *            N presence readings in a row
 *   IDLE  ------------------------------------>  VISITING
 *     ^                                             |
 *     +---------------------------------------------+
 *            N absence readings in a row
 *
 * Debouncing matters because the Person Sensor flickers: a single missed face (0) while
 * the pet is eating must not split one visit into two, and a single false positive must
 * not create a visit.
 *
 * Food eaten = (median bowl weight just before arrival) - (median weight just after the
 * pet left). Readings while the pet is present are ignored for this because paws and
 * head pressing on the bowl inflate the FSR reading.
 */
import { median, pushBounded, round } from './util.js';

const BASELINE_SIZE = 5;

export class SessionTracker {
  constructor() {
    this.state = 'idle';
    this.arriving = []; // presence streak while idle
    this.leaving = []; // absence streak while visiting
    this.idleWeights = []; // recent weights with nobody at the bowl
    this.current = null; // {startTs, lastSeenTs, baselineG}
  }

  get visiting() {
    return this.state === 'visiting';
  }

  /**
   * Feed one reading. Returns 0 or 1 events.
   * @param {{ts:number, presence:boolean|null, weightG:number|null}} r
   * @param {{debounceReadings:number, minEatenG:number}} opts
   */
  update(r, { debounceReadings = 3, minEatenG = 3 } = {}) {
    if (r.presence == null) return []; // presence sensor failed: no evidence either way
    const n = Math.max(1, debounceReadings);

    if (this.state === 'idle') {
      if (!r.presence) {
        this.arriving = [];
        if (r.weightG != null) pushBounded(this.idleWeights, r.weightG, BASELINE_SIZE);
        return [];
      }
      this.arriving.push(r);
      if (this.arriving.length < n) return [];
      // Confirmed arrival; the visit started at the first reading of the streak.
      const startTs = this.arriving[0].ts;
      this.current = { startTs, lastSeenTs: r.ts, baselineG: median(this.idleWeights) };
      this.state = 'visiting';
      this.arriving = [];
      this.leaving = [];
      return [{ type: 'visit_start', ts: startTs, baselineG: this.current.baselineG }];
    }

    // VISITING
    if (r.presence) {
      this.current.lastSeenTs = r.ts;
      this.leaving = [];
      return [];
    }
    this.leaving.push(r);
    if (this.leaving.length < n) return [];

    // Confirmed departure; the visit ended at the last reading that saw the pet.
    const { startTs, lastSeenTs, baselineG } = this.current;
    const afterG = median(this.leaving.map((x) => x.weightG));
    const foodEatenG = baselineG != null && afterG != null ? round(Math.max(0, baselineG - afterG), 1) : null;
    const kind = foodEatenG != null && foodEatenG >= minEatenG ? 'eating' : 'drinking';
    const event = {
      type: 'visit_end',
      ts: r.ts,
      startTs,
      endTs: lastSeenTs,
      durationS: Math.round((lastSeenTs - startTs) / 1000),
      kind,
      foodEatenG,
      baselineG: round(baselineG, 1),
      afterG: round(afterG, 1),
    };
    // The absence streak are idle readings: they become the next visit's baseline.
    this.idleWeights = this.leaving.map((x) => x.weightG).filter((w) => w != null).slice(-BASELINE_SIZE);
    this.state = 'idle';
    this.leaving = [];
    this.current = null;
    return [event];
  }
}
