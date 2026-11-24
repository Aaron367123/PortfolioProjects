/** Small helpers shared by the logic modules (browser + Node). */

/** Median of the non-null numbers in `values`, or null if there are none. */
export function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Appends to an array and trims it to `max` items from the front. */
export function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return arr;
}

export const round = (v, digits = 0) => (v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Local calendar day "YYYY-MM-DD" for daily totals. */
export function dayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Short random id (not security sensitive): time prefix keeps ids roughly sortable. */
export function makeId(prefix, ts = Date.now()) {
  return `${prefix}_${ts.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
