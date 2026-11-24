/**
 * /api/auth — register, login, logout, current user.
 */
import { Router } from 'express';
import { check, schemas } from '../validation.js';
import { hashPassword, verifyPassword, DUMMY_CREDENTIALS } from '../auth/password.js';
import { requireAuth, sessionCookie } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { HttpError, conflict } from '../errors.js';

const publicUser = (row) => ({ id: row.id, username: row.username, created_at: row.created_at });

export function authRouter({ db, sessions, config }) {
  const router = Router();
  const cookie = sessionCookie(config);
  const perAccount = createRateLimiter(config.rateLimits.login);
  const perIp = createRateLimiter(config.rateLimits.loginPerIp);

  const findByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?) RETURNING *');

  /** Start a session for `user` and set the cookie. */
  const logIn = (res, user) => {
    const { token } = sessions.create(user.id);
    cookie.set(res, token);
  };

  router.post('/register', async (req, res) => {
    const { username, password } = check(req.body, schemas.register);
    if (findByUsername.get(username)) {
      throw conflict('That username is taken.', { username: 'That username is taken.' });
    }
    const { salt, hash } = await hashPassword(password);
    let user;
    try {
      user = insertUser.get(username, hash, salt);
    } catch (err) {
      // Two sign-ups for the same name can race while scrypt runs; the UNIQUE index decides.
      if (/UNIQUE constraint failed/.test(err.message)) {
        throw conflict('That username is taken.', { username: 'That username is taken.' });
      }
      throw err;
    }
    logIn(res, user);
    res.status(201).json({ user: publicUser(user) });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = check(req.body, schemas.login);
    const accountKey = `${req.ip}|${username.toLowerCase()}`;
    perAccount.assertAllowed(accountKey);
    perIp.assertAllowed(req.ip);

    const user = findByUsername.get(username);
    // Always run scrypt, even for unknown users, so timing doesn't leak which usernames exist.
    const creds = user ? { salt: user.password_salt, hash: user.password_hash } : DUMMY_CREDENTIALS;
    const ok = await verifyPassword(password, creds.salt, creds.hash);

    if (!user || !ok) {
      perAccount.hit(accountKey);
      perIp.hit(req.ip);
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
    }

    perAccount.reset(accountKey);
    // Rotate: drop any session the browser already had before issuing a new one.
    sessions.destroy(req.sessionToken);
    logIn(res, user);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    sessions.destroy(req.sessionToken);
    cookie.clear(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
