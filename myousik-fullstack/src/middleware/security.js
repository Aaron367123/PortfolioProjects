/**
 * Security middleware written by hand (instead of helmet) so every header is
 * visible and explainable.
 */
import { HttpError } from '../errors.js';

/** Basic hardening headers for every response. */
export function securityHeaders({ hsts }) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https:", // songs may reference remote cover art
    "media-src 'self' https:", // ...and remote audio URLs
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (hsts) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * CSRF defence for the JSON API, layered on top of the SameSite=Lax cookie:
 *  1. Requests that change state must send Content-Type: application/json.
 *     A cross-site HTML <form> can only send urlencoded/multipart/text-plain,
 *     and a cross-site fetch with a JSON content type triggers a CORS
 *     preflight that this server never approves.
 *  2. If the browser sends an Origin header on an unsafe request, it must
 *     match this server's Host.
 */
export function csrfGuard() {
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();

    const origin = req.get('origin');
    if (origin) {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== req.get('host')) {
        return next(new HttpError(403, 'CSRF_REJECTED', 'Cross-origin request rejected.'));
      }
    }

    if (BODY_METHODS.has(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must use Content-Type: application/json.'));
    }
    next();
  };
}
