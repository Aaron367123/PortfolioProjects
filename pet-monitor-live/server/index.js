/**
 * Entry point: `npm start` (reads .env if present).
 */
import { createApp } from './app.js';
import { DEV_DEVICE_KEY } from './settings.js';

const app = createApp({ verbose: process.env.VERBOSE === '1' });
const port = await app.listen();
const { host, devMode, dbPath, adminToken } = app.opts;

console.log(`Pet Monitor Live listening on http://${host}:${port}/`);
console.log(`  WebSocket   ws://${host}:${port}/ws`);
console.log(`  Database    ${dbPath}`);
if (devMode) console.log(`  Device auth DEVELOPMENT MODE - any deviceId with X-Device-Key: ${DEV_DEVICE_KEY} (set DEVICE_KEYS to lock down)`);
if (!adminToken) console.log('  Admin       open (set ADMIN_TOKEN to protect config changes and acknowledgements)');

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received - shutting down`);
  const force = setTimeout(() => process.exit(1), 3000);
  force.unref();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
