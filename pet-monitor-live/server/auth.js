/**
 * Authentication helpers.
 * Devices: X-Device-Key header, checked per deviceId against DEVICE_KEYS.
 * Admin (config changes, acknowledging alerts): optional "Authorization: Bearer <ADMIN_TOKEN>".
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (hash first so lengths always match). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True if `key` is valid for `deviceId`. A "*" entry (dev mode) matches every device. */
export function deviceKeyValid(deviceKeys, deviceId, key) {
  const expected = deviceKeys.get(deviceId) ?? deviceKeys.get('*');
  return expected != null && safeEqual(key, expected);
}

export function adminAuthorized(adminToken, req) {
  if (!adminToken) return true; // not configured: dashboard is open (local/dev use)
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m != null && safeEqual(m[1], adminToken);
}
