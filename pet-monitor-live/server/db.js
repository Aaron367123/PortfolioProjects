/**
 * Persistence with Node's built-in SQLite (node:sqlite, DatabaseSync).
 * Node prints "ExperimentalWarning: SQLite is an experimental feature" on first use;
 * that is expected (see README).
 *
 * Tables: readings (raw + calibrated), events (visits), alerts, settings (config JSON).
 * History is downsampled in SQL: one row per time bucket with MIN/AVG/MAX/COUNT.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  temperature_raw REAL,
  weight_raw INTEGER,
  ph_voltage REAL,
  faces INTEGER,
  temperature_c REAL,      -- NULL when the sample was rejected as faulty
  weight_g REAL,
  ph REAL,
  presence INTEGER,
  faults TEXT,
  replay INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS readings_device_ts ON readings (device_id, ts);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, type TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_device_ts ON events (device_id, ts);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, key TEXT NOT NULL, rule TEXT, severity TEXT,
  status TEXT NOT NULL, ts INTEGER NOT NULL, resolved_ts INTEGER, acknowledged INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts (ts);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** API metric name -> column. A whitelist, so the column name in SQL is never user input. */
export const METRIC_COLUMNS = {
  temperatureC: 'temperature_c',
  pH: 'ph',
  weightG: 'weight_g',
  phVoltage: 'ph_voltage',
  weightRaw: 'weight_raw',
};

const bool = (v) => (v == null ? null : v ? 1 : 0);

export function openStore(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);

  const insertReading = db.prepare(`INSERT INTO readings
    (device_id, ts, received_at, temperature_raw, weight_raw, ph_voltage, faces, temperature_c, weight_g, ph, presence, faults, replay)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEvent = db.prepare('INSERT OR REPLACE INTO events (id, device_id, type, ts, data) VALUES (?, ?, ?, ?, ?)');
  const upsertAlert = db.prepare(`INSERT INTO alerts (id, device_id, key, rule, severity, status, ts, resolved_ts, acknowledged, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, resolved_ts = excluded.resolved_ts,
      acknowledged = excluded.acknowledged, data = excluded.data`);
  const historyStmts = new Map();

  /** Runs fn inside one transaction (one fsync per HTTP batch instead of per row). */
  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    db,
    transaction,

    insertReadings(readings) {
      for (const r of readings) {
        insertReading.run(r.deviceId, r.ts, r.receivedAt, r.temperatureRaw, r.weightRaw, r.phVoltage, r.faces,
          r.temperatureC, r.weightG, r.pH, bool(r.presence), r.faults?.length ? r.faults.join(',') : null, r.replay ? 1 : 0);
      }
    },

    saveEvent(ev) {
      insertEvent.run(ev.id, ev.deviceId, ev.type, ev.ts, JSON.stringify(ev));
    },

    saveAlert(a) {
      upsertAlert.run(a.id, a.deviceId, a.key, a.rule ?? null, a.severity ?? null, a.status, a.ts, a.resolvedTs ?? null,
        a.acknowledged ? 1 : 0, JSON.stringify(a));
    },

    /** Downsampled history: [{t, min, avg, max, n}], t = bucket start. */
    history({ metric, deviceId, from, to, bucketMs }) {
      const column = METRIC_COLUMNS[metric];
      if (!column) throw new RangeError(`unknown metric ${metric}`);
      let stmt = historyStmts.get(column);
      if (!stmt) {
        stmt = db.prepare(`SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
            MIN(${column}) AS min, AVG(${column}) AS avg, MAX(${column}) AS max, COUNT(${column}) AS n
          FROM readings
          WHERE device_id = ? AND ts >= ? AND ts <= ? AND ${column} IS NOT NULL
          GROUP BY b ORDER BY b`);
        historyStmts.set(column, stmt);
      }
      return stmt.all(from, bucketMs, deviceId, from, to).map((row) => ({
        t: from + row.b * bucketMs,
        min: row.min,
        avg: row.avg,
        max: row.max,
        n: row.n,
      }));
    },

    latestDeviceId() {
      return db.prepare('SELECT device_id FROM readings ORDER BY id DESC LIMIT 1').get()?.device_id ?? null;
    },

    events({ deviceId, from = 0, to = Number.MAX_SAFE_INTEGER, type, limit = 200 } = {}) {
      const where = ['ts >= ?', 'ts <= ?'];
      const args = [from, to];
      if (deviceId) where.push('device_id = ?'), args.push(deviceId);
      if (type) where.push('type = ?'), args.push(type);
      const rows = db.prepare(`SELECT data FROM events WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit);
      return rows.map((r) => JSON.parse(r.data)).reverse();
    },

    alerts({ status, limit = 100 } = {}) {
      const rows = status
        ? db.prepare('SELECT data FROM alerts WHERE status = ? ORDER BY ts DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT data FROM alerts ORDER BY ts DESC LIMIT ?').all(limit);
      return rows.map((r) => JSON.parse(r.data));
    },

    acknowledgeAlert(id) {
      const row = db.prepare('SELECT data FROM alerts WHERE id = ?').get(id);
      if (!row) return null;
      const alert = { ...JSON.parse(row.data), acknowledged: true };
      this.saveAlert(alert);
      return alert;
    },

    loadConfig() {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'config'").get();
      return row ? JSON.parse(row.value) : null;
    },

    saveConfig(config) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(config));
    },

    /** Deletes readings older than `beforeTs`; returns rows removed. */
    prune(beforeTs) {
      return Number(db.prepare('DELETE FROM readings WHERE ts < ?').run(beforeTs).changes);
    },

    close() {
      db.close();
    },
  };
}
