/**
 * Background worker. Runs inside the server process (no browser needed) and does
 * three independent things:
 *   1. Analysis queue  - claims due topics and classifies them (every second).
 *   2. Routine review  - every `reviewMinutes` re-queues every topic in a space.
 *   3. Critical intake - polls live connectors every CRITICAL_POLL_SECONDS while
 *                        critical checks are on; new messages are analysed at once.
 * The review cadence never delays critical detection: ingest() schedules a topic
 * for immediate analysis whenever criticalChecks is enabled.
 */
import { hash } from './util.mjs';
import { classify, rules } from './analysis.mjs';
import { alertBlockReason } from './policy.mjs';
import { pollSlack, slackPollingReady } from './connectors/slack.mjs';
import { pollTelegram, sendTelegram, telegramAlertsReady, telegramWebhookMode, alertChatFingerprint } from './connectors/telegram.mjs';
import { pollGmail, gmailReady } from './connectors/gmail.mjs';

export const SPACES = ['demo', 'live'];

export function createWorker({ store, env, fetcher = fetch, log = () => {} }) {
  const criticalPollMs = Math.max(15, Number(env.CRITICAL_POLL_SECONDS || 60)) * 1000;
  const state = { busy: false, pollBusy: false, stopped: false, heartbeat: null, lastPoll: {}, intervals: [] };

  function pollers() {
    return [
      { source: 'slack', ready: slackPollingReady(env), run: now => pollSlack(store, env, fetcher, now) },
      { source: 'telegram', ready: !!env.TELEGRAM_BOT_TOKEN && !telegramWebhookMode(env), run: now => pollTelegram(store, env, fetcher, now) },
      { source: 'gmail', ready: gmailReady(env) && !!store.get('gmail.auth'), run: now => pollGmail(store, env, fetcher, now) }
    ];
  }

  async function analyze(j, now = new Date()) {
    const messages = store.messages(j.space, j.id);
    if (!messages.length) { store.finish(j); return null; }
    const settings = store.settings(j.space);
    let r, error = null;
    if (messages.every(m => m.deleted)) {
      r = { classification: 'FYI', relevant: false, policyMatch: false, unresolved: false, title: 'Source removed', summary: 'The source messages were deleted or left the watched label.', whyRelevant: 'Retained as an audit item; no action requested.', actionRequired: null, dueAt: null, whyCritical: null, evidenceIds: [], analyzer: 'Source state' };
    } else {
      try { r = await classify(messages, settings, env, fetcher, now); }
      catch (e) {
        error = e.message || 'AI analysis failed';
        // Do not silently drop the topic: fall back to rules and say so.
        r = { ...rules(messages, settings, now), analyzer: `Rules (AI error fallback: ${error})` };
        if (r.classification === 'IGNORE' && r.relevant) r.classification = 'REVIEW';
      }
    }
    // A newer edit/resolution may have arrived during the model call; never publish stale analysis.
    const current = store.jobGeneration(j.space, j.id);
    if (current === null || current !== j.generation) { store.release(j.space, j.id); return null; }

    const signature = hash([r.classification, r.dueAt, r.unresolved, r.actionRequired]);
    const old = store.item(j.space, j.id);
    const live = messages.filter(m => !m.deleted);
    const item = {
      ...r,
      id: j.id,
      signature,
      status: old?.signature === signature ? old.status : 'open',
      sources: [...new Set(messages.map(m => m.source))],
      conversation: messages[0].conversation,
      conversationName: messages[0].conversationName || messages[0].conversation,
      synthetic: messages.some(m => m.synthetic),
      messageCount: live.length,
      participants: [...new Set(live.map(m => m.sender))].slice(0, 8),
      lastMessageAt: live.at(-1)?.sentAt || messages.at(-1).sentAt,
      firstSeenAt: old?.firstSeenAt || now.toISOString(),
      updatedAt: now.toISOString(),
      sourceUrl: messages.findLast(m => !m.deleted && m.sourceUrl)?.sourceUrl || null
    };
    store.saveItem(j.space, item);
    store.run(j.space, 'analysis', { topic: item.conversationName, classification: item.classification, analyzer: item.analyzer, error });

    await maybeNotify(j, item, r, messages, now);
    store.set(`analysis:${j.space}`, now.toISOString());
    if (error) store.fail(j, error); else store.finish(j);
    return item;
  }

  async function maybeNotify(j, item, r, messages, now) {
    const settings = store.settings(j.space); // re-read: user may have paused during analysis
    if (r.classification !== 'CRITICAL' || !settings.criticalChecks || settings.paused || item.status !== 'open') return;
    const receiptId = hash([j.id, item.signature]);
    const receipts = store.notifications(j.space);
    if (receipts.some(n => n.id === receiptId)) return; // one alert per distinct critical state
    const recent = messages.some(m => !m.deleted && !m.backfill && now.getTime() - Date.parse(m.receivedAt) < 15 * 60000 && now.getTime() - Date.parse(m.sentAt) < 24 * 3600000);
    const cooldown = receipts.some(n => n.itemId === j.id && ['pending', 'provider_accepted', 'unknown'].includes(n.state) && now.getTime() - Date.parse(n.at) < 30 * 60000);
    const base = { id: receiptId, itemId: j.id, title: item.title, summary: item.summary, at: now.toISOString(), channel: 'in_app', state: 'in_app', detail: 'Shown in the in-app alert feed.' };
    if (j.space === 'demo') {
      store.notification(j.space, receiptId, { ...base, state: 'simulated', detail: 'Demo mode: alert shown here only. Nothing was sent outside this app.' });
      return;
    }
    let reason = alertBlockReason(r, settings, now);
    if (!reason && !recent) reason = 'Source messages are older than the live-alert window (15 minutes) or came from a backfill.';
    if (!reason && cooldown) reason = 'An alert for this topic was sent less than 30 minutes ago.';
    if (!reason && env.ALLOW_LIVE_SEND !== 'true') reason = 'ALLOW_LIVE_SEND is not "true" on the server.';
    if (!reason && !telegramAlertsReady(env)) reason = 'TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID are not configured.';
    if (!reason && store.get('telegram.verified') !== alertChatFingerprint(env)) reason = 'The private Telegram chat has not been verified (send /start to the bot).';
    if (reason) { store.notification(j.space, receiptId, { ...base, detail: `In-app only. External alert not sent: ${reason}` }); return; }

    store.notification(j.space, receiptId, { ...base, channel: 'telegram', state: 'pending', detail: 'Sending to Telegram...' });
    const text = `ThreadRadar: needs your attention\n\n${item.title}\n\n${item.summary}\n\nWhy now: ${r.whyCritical}\nDeadline: ${r.dueAt}\nSource: ${item.conversationName}\nOpen: ${env.APP_ORIGIN}`;
    const delivery = await sendTelegram(env, text, fetcher);
    store.notification(j.space, receiptId, { ...base, channel: 'telegram', ...delivery, at: now.toISOString() });
    store.run(j.space, 'alert', { topic: item.conversationName, state: delivery.state, detail: delivery.detail });
    log(`alert ${delivery.state}: ${item.title}`);
  }

  /** Analysis + routine review timers. Safe to call concurrently (re-entrancy guarded). */
  async function tick(now = Date.now()) {
    if (state.busy || state.stopped) return;
    state.busy = true;
    try {
      for (const space of SPACES) {
        const s = store.settings(space);
        if (s.paused || !s.reviewMinutes) continue;
        const next = store.get(`review:${space}`);
        if (next === null) store.set(`review:${space}`, now + s.reviewMinutes * 60000);
        else if (next <= now) {
          store.queueAll(space, now);
          store.set(`review:${space}`, now + s.reviewMinutes * 60000);
          store.run(space, 'review', { detail: `Routine review queued ${store.queued(space)} topics.` });
        }
      }
      for (let n = 0; n < 5; n++) { const j = store.claim(now); if (!j) break; await analyze(j, new Date(now)); }
      state.heartbeat = new Date().toISOString();
      store.set('worker.heartbeat', state.heartbeat);
    } finally { state.busy = false; }
  }

  /** Live connector polling. Interval depends on whether critical checks are on. */
  async function pollTick(force = false, now = Date.now()) {
    if (state.pollBusy || state.stopped) return {};
    const s = store.settings('live');
    if (s.paused && !force) return {};
    const every = s.criticalChecks ? criticalPollMs : s.reviewMinutes ? Math.max(criticalPollMs, s.reviewMinutes * 60000) : Infinity;
    state.pollBusy = true;
    const results = {};
    try {
      for (const p of pollers()) {
        if (!p.ready) continue;
        const last = state.lastPoll[p.source] || 0;
        if (!force && now - last < every) continue;
        state.lastPoll[p.source] = now;
        try {
          results[p.source] = await p.run(now);
          if (results[p.source]) store.run('live', 'poll', { source: p.source, ingested: results[p.source] });
        } catch (e) {
          const previous = store.get(`source:${p.source}`, {});
          const message = e.slack ? `Slack API error: ${e.slack}` : e.message || 'Poll failed';
          store.set(`source:${p.source}`, { ...previous, status: 'error', error: message, lastAttempt: new Date(now).toISOString() });
          store.run('live', 'poll', { source: p.source, error: message });
          state.lastPoll[p.source] = now + 4 * 60000; // back off
          results[p.source] = { error: message };
        }
      }
    } finally { state.pollBusy = false; }
    return results;
  }

  function start() {
    state.intervals = [
      setInterval(() => tick().catch(e => log(`tick failed: ${e.message}`)), 1000),
      setInterval(() => pollTick().catch(e => log(`poll failed: ${e.message}`)), 5000)
    ];
    for (const i of state.intervals) i.unref?.();
  }
  async function stop() {
    state.stopped = true;
    state.intervals.forEach(clearInterval);
    while (state.busy || state.pollBusy) await new Promise(r => setTimeout(r, 10));
  }
  const status = () => ({ running: state.intervals.length > 0 && !state.stopped, heartbeat: state.heartbeat, busy: state.busy, polling: state.pollBusy, criticalPollSeconds: criticalPollMs / 1000, lastPoll: { ...state.lastPoll } });

  return { analyze, tick, pollTick, start, stop, status, pollers };
}
