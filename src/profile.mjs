/**
 * Owner profile + monitoring settings. One owner per space ("demo" or "live").
 * Routine review cadence (reviewMinutes) and critical monitoring (criticalChecks)
 * are independent: critical checks analyse new messages as soon as they arrive.
 */
export const REVIEW_INTERVALS = [0, 15, 60, 240, 1440];

export const defaults = () => ({
  name: 'Anthony',
  responsibilities: 'Client launches, AI automation partnerships, GoHighLevel delivery',
  priorities: 'client launch, approval, proposal, partnership, production incident, invoice',
  importantPeople: 'Dana, Priya, Tom',
  ignoreTopics: 'lunch, memes, cold sales, newsletter',
  criticalRules: 'Client launch blockers, production incidents or approvals that need my decision before a deadline.',
  criticalWindowMinutes: 60,
  reviewMinutes: 60,
  criticalChecks: true,
  externalAlerts: false,
  paused: false,
  timezone: 'Europe/Dublin',
  quietStart: 23,
  quietEnd: 7,
  criticalOverride: false
});

export function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Settings must be an object');
  const out = {};
  for (const key of ['name', 'responsibilities', 'priorities', 'importantPeople', 'ignoreTopics', 'criticalRules', 'timezone']) {
    if (typeof input[key] !== 'string' || input[key].length > 2000) throw new Error(`Invalid ${key}`);
    out[key] = input[key].trim();
  }
  if (!out.name) throw new Error('Name is required');
  try { new Intl.DateTimeFormat('en', { timeZone: out.timezone }).format(); } catch { throw new Error('Invalid timezone'); }
  for (const key of ['criticalChecks', 'externalAlerts', 'paused', 'criticalOverride']) {
    if (typeof input[key] !== 'boolean') throw new Error(`Invalid ${key}`);
    out[key] = input[key];
  }
  for (const [key, min, max] of [['criticalWindowMinutes', 1, 1440], ['quietStart', 0, 23], ['quietEnd', 0, 23]]) {
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new Error(`Invalid ${key}`);
    out[key] = input[key];
  }
  if (!REVIEW_INTERVALS.includes(input.reviewMinutes)) throw new Error('Invalid review interval');
  out.reviewMinutes = input.reviewMinutes;
  return out;
}
