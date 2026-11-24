/**
 * Application wiring: HTTP API + static dashboard + WebSocket hub around one Monitor.
 *
 *   POST /api/readings -> auth -> validate -> Monitor.ingest -> SQLite + WebSocket fan-out
 *
 * createApp() does not listen by itself, so tests can boot it on an ephemeral port with an
 * in-memory database.
 */
import http from 'node:http';
import { defaultConfig, applyConfigPatch } from '../shared/config.js';
import { validateBatch } from '../shared/validation.js';
import { chooseBucketMs, parseDuration } from '../shared/history.js';
import { Monitor } from '../shared/monitor.js';
import { openStore, METRIC_COLUMNS } from './db.js';
import { createHub } from './ws.js';
import { HttpError, createRouter, readJson, sendJson, serveStatic } from './http.js';
import { adminAuthorized, deviceKeyValid } from './auth.js';
import { loadSettings } from './settings.js';

const MAX_BUCKETS = 5000;

export function createApp(overrides = {}) {
  const opts = { ...loadSettings(), ...overrides };
  const log = opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a));
  const store = openStore(opts.dbPath);

  // Thresholds survive restarts: start from defaults, apply the saved config if still valid.
  let config = defaultConfig();
  const saved = store.loadConfig();
  if (saved) {
    const r = applyConfigPatch(config, saved);
    if (r.ok) config = r.value;
    else log('ignoring invalid saved config:', r.errors.join('; '));
  }
  const monitor = new Monitor({ config, ringSize: opts.ringSize ?? 3600 });
  monitor.restoreEvents(store.events({ from: Date.now() - 2 * 86_400_000, limit: 300 }));

  const router = createRouter();
  const server = http.createServer((req, res) => handle(req, res));
  const hub = createHub({ server, getSnapshot: () => monitor.snapshot(), heartbeatMs: opts.heartbeatMs, log: opts.verbose ? log : () => {} });
  const mounts = [
    { prefix: '/shared/', dir: opts.sharedDir },
    { prefix: '/', dir: opts.publicDir },
  ];

  /** Persist what needs persisting, then broadcast. */
  function publish(messages) {
    if (!messages.length) return;
    store.transaction(() => {
      for (const m of messages) {
        if (m.type === 'event') store.saveEvent(m.data);
        else if (m.type === 'alert') store.saveAlert(m.data);
      }
    });
    for (const m of messages) hub.broadcast(m);
  }

  // Wall-clock checks (device offline) once per second.
  const ticker = setInterval(() => publish(monitor.tick(Date.now())), opts.tickMs ?? 1000);
  ticker.unref();

  // Data retention: prune old raw readings hourly.
  const pruner = setInterval(() => store.prune(Date.now() - opts.retentionDays * 86_400_000), 3_600_000);
  pruner.unref();

  function requireAdmin(req) {
    if (!adminAuthorized(opts.adminToken, req)) throw new HttpError(401, 'admin token required (Authorization: Bearer ...)');
  }

  function int(value, name, fallback) {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
    return Math.round(n);
  }

  // ---- API -------------------------------------------------------------------------

  router.add('POST', '/api/readings', async (req, res) => {
    const key = req.headers['x-device-key'];
    if (typeof key !== 'string' || !key) throw new HttpError(401, 'missing X-Device-Key header');
    const body = await readJson(req);
    const result = validateBatch(body);
    if (!result.ok) throw new HttpError(400, 'invalid reading', result.errors);
    for (const r of result.value) {
      if (!deviceKeyValid(opts.deviceKeys, r.deviceId, key)) throw new HttpError(401, `invalid key for device ${r.deviceId}`);
    }

    const receivedAt = Date.now();
    const readings = [];
    const messages = [];
    for (const r of result.value) {
      const out = monitor.ingest(r, { receivedAt });
      readings.push(out.reading);
      messages.push(...out.messages);
    }
    store.transaction(() => store.insertReadings(readings));
    publish(messages);
    sendJson(res, 202, { accepted: readings.length, live: readings.filter((r) => !r.replay).length });
  });

  router.add('GET', '/api/state', (req, res) => sendJson(res, 200, monitor.snapshot()));

  router.add('GET', '/api/history', (req, res, { query }) => {
    const metric = query.get('metric') ?? 'temperatureC';
    if (!METRIC_COLUMNS[metric]) throw new HttpError(400, `metric must be one of ${Object.keys(METRIC_COLUMNS).join(', ')}`);
    const deviceId = query.get('deviceId') ?? [...monitor.devices.keys()].at(-1) ?? store.latestDeviceId();
    if (!deviceId) return sendJson(res, 200, { metric, deviceId: null, points: [] });
    const latest = monitor.devices.get(deviceId)?.lastTs ?? Date.now();
    const to = int(query.get('to'), 'to', latest);
    const from = int(query.get('from'), 'from', to - 3_600_000);
    if (from >= to) throw new HttpError(400, 'from must be before to');
    const bucketParam = query.get('bucket');
    const bucketMs = bucketParam ? parseDuration(bucketParam) : chooseBucketMs(to - from);
    if (!Number.isFinite(bucketMs) || bucketMs < 1000) throw new HttpError(400, 'bucket must be a duration of at least 1s (e.g. 30s, 5m, 60000)');
    if ((to - from) / bucketMs > MAX_BUCKETS) throw new HttpError(400, `too many buckets (max ${MAX_BUCKETS}); use a larger bucket`);
    const points = store.history({ metric, deviceId, from, to, bucketMs });
    sendJson(res, 200, { metric, deviceId, from, to, bucketMs, points });
  });

  router.add('GET', '/api/events', (req, res, { query }) => {
    const events = store.events({
      deviceId: query.get('deviceId') ?? undefined,
      type: query.get('type') ?? undefined,
      from: int(query.get('from'), 'from', 0),
      to: int(query.get('to'), 'to', Number.MAX_SAFE_INTEGER),
      limit: Math.min(int(query.get('limit'), 'limit', 200), 1000),
    });
    sendJson(res, 200, { events });
  });

  router.add('GET', '/api/alerts', (req, res, { query }) => {
    const status = query.get('status') ?? undefined;
    if (status && !['active', 'resolved'].includes(status)) throw new HttpError(400, 'status must be active or resolved');
    sendJson(res, 200, { alerts: store.alerts({ status, limit: Math.min(int(query.get('limit'), 'limit', 100), 1000) }) });
  });

  router.add('POST', '/api/alerts/:id/ack', (req, res, { params }) => {
    requireAdmin(req);
    const msg = monitor.acknowledge(params.id);
    const alert = msg ? msg.data : store.acknowledgeAlert(params.id);
    if (!alert) throw new HttpError(404, 'alert not found');
    if (msg) store.saveAlert(alert);
    hub.broadcast({ type: 'alert', data: alert });
    sendJson(res, 200, { alert });
  });

  router.add('GET', '/api/config', (req, res) => sendJson(res, 200, monitor.config));

  router.add('PUT', '/api/config', async (req, res) => {
    requireAdmin(req);
    const patch = await readJson(req, 16 * 1024);
    const r = applyConfigPatch(monitor.config, patch);
    if (!r.ok) throw new HttpError(400, 'invalid config', r.errors);
    store.saveConfig(r.value);
    hub.broadcast(monitor.setConfig(r.value));
    log('config updated');
    sendJson(res, 200, r.value);
  });

  router.add('GET', '/api/health', (req, res) =>
    sendJson(res, 200, { ok: true, uptimeS: Math.round(process.uptime()), clients: hub.clientCount, devices: monitor.devices.size }));

  // ---- dispatch ----------------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const match = router.match(req.method, url.pathname);
      if (match?.handler) {
        await match.handler(req, res, { params: match.params, query: url.searchParams });
        return;
      }
      if (match?.allowed) {
        res.setHeader('Allow', match.allowed.join(', '));
        throw new HttpError(405, 'method not allowed');
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (!serveStatic(req, res, url.pathname, mounts)) throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log('error', err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'internal error' : err.message, details: err.details });
      else res.destroy();
    }
  }

  return {
    server,
    monitor,
    store,
    hub,
    opts,
    /** Resolves with the bound port (pass port 0 for an ephemeral one). */
    listen(port = opts.port, host = opts.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    async close() {
      clearInterval(ticker);
      clearInterval(pruner);
      await hub.close();
      await new Promise((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
