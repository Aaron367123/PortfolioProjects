/**
 * Entry point: load config, open the database (running migrations), and
 * start listening. All app wiring lives in src/app.js.
 */
import { existsSync } from 'node:fs';
import { loadConfig } from './src/config.js';
import { openDatabase } from './src/db/index.js';
import { seedDemoData } from './src/db/seed.js';
import { createApp } from './src/app.js';

// Node 20.12+ can read .env files natively, so no dotenv dependency.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = openDatabase(config.dbPath);

if (config.seedIfEmpty) {
  const { seeded } = await seedDemoData(db, { demoPassword: process.env.DEMO_PASSWORD || undefined });
  if (seeded) console.log('Database was empty — demo data added.');
}

const app = createApp({ db, config });
const server = app.listen(config.port, config.host, () => {
  console.log(`Myousik 2.0 listening on http://${config.host}:${config.port} (${config.nodeEnv}, db: ${config.dbPath})`);
});

// Close cleanly on Ctrl+C / docker stop so SQLite's WAL is checkpointed.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
