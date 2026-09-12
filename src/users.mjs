/**
 * User accounts. Passwords are hashed with scrypt (N=2^14) and a per-user salt.
 * Roles: 'admin' (can manage users) or 'user'. The first account created is the admin.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD = 10;

export function validateUsername(u) {
  const name = String(u || '').trim().toLowerCase();
  if (!USERNAME.test(name)) throw new Error('Username must be 3-32 characters: letters, digits, dot, dash or underscore');
  return name;
}
export function validatePassword(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD || p.length > 200) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  return p;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = String(stored).split('$');
    const expected = Buffer.from(hash, 'base64');
    const actual = scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export const publicUser = u => u ? { id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null } : null;
