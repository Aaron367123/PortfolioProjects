#!/usr/bin/env node
/**
 * npm run seed        -> add demo data if the library is empty
 * npm run seed:reset  -> wipe everything and re-seed
 */
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { seedDemoData, DEMO_USERNAME } from '../src/db/seed.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const reset = process.argv.includes('--reset');

const db = openDatabase(config.dbPath);
const result = await seedDemoData(db, { reset, demoPassword: process.env.DEMO_PASSWORD || undefined });
db.close();

if (result.seeded) {
  console.log(`Seeded ${result.songs} songs into ${config.dbPath}. Demo login: "${DEMO_USERNAME}" (password from DEMO_PASSWORD, see .env.example).`);
} else {
  console.log(`${config.dbPath} already has songs — nothing to do (use "npm run seed:reset" to start over).`);
}
