/**
 * End-to-end: boots the real server on an ephemeral port with an in-memory database,
 * posts readings over HTTP and checks what a WebSocket client receives.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';

let app;
let base;
const KEY = 'test-key';
const T0 = Date.now() - 60_000;

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    deviceKeys: new Map([['pi-test', KEY]]),
    adminToken: 'admin-secret',
    log: () => {},
    tickMs: 100,
  });
  const port = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(() => app.close());

const reading = (i, over = {}) => ({ deviceId: 'pi-test', ts: T0 + i * 1000, temperatureC: 22, weightRaw: 8000 + (i % 5), phVoltage: 2.5 + (i % 3) / 1000, faces: 0, ...over });

function post(body, key = KEY, path = '/api/readings') {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Key': key }, body: JSON.stringify(body) });
}

/** Opens a WS client that records every message; resolves after the snapshot arrives. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const messages = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) waiters.splice(waiters.indexOf(w), 1), w.resolve(msg);
      if (msg.type === 'snapshot') resolve(client);
    });
    ws.on('error', reject);
    const client = {
      ws,
      messages,
      waitFor(pred, ms = 3000) {
        const hit = messages.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timed out waiting for message')), ms);
          waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
        });
      },
    };
  });
}

test('ingest requires a valid device key', async () => {
  assert.equal((await post(reading(0), '')).status, 401);
  assert.equal((await post(reading(0), 'wrong')).status, 401);
  assert.equal((await post({ ...reading(0), deviceId: 'intruder' })).status, 401);
});

test('ingest rejects junk with 400 and details', async () => {
  const res = await post({ ...reading(0), temperatureC: 'hot' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.details[0], /temperatureC/);
  const notJson = await fetch(base + '/api/readings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Key': KEY }, body: '{oops' });
  assert.equal(notJson.status, 400);
  const wrongType = await fetch(base + '/api/readings', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Device-Key': KEY }, body: '{}' });
  assert.equal(wrongType.status, 415);
});

test('WebSocket client gets snapshot, then live readings and a fired alert', async () => {
  const client = await connect();
  assert.equal(client.messages[0].type, 'snapshot');
  assert.ok(Array.isArray(client.messages[0].data.devices));

  // Temperatures ramp up (a jump of >5 °C in one second would be rejected as a sensor spike).
  const temps = [22, 26, 29, 31, 32, 33, 34];
  const batch = temps.map((t, i) => reading(i, { temperatureC: t }));
  const res = await post(batch);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 7, live: 7 });

  const r = await client.waitFor((m) => m.type === 'reading' && m.data.ts === T0 + 6000);
  assert.equal(r.data.deviceId, 'pi-test');
  assert.ok(Math.abs(r.data.weightG - 300.05) <= 0.051); // (8001 - 2000) * 500 / 10000
  assert.equal(r.data.pH, 7); // 2.500 V = the pH 7 buffer voltage

  const alert = await client.waitFor((m) => m.type === 'alert' && m.data.key === 'temp_high');
  assert.equal(alert.data.status, 'active');
  assert.equal(alert.data.ts, T0 + 5000);
  assert.match(alert.data.message, /too hot/);

  // Acknowledge needs the admin token, then is broadcast.
  const ackUrl = `${base}/api/alerts/${alert.data.id}/ack`;
  assert.equal((await fetch(ackUrl, { method: 'POST' })).status, 401);
  const ack = await fetch(ackUrl, { method: 'POST', headers: { Authorization: 'Bearer admin-secret' } });
  assert.equal(ack.status, 200);
  await client.waitFor((m) => m.type === 'alert' && m.data.id === alert.data.id && m.data.acknowledged);

  // Persisted to SQLite.
  const listed = await (await fetch(`${base}/api/alerts?status=active`)).json();
  assert.ok(listed.alerts.some((a) => a.id === alert.data.id && a.acknowledged));
  client.ws.close();
});

test('device offline alert arrives over WebSocket after silence', async () => {
  // Shorten the offline window for the test (admin-protected config API).
  const put = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
    body: JSON.stringify({ alerts: { offlineSeconds: 2, cooldownMinutes: 0 } }),
  });
  assert.equal(put.status, 200);
  const client = await connect();
  await post(reading(7, { temperatureC: 33 }));
  const offline = await client.waitFor((m) => m.type === 'alert' && m.data.key === 'device_offline', 5000);
  assert.equal(offline.data.severity, 'critical');
  await post(reading(8, { temperatureC: 33 }));
  await client.waitFor((m) => m.type === 'alert' && m.data.id === offline.data.id && m.data.status === 'resolved');
  client.ws.close();
});

test('history API returns downsampled buckets', async () => {
  const res = await fetch(`${base}/api/history?metric=temperatureC&deviceId=pi-test&from=${T0}&to=${T0 + 10_000}&bucket=5s`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.bucketMs, 5000);
  assert.deepEqual(body.points.map((p) => [p.t, p.n, p.min, p.max]), [
    [T0, 5, 22, 32],
    [T0 + 5000, 4, 33, 34],
  ]);
  assert.equal((await fetch(`${base}/api/history?metric=bogus`)).status, 400);
  assert.equal((await fetch(`${base}/api/history?metric=pH&from=10&to=5`)).status, 400);
  assert.equal((await fetch(`${base}/api/history?metric=pH&from=0&to=${Date.now()}&bucket=1s`)).status, 400); // too many buckets
});

test('config API validates and broadcasts', async () => {
  const bad = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
    body: JSON.stringify({ alerts: { temperature: { highC: 'warm' } } }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const client = await connect();
  const ok = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
    body: JSON.stringify({ alerts: { temperature: { highC: 27 } } }),
  });
  assert.equal(ok.status, 200);
  const msg = await client.waitFor((m) => m.type === 'config');
  assert.equal(msg.data.alerts.temperature.highC, 27);
  assert.equal((await (await fetch(`${base}/api/config`)).json()).alerts.temperature.highC, 27);
  client.ws.close();
});

test('state, events, static dashboard and shared modules are served', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.devices[0].deviceId, 'pi-test');
  assert.ok(state.devices[0].readings.length >= 9);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const shared = await fetch(`${base}/shared/monitor.js`);
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/state`, { method: 'DELETE' })).status, 405);
  assert.ok(Array.isArray((await (await fetch(`${base}/api/events`)).json()).events));
});

test('replayed readings are stored for history but not broadcast', async () => {
  const client = await connect();
  const res = await post([reading(-30, { replay: true, temperatureC: 19 }), reading(20)]);
  assert.deepEqual(await res.json(), { accepted: 2, live: 1 });
  await client.waitFor((m) => m.type === 'reading' && m.data.ts === T0 + 20_000);
  assert.ok(!client.messages.some((m) => m.type === 'reading' && m.data.replay));
  const h = await (await fetch(`${base}/api/history?metric=temperatureC&deviceId=pi-test&from=${T0 - 40_000}&to=${T0 - 20_000}&bucket=10s`)).json();
  assert.equal(h.points[0].min, 19);
  client.ws.close();
});
