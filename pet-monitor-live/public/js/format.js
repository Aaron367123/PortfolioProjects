/** Display formatting helpers. */

const two = (n) => String(n).padStart(2, '0');

export function clock(ts, withSeconds = false) {
  const d = new Date(ts);
  return `${two(d.getHours())}:${two(d.getMinutes())}${withSeconds ? `:${two(d.getSeconds())}` : ''}`;
}

/** 75 -> "1m 15s", 4000 -> "1h 6m" */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
}

/** Age in words: "just now", "12 s ago", "4 min ago", "2 h ago". */
export function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function num(v, decimals) {
  return v == null || !Number.isFinite(v) ? '--' : v.toFixed(decimals);
}

/**
 * Least-squares slope of value over time, in units per minute.
 * Used for the trend arrows on the status cards.
 */
export function slopePerMinute(points) {
  const pts = points.filter((p) => p.v != null);
  if (pts.length < 5) return null;
  const t0 = pts[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 60_000;
    sx += x;
    sy += p.v;
    sxx += x * x;
    sxy += x * p.v;
  }
  const n = pts.length;
  const den = n * sxx - sx * sx;
  return den === 0 ? null : (n * sxy - sx * sy) / den;
}
