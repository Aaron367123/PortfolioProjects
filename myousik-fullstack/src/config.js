/**
 * Runtime configuration, read from environment variables with safe
 * development defaults. Nothing secret is hard-coded: the app has no
 * signing keys at all, because session ids are random tokens looked up in
 * the database rather than signed cookies.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  return {
    nodeEnv,
    isProduction,
    port: toInt(env.PORT, 3000),
    // 127.0.0.1 by default so a dev server is not exposed on the LAN;
    // the Docker image sets HOST=0.0.0.0.
    host: env.HOST || '127.0.0.1',
    dbPath: env.DB_PATH || 'data/myousik.db',
    seedIfEmpty: env.SEED_IF_EMPTY === 'true',

    session: {
      cookieName: 'myousik_sid',
      ttlMs: toInt(env.SESSION_TTL_HOURS, 24 * 7) * 60 * 60 * 1000,
      // Secure cookies need HTTPS; on by default in production.
      secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction,
    },

    // Express "trust proxy" — only enable behind a reverse proxy you control,
    // otherwise clients could spoof X-Forwarded-For and dodge the rate limiter.
    trustProxy: env.TRUST_PROXY === 'true',

    rateLimits: {
      // Failed logins per (IP + username) and per IP, within the window.
      login: { windowMs: 15 * 60 * 1000, max: toInt(env.LOGIN_MAX_ATTEMPTS, 5) },
      loginPerIp: { windowMs: 15 * 60 * 1000, max: toInt(env.LOGIN_MAX_ATTEMPTS_PER_IP, 50) },
      // Public feedback submissions per IP.
      feedback: { windowMs: 60 * 60 * 1000, max: toInt(env.FEEDBACK_MAX_PER_HOUR, 20) },
    },
  };
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
