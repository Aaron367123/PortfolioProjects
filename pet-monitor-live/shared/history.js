/**
 * History downsampling.
 *
 * A 24 h window at 1 Hz is 86 400 points per metric - far more than a ~600 px wide chart
 * can show. History queries therefore return fixed-width time buckets with
 * min / avg / max / n, so spikes stay visible (max) even after averaging.
 *
 * bucketize() is the reference implementation. The server computes the same thing in
 * SQL (GROUP BY CAST((ts - from) / bucket AS INTEGER)); a test asserts they agree.
 * RollupStore is the browser demo's stand-in for SQLite: 1-minute rollups that can be
 * merged into coarser buckets, so 24 h of history costs only 1 440 entries.
 */

export const METRICS = ['temperatureC', 'pH', 'weightG', 'phVoltage', 'weightRaw'];

const NICE_BUCKETS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600].map((s) => s * 1000);

/** Smallest "nice" bucket width giving at most `target` buckets over `spanMs`. */
export function chooseBucketMs(spanMs, target = 240) {
  const ideal = spanMs / target;
  return NICE_BUCKETS_MS.find((b) => b >= ideal) ?? NICE_BUCKETS_MS[NICE_BUCKETS_MS.length - 1];
}

/** "500ms" | "30s" | "5m" | "1h" | "1d" | plain milliseconds -> milliseconds (or NaN). */
export function parseDuration(value) {
  if (typeof value === 'number') return value;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!m) return NaN;
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] ?? 'ms'];
  return Number(m[1]) * mult;
}

/**
 * Groups points into buckets [from + k*bucketMs, from + (k+1)*bucketMs).
 * @param {{ts:number}[]} points readings sorted or unsorted
 * @param {string} metric property to aggregate (null values skipped)
 * @returns {{t:number,min:number,avg:number,max:number,n:number}[]} t = bucket start
 */
export function bucketize(points, metric, from, to, bucketMs) {
  const buckets = new Map();
  for (const p of points) {
    const v = p[metric];
    if (v == null || p.ts < from || p.ts > to) continue;
    const k = Math.floor((p.ts - from) / bucketMs);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { t: from + k * bucketMs, min: v, max: v, sum: 0, n: 0 }));
    if (v < b.min) b.min = v;
    if (v > b.max) b.max = v;
    b.sum += v;
    b.n++;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => ({ t: b.t, min: b.min, avg: b.sum / b.n, max: b.max, n: b.n }));
}

/**
 * Fixed-resolution rollups (default 1 minute) for long windows, bounded in size.
 * Used by the in-browser demo, which has no database.
 */
export class RollupStore {
  constructor({ resolutionMs = 60_000, maxBuckets = 1500, metrics = METRICS } = {}) {
    this.resolutionMs = resolutionMs;
    this.maxBuckets = maxBuckets;
    this.metrics = metrics;
    this.buckets = new Map(); // bucket start -> {metric: {min,max,sum,n}}
  }

  add(reading) {
    const t = Math.floor(reading.ts / this.resolutionMs) * this.resolutionMs;
    let b = this.buckets.get(t);
    if (!b) {
      this.buckets.set(t, (b = {}));
      if (this.buckets.size > this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value);
    }
    for (const m of this.metrics) {
      const v = reading[m];
      if (v == null) continue;
      const s = b[m] ?? (b[m] = { min: v, max: v, sum: 0, n: 0 });
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
      s.sum += v;
      s.n++;
    }
  }

  /** Merge rollups into buckets of `bucketMs` (rounded up to the rollup resolution). */
  query(metric, from, to, bucketMs) {
    const width = Math.max(this.resolutionMs, Math.ceil(bucketMs / this.resolutionMs) * this.resolutionMs);
    const out = new Map();
    for (const [t, b] of this.buckets) {
      const s = b[metric];
      if (!s || t + this.resolutionMs <= from || t > to) continue;
      const k = Math.max(0, Math.floor((t - from) / width));
      let o = out.get(k);
      if (!o) out.set(k, (o = { t: from + k * width, min: s.min, max: s.max, sum: 0, n: 0 }));
      o.min = Math.min(o.min, s.min);
      o.max = Math.max(o.max, s.max);
      o.sum += s.sum;
      o.n += s.n;
    }
    return [...out.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, o]) => ({ t: o.t, min: o.min, avg: o.sum / o.n, max: o.max, n: o.n }));
  }
}
