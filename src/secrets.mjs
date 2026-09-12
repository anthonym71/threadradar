/**
 * Encryption at rest for connector credentials (Slack/Telegram bot tokens, Gmail refresh tokens).
 * Key source: TOKEN_ENCRYPTION_KEY (64 hex chars) or, if absent, a key generated once and
 * stored next to the database with owner-only permissions. Losing the key means every user
 * has to reconnect their integrations; nothing else is lost.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function resolveKey(env, dbPath) {
  if (/^[a-f0-9]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY || '')) return { key: env.TOKEN_ENCRYPTION_KEY, source: 'env' };
  if (env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY must contain 64 hex characters (npm run keygen)');
  if (!dbPath || dbPath === ':memory:') return { key: randomBytes(32).toString('hex'), source: 'ephemeral' };
  const file = join(dirname(dbPath), 'secret.key');
  if (existsSync(file)) {
    const key = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(key)) return { key, source: 'file' };
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, key + '\n', { mode: 0o600 });
  return { key, source: 'generated' };
}

export function encrypt(text, keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || '')) throw new Error('Encryption key must contain 64 hex characters');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

export function decrypt(ciphertext, keyHex) {
  const data = Buffer.from(ciphertext, 'base64');
  const c = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), data.subarray(0, 12));
  c.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([c.update(data.subarray(28)), c.final()]).toString('utf8');
}
