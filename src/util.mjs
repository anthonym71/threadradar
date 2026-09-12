import { createHash, timingSafeEqual } from 'node:crypto';

/** Stable SHA-256 of a string or JSON-serialisable value. */
export const hash = value =>
  createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Constant-time string equality. */
export function equal(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "a, b ,c" -> ["a","b","c"] */
export const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

export const nowIso = () => new Date().toISOString();

/** fetch JSON with timeout; throws on non-2xx with .status */
export async function requestJson(fetcher, url, options = {}) {
  const res = await fetcher(url, { signal: AbortSignal.timeout(15000), ...options });
  if (!res.ok) {
    const e = new Error(`Provider HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}
