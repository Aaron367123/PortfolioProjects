/**
 * Process settings from environment variables (see .env.example).
 * Monitor thresholds are NOT here - they live in shared/config.js and are edited at
 * runtime through PUT /api/config (persisted in SQLite).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_DEVICE_KEY = 'dev-device-key';

/**
 * DEVICE_KEYS="pi-kitchen:secret1,sim-1:secret2" -> Map(deviceId -> key).
 * Unset => development mode: any device id may post with the documented dev key.
 */
export function parseDeviceKeys(value) {
  const keys = new Map();
  if (!value || !value.trim()) {
    keys.set('*', DEV_DEVICE_KEY);
    return { keys, devMode: true };
  }
  for (const pair of value.split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) throw new Error(`DEVICE_KEYS entry "${pair}" must look like deviceId:key`);
    keys.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return { keys, devMode: false };
}

export function loadSettings(env = process.env) {
  const { keys, devMode } = parseDeviceKeys(env.DEVICE_KEYS);
  return {
    port: Number(env.PORT ?? 5602),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.DB_PATH ?? path.join(ROOT_DIR, 'data', 'pet-monitor.db'),
    deviceKeys: keys,
    devMode,
    adminToken: env.ADMIN_TOKEN || null,
    retentionDays: Number(env.RETENTION_DAYS ?? 30),
    publicDir: path.join(ROOT_DIR, 'public'),
    sharedDir: path.join(ROOT_DIR, 'shared'),
  };
}
