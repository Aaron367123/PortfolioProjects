/**
 * Session middleware: turns the session cookie into `req.user`, and a guard
 * for routes that need a logged-in user.
 */
import { parseCookies, serializeCookie } from './cookies.js';
import { unauthenticated } from '../errors.js';

export function sessionMiddleware({ sessions, cookieName }) {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[cookieName];
    req.sessionToken = token;
    req.user = token ? sessions.lookup(token) : null;
    next();
  };
}

/** 401 unless a valid session cookie was presented. */
export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthenticated());
  next();
}

/** Set / clear the session cookie with the app's cookie policy. */
export function sessionCookie(config) {
  const { cookieName, ttlMs, secure } = config.session;
  return {
    set(res, token) {
      res.append('Set-Cookie', serializeCookie(cookieName, token, {
        maxAgeSec: Math.floor(ttlMs / 1000), httpOnly: true, sameSite: 'Lax', secure,
      }));
    },
    clear(res) {
      res.append('Set-Cookie', serializeCookie(cookieName, '', { maxAgeSec: 0, httpOnly: true, sameSite: 'Lax', secure }));
    },
  };
}
