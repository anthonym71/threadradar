/**
 * Notification policy: when may a CRITICAL result leave the app as a private alert?
 * Everything here is deliberately conservative. A false alert costs trust.
 */
export function localHour(now, timezone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

export function inQuietHours(settings, now = new Date()) {
  const { quietStart: a, quietEnd: b } = settings;
  if (a === b) return false;
  const h = localHour(now, settings.timezone);
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/** Explains why an external alert would be blocked, or returns null when allowed. */
export function alertBlockReason(result, settings, now = new Date()) {
  if (settings.paused) return 'Monitoring is paused.';
  if (!settings.criticalChecks) return 'Critical monitoring is switched off.';
  if (!settings.externalAlerts) return 'External alerts are switched off in settings.';
  if (result.classification !== 'CRITICAL') return 'Only CRITICAL items are sent externally.';
  if (!result.relevant || !result.policyMatch || !result.unresolved || !result.actionRequired || !result.evidenceIds?.length) return 'Result does not satisfy the critical policy.';
  if (inQuietHours(settings, now) && !settings.criticalOverride) return 'Quiet hours are active and critical override is off.';
  return null;
}

export const mayNotify = (result, settings, now = new Date()) => alertBlockReason(result, settings, now) === null;
