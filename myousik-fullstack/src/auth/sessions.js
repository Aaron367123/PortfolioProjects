/**
 * Server-side sessions stored in SQLite.
 *
 * The browser's cookie holds a random 256-bit token. The database stores only
 * the SHA-256 of that token, so a leaked database (or backup) cannot be used
 * to hijack live sessions. Logging out deletes the row, which revokes the
 * session immediately — something a stateless signed cookie can't do.
 */
import { randomBytes, createHash } from 'node:crypto';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createSessionStore(db, { ttlMs }) {
  const insert = db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const findByToken = db.prepare(`
    SELECT s.user_id, s.expires_at, u.username, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?`);
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    /** Create a session and return the raw token for the cookie. */
    create(userId) {
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      const expiresAt = now + ttlMs;
      insert.run(hashToken(token), userId, now, expiresAt);
      return { token, expiresAt };
    },

    /** Resolve a cookie token to a user, or null if unknown/expired. */
    lookup(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const id = hashToken(token);
      const row = findByToken.get(id);
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        remove.run(id);
        return null;
      }
      return { id: row.user_id, username: row.username, created_at: row.created_at };
    },

    destroy(token) {
      if (typeof token === 'string') remove.run(hashToken(token));
    },

    purgeExpired() {
      return removeExpired.run(Date.now()).changes;
    },
  };
}
