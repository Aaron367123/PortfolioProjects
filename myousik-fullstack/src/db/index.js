/**
 * Database access: opens SQLite through Node's built-in `node:sqlite`
 * (no native npm modules to compile) and applies pending migrations.
 *
 * DatabaseSync is synchronous. For a single-process app with small queries
 * that is fine and keeps route handlers simple; a busier service would move
 * to a pooled async driver or a separate database server.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Open (or create) the database and bring its schema up to date.
 * @param {string} file  path to the .db file, or ":memory:" for tests
 */
export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;'); // SQLite leaves FK enforcement off by default
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

/**
 * Apply every *.sql file in migrations/ that hasn't been applied yet, in
 * filename order, each inside its own transaction.
 */
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
  }
}

/**
 * Run `fn` inside BEGIN/COMMIT, rolling back if it throws.
 * Used wherever several statements must succeed or fail together.
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
