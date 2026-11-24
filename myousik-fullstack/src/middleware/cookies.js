/**
 * Minimal cookie helpers — the app only ever reads/writes one cookie, so a
 * dependency like cookie-parser isn't needed.
 */

/** Parse a Cookie header into a plain object. Malformed pairs are skipped. */
export function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      /* ignore undecodable values */
    }
  }
  return out;
}

/** Build a Set-Cookie header value. */
export function serializeCookie(name, value, { maxAgeSec, httpOnly = true, sameSite = 'Lax', secure = false, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAgeSec !== undefined) {
    parts.push(`Max-Age=${maxAgeSec}`);
    parts.push(`Expires=${new Date(Date.now() + maxAgeSec * 1000).toUTCString()}`);
  }
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
