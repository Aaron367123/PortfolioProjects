/**
 * Test harness: a real HTTP server on an ephemeral port, backed by a fresh
 * in-memory SQLite database, plus a tiny fetch client with a cookie jar.
 */
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { seedDemoData } from '../src/db/seed.js';

export const DEMO_PASSWORD = 'demo-pass-123';

/**
 * @param {{ seed?: boolean, env?: object }} options
 */
export async function startServer({ seed = false, env = {} } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', ...env });
  const db = openDatabase(':memory:');
  if (seed) await seedDemoData(db, { demoPassword: DEMO_PASSWORD });

  const app = createApp({ db, config });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    db,
    client: () => new Client(baseUrl),
    async close() {
      server.closeAllConnections(); // fetch keeps sockets alive; drop them so close() resolves
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  /** Send a request; JSON-encodes `body` and returns { status, headers, body }. */
  async request(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['content-type'] ??= 'application/json';
    }
    if (this.cookies.size) {
      init.headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const res = await fetch(this.baseUrl + path, init);
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, value] = pair.split('=');
      if (/Max-Age=0/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (HTML) */
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  get(path, headers) { return this.request('GET', path, undefined, headers); }
  post(path, body = {}, headers) { return this.request('POST', path, body, headers); }
  put(path, body, headers) { return this.request('PUT', path, body, headers); }
  patch(path, body, headers) { return this.request('PATCH', path, body, headers); }
  delete(path, headers) { return this.request('DELETE', path, undefined, headers); }

  /** Register (and thereby log in) a new user. */
  async register(username, password = 'secret-pass-1') {
    const res = await this.post('/api/auth/register', { username, password });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.user;
  }

  async login(username, password) {
    return this.post('/api/auth/login', { username, password });
  }
}

/** A valid song payload; override any field. */
export const songPayload = (overrides = {}) => ({
  title: 'Test Tune',
  artist: 'The Testers',
  album: 'Assertions',
  genre: 'Indie',
  duration_sec: 180,
  year: 2024,
  ...overrides,
});
