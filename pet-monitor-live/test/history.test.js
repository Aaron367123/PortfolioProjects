import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketize, chooseBucketMs, parseDuration, RollupStore } from '../shared/history.js';
import { RingBuffer } from '../shared/ringbuffer.js';
import { openStore } from '../server/db.js';

const T0 = Date.UTC(2026, 2, 3, 10, 0, 0);

test('bucketize: min/avg/max/n per fixed bucket, nulls skipped, range inclusive', () => {
  const pts = [
    { ts: T0, v: 1 },
    { ts: T0 + 500, v: 3 },
    { ts: T0 + 999, v: null },
    { ts: T0 + 1000, v: 10 },
    { ts: T0 + 2500, v: 4 },
    { ts: T0 + 2600, v: 8 },
    { ts: T0 + 9999, v: 100 }, // outside `to`
  ];
  assert.deepEqual(bucketize(pts, 'v', T0, T0 + 3000, 1000), [
    { t: T0, min: 1, avg: 2, max: 3, n: 2 },
    { t: T0 + 1000, min: 10, avg: 10, max: 10, n: 1 },
    { t: T0 + 2000, min: 4, avg: 6, max: 8, n: 2 },
  ]);
});

test('chooseBucketMs picks a nice width for ~240 buckets; parseDuration', () => {
  assert.equal(chooseBucketMs(60_000), 1000);
  assert.equal(chooseBucketMs(3_600_000), 15_000);
  assert.equal(chooseBucketMs(86_400_000), 600_000);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('2500'), 2500);
  assert.ok(Number.isNaN(parseDuration('soon')));
});

test('SQL bucketing in SQLite matches the reference bucketize()', () => {
  const store = openStore(':memory:');
  const readings = [];
  for (let i = 0; i < 1000; i++) {
    readings.push({
      deviceId: 'd1', ts: T0 + i * 1000 + (i % 3) * 7, receivedAt: T0, temperatureRaw: 20 + Math.sin(i / 50) * 3,
      weightRaw: 8000 + i, phVoltage: 2.5, faces: 0, temperatureC: i % 97 === 0 ? null : 20 + Math.sin(i / 50) * 3,
      weightG: 250 - i / 10, pH: 7, presence: false, faults: [], replay: false,
    });
  }
  readings.push({ ...readings[10], deviceId: 'other', temperatureC: 99 }); // other device ignored
  store.transaction(() => store.insertReadings(readings));
  const from = T0 + 12_345;
  const to = T0 + 900_000;
  for (const [metric, bucketMs] of [['temperatureC', 60_000], ['weightG', 15_000], ['weightRaw', 7_000]]) {
    const sql = store.history({ metric, deviceId: 'd1', from, to, bucketMs });
    const ref = bucketize(readings.filter((r) => r.deviceId === 'd1'), metric, from, to, bucketMs);
    assert.equal(sql.length, ref.length, metric);
    sql.forEach((b, i) => {
      assert.equal(b.t, ref[i].t);
      assert.equal(b.n, ref[i].n);
      assert.ok(Math.abs(b.min - ref[i].min) < 1e-9 && Math.abs(b.max - ref[i].max) < 1e-9);
      assert.ok(Math.abs(b.avg - ref[i].avg) < 1e-9);
    });
  }
  assert.throws(() => store.history({ metric: 'temperature_c; DROP TABLE readings', deviceId: 'd1', from, to, bucketMs: 1000 }), RangeError);
  store.close();
});

test('RollupStore merges 1-minute rollups into coarser buckets', () => {
  const rs = new RollupStore({ resolutionMs: 60_000, maxBuckets: 100, metrics: ['v'] });
  const raw = [];
  for (let i = 0; i < 600; i++) {
    const r = { ts: T0 + i * 1000, v: i % 60 };
    raw.push(r);
    rs.add(r);
  }
  const merged = rs.query('v', T0, T0 + 600_000, 300_000);
  const ref = bucketize(raw, 'v', T0, T0 + 600_000, 300_000);
  assert.deepEqual(merged, ref);
  // bounded: old rollups are evicted
  for (let i = 0; i < 200; i++) rs.add({ ts: T0 + 3_600_000 + i * 60_000, v: 1 });
  assert.equal(rs.buckets.size, 100);
});

test('RingBuffer keeps the newest items in order', () => {
  const rb = new RingBuffer(3);
  [1, 2, 3, 4, 5].forEach((x) => rb.push(x));
  assert.deepEqual(rb.toArray(), [3, 4, 5]);
  assert.deepEqual(rb.last(2), [4, 5]);
  assert.equal(rb.latest(), 5);
  assert.equal(rb.length, 3);
  assert.throws(() => new RingBuffer(0), RangeError);
});
