import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

describe('auth', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { LOGIN_MAX_ATTEMPTS: '3' } }); });
  after(() => srv.close());

  it('registers a user, sets an HttpOnly SameSite=Lax session cookie and logs them in', async () => {
    const c = srv.client();
    const res = await c.post('/api/auth/register', { username: 'aaron', password: 'tunes-4-life' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, 'aaron');
    assert.equal(res.body.user.password_hash, undefined, 'hash must never be returned');

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /myousik_sid=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'aaron');
  });

  it('stores a salted scrypt hash, never the password, and the session token only as a hash', async () => {
    const c = srv.client();
    await c.register('salty1', 'same-pass-1');
    await srv.client().register('salty2', 'same-pass-1');
    const rows = srv.db.prepare("SELECT * FROM users WHERE username IN ('salty1','salty2')").all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].password_salt, rows[1].password_salt);
    assert.notEqual(rows[0].password_hash, rows[1].password_hash, 'same password, different salt => different hash');
    assert.ok(!JSON.stringify(rows).includes('same-pass-1'));

    const token = c.cookies.get('myousik_sid');
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(token).n, 0);
  });

  it('GET /me without a session returns 401 in the standard error shape', async () => {
    const res = await srv.client().get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    assert.equal(typeof res.body.error.message, 'string');
  });

  it('rejects invalid registrations with 400 and per-field messages', async () => {
    const res = await srv.client().post('/api/auth/register', { username: '9lives', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.match(res.body.error.fields.username, /start with a letter/);
    assert.match(res.body.error.fields.password, /8–128 characters/);

    const empty = await srv.client().post('/api/auth/register', {});
    assert.deepEqual(Object.keys(empty.body.error.fields).sort(), ['password', 'username']);
  });

  it('rejects duplicate usernames (case-insensitive) with 409', async () => {
    await srv.client().register('Duplicate');
    const res = await srv.client().post('/api/auth/register', { username: 'duplicate', password: 'another-pass-2' });
    assert.equal(res.status, 409);
    assert.ok(res.body.error.fields.username);
  });

  it('logs in with the right password, rejects the wrong one with 401', async () => {
    await srv.client().register('loginuser', 'correct-horse-1');
    const c = srv.client();

    const bad = await c.login('loginuser', 'wrong-horse-1');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(c.cookies.size, 0);

    const unknown = await c.login('nobody-here', 'whatever-1');
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.message, bad.body.error.message, 'no hint about which part was wrong');

    const good = await c.login('LoginUser', 'correct-horse-1');
    assert.equal(good.status, 200);
    assert.equal(good.body.user.username, 'loginuser');
    assert.equal((await c.get('/api/auth/me')).status, 200);
  });

  it('logout deletes the server-side session so the old cookie stops working', async () => {
    const c = srv.client();
    await c.register('leaver');
    const oldToken = c.cookies.get('myousik_sid');

    const out = await c.post('/api/auth/logout');
    assert.equal(out.status, 204);
    assert.equal((await c.get('/api/auth/me')).status, 401);

    const replay = await srv.client().get('/api/auth/me', { cookie: `myousik_sid=${oldToken}` });
    assert.equal(replay.status, 401);
  });

  it('expired sessions are rejected', async () => {
    const c = srv.client();
    await c.register('expiring');
    srv.db.prepare('UPDATE sessions SET expires_at = 0').run();
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  it('rate-limits repeated failed logins with 429 + Retry-After', async () => {
    await srv.client().register('target', 'real-pass-123');
    const attacker = srv.client();
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await attacker.login('target', `guess-${i}xx`)).status, 401);
    }
    const blocked = await attacker.login('target', 'real-pass-123');
    assert.equal(blocked.status, 429, 'even the right password is refused while locked out');
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });

  it('requires JSON bodies (415) and rejects cross-origin writes (403)', async () => {
    const c = srv.client();
    const form = await c.request('POST', '/api/auth/login', 'username=a&password=b', {
      'content-type': 'application/x-www-form-urlencoded',
    });
    assert.equal(form.status, 415);
    assert.equal(form.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');

    const cross = await c.post('/api/auth/login', { username: 'a', password: 'b' }, { origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error.code, 'CSRF_REJECTED');
  });

  it('returns 400 INVALID_JSON for malformed bodies and JSON 404s for unknown API routes', async () => {
    const c = srv.client();
    const bad = await c.request('POST', '/api/auth/login', '{"username":', { 'content-type': 'application/json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_JSON');

    const missing = await c.get('/api/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  });

  it('sends security headers on pages and API responses', async () => {
    const page = await srv.client().get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('x-powered-by'), null);

    const api = await srv.client().get('/api/health');
    assert.equal(api.headers.get('cache-control'), 'no-store');
  });
});
