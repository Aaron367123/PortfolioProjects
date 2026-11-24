/**
 * A small fixed-window, in-memory rate limiter.
 *
 * Good enough for a single Node process. With several instances behind a
 * load balancer the counters would need to live in a shared store (Redis).
 */
import { HttpError } from '../errors.js';

export function createRateLimiter({ windowMs, max }) {
  const buckets = new Map(); // key -> { count, resetAt }

  const current = (key) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  // Drop stale buckets once a minute so memory doesn't grow without bound.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }, 60_000);
  sweeper.unref(); // never keep the process (or a test run) alive

  return {
    /** Throws 429 if `key` has used up its allowance. */
    assertAllowed(key) {
      const bucket = current(key);
      if (bucket.count >= max) {
        const retryAfterSec = Math.ceil((bucket.resetAt - Date.now()) / 1000);
        const err = new HttpError(429, 'RATE_LIMITED', `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`);
        err.retryAfterSec = retryAfterSec;
        throw err;
      }
    },
    /** Record one attempt against `key`. */
    hit(key) {
      current(key).count += 1;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}
