/**
 * Password hashing with Node's built-in scrypt (memory-hard KDF), a random
 * 16-byte salt per user, and a constant-time comparison on verify.
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
// N=2^14, r=8, p=1 is the commonly recommended interactive-login cost.
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** NFKC-normalise so visually identical passwords hash identically. */
const normalise = (password) => password.normalize('NFKC');

/** @returns {Promise<{ salt: string, hash: string }>} hex-encoded */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(normalise(password), salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/** @returns {Promise<boolean>} */
export async function verifyPassword(password, saltHex, hashHex) {
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(normalise(password), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTIONS);
  // timingSafeEqual throws on length mismatch, so check length first.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A throwaway hash used when a login names a user that doesn't exist: we
 * still run scrypt once so the response time doesn't reveal which usernames
 * are registered.
 */
export const DUMMY_CREDENTIALS = await hashPassword(randomBytes(12).toString('hex'));
