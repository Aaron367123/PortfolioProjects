/**
 * Builds the Express application. Kept separate from server.js so tests can
 * create an app around an in-memory database and listen on a random port.
 */
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionStore } from './auth/sessions.js';
import { sessionMiddleware } from './middleware/auth.js';
import { securityHeaders, csrfGuard } from './middleware/security.js';
import { apiNotFound, errorHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { songsRouter } from './routes/songs.js';
import { playlistsRouter } from './routes/playlists.js';
import { feedbackRouter } from './routes/feedback.js';
import { catalogRouter } from './routes/catalog.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: ReturnType<import('./config.js').loadConfig> }} deps
 */
export function createApp({ db, config }) {
  const app = express();
  const sessions = createSessionStore(db, { ttlMs: config.session.ttlMs });
  const deps = { db, config, sessions };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders({ hsts: config.session.secure }));

  // ---- JSON API -----------------------------------------------------------
  const api = express.Router();
  api.use(csrfGuard());
  api.use(express.json({ limit: '20kb' }));
  api.use(sessionMiddleware({ sessions, cookieName: config.session.cookieName }));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store'); // API responses are per-user; never cache them
    next();
  });

  api.get('/health', (_req, res) => res.json({ status: 'ok' }));
  api.use('/auth', authRouter(deps));
  api.use('/songs', songsRouter(deps));
  api.use('/playlists', playlistsRouter(deps));
  api.use('/feedback', feedbackRouter(deps));
  api.use('/', catalogRouter(deps));
  api.use(apiNotFound);

  app.use('/api', api);

  // ---- Static front end ---------------------------------------------------
  // `extensions` lets /library serve library.html, giving clean URLs.
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: config.isProduction ? '1h' : 0 }));
  app.use((_req, res) => res.status(404).sendFile(join(PUBLIC_DIR, '404.html')));

  app.use(errorHandler);

  // Expired sessions are also removed lazily on lookup; this sweeps the rest.
  sessions.purgeExpired();
  setInterval(() => sessions.purgeExpired(), 60 * 60 * 1000).unref();

  return app;
}
