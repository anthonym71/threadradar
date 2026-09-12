/**
 * Background worker. Runs inside the server process (no browser needed) and does
 * three independent things for every user:
 *   1. Analysis queue  - claims due topics and classifies them (every second).
 *   2. Routine review  - every `reviewMinutes` re-queues every topic in a space.
 *   3. Critical intake - polls each user's connectors every CRITICAL_POLL_SECONDS while
 *                        critical checks are on; new messages are analysed at once.
 * The review cadence never delays critical detection: ingest() schedules a topic
 * for immediate analysis whenever criticalChecks is enabled.
 */
import { hash } from './util.mjs';
import { classify, rules } from './analysis.mjs';
import { alertBlockReason } from './policy.mjs';
import { spaceOf, parseSpace } from './store.mjs';
import { pollSlack } from './connectors/slack.mjs';
import { pollTelegram, sendTelegram, alertChatFingerprint } from './connectors/telegram.mjs';
import { pollGmail, gmailAppReady } from './connectors/gmail.mjs';

export function createWorker({ store, env, fetcher = fetch, log = () => {} }) {
  const criticalPollMs = Math.max(15, Number(env.CRITICAL_POLL_SECONDS || 60)) * 1000;
  const state = { busy: false, pollBusy: false, stopped: false, heartbeat: null, lastPoll: {}, intervals: [] };

  /** Pollers for one user, derived from their saved connectors. */
  function pollersFor(userId) {
    const space = spaceOf('live', userId);
    return store.connectors(userId).map(c => {
      if (c.source === 'slack') return { source: 'slack', userId, space, ready: true, run: now => pollSlack(store, space, c.config, fetcher, now) };
      if (c.source === 'telegram') return { source: 'telegram', userId, space, ready: true, run: now => pollTelegram(store, space, c.config, fetcher, now) };
      if (c.source === 'gmail') return { source: 'gmail', userId, space, ready: gmailAppReady(env) && !!c.config.refresh, run: now => pollGmail(store, space, c.config, env, fetcher, now) };
      return null;
    }).filter(Boolean);
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
        r = { ...rules(messages, settings, now), analyzer: `Rules (AI error fallback: ${error})` };
        if (r.classification === 'IGNORE' && r.relevant) r.classification = 'REVIEW';
      }
    }
    const current = store.jobGeneration(j.space, j.id);
    if (current === null || current !== j.generation) { store.release(j.space, j.id); return null; }

    const signature = hash([r.classification, r.dueAt, r.unresolved, r.actionRequired]);
    const old = store.item(j.space, j.id);
    const live = messages.filter(m => !m.deleted);
    const item = {
      ...r, id: j.id, signature,
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
    const settings = store.settings(j.space);
    if (r.classification !== 'CRITICAL' || !settings.criticalChecks || settings.paused || item.status !== 'open') return;
    const { mode, userId } = parseSpace(j.space);
    const receiptId = hash([j.id, item.signature]);
    const receipts = store.notifications(j.space);
    if (receipts.some(n => n.id === receiptId)) return;
    const recent = messages.some(m => !m.deleted && !m.backfill && now.getTime() - Date.parse(m.receivedAt) < 15 * 60000 && now.getTime() - Date.parse(m.sentAt) < 24 * 3600000);
    const cooldown = receipts.some(n => n.itemId === j.id && ['pending', 'provider_accepted', 'unknown'].includes(n.state) && now.getTime() - Date.parse(n.at) < 30 * 60000);
    const base = { id: receiptId, itemId: j.id, title: item.title, summary: item.summary, at: now.toISOString(), channel: 'in_app', state: 'in_app', detail: 'Shown in the in-app alert feed.' };
    if (mode === 'demo') { store.notification(j.space, receiptId, { ...base, state: 'simulated', detail: 'Demo mode: alert shown here only. Nothing was sent outside this app.' }); return; }
    const tg = store.connector(userId, 'telegram')?.config;
    let reason = alertBlockReason(r, settings, now);
    if (!reason && !recent) reason = 'Source messages are older than the live-alert window (15 minutes) or came from a backfill.';
    if (!reason && cooldown) reason = 'An alert for this topic was sent less than 30 minutes ago.';
    if (!reason && env.ALLOW_LIVE_SEND !== 'true') reason = 'ALLOW_LIVE_SEND is not "true" on the server.';
    if (!reason && !(tg?.botToken && tg?.alertChatId)) reason = 'No Telegram bot token / private chat id saved in Integrations.';
    if (!reason && store.get(`telegram.verified:${j.space}`) !== alertChatFingerprint(tg)) reason = 'The private Telegram chat has not been verified (send /start to your bot).';
    if (reason) { store.notification(j.space, receiptId, { ...base, detail: `In-app only. External alert not sent: ${reason}` }); return; }
    store.notification(j.space, receiptId, { ...base, channel: 'telegram', state: 'pending', detail: 'Sending to Telegram...' });
    const text = `ThreadRadar: needs your attention\n\n${item.title}\n\n${item.summary}\n\nWhy now: ${r.whyCritical}\nDeadline: ${r.dueAt}\nSource: ${item.conversationName}\nOpen: ${env.APP_ORIGIN}`;
    const delivery = await sendTelegram(tg, text, fetcher);
    store.notification(j.space, receiptId, { ...base, channel: 'telegram', ...delivery, at: now.toISOString() });
    store.run(j.space, 'alert', { topic: item.conversationName, state: delivery.state, detail: delivery.detail });
    log(`alert ${delivery.state}: ${item.title}`);
  }

  async function tick(now = Date.now()) {
    if (state.busy || state.stopped) return;
    state.busy = true;
    try {
      for (const space of store.spaces()) {
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

  /** Poll live connectors. `only` = { userId, source? } forces an immediate poll for one user. */
  async function pollTick(only = null, now = Date.now()) {
    if (state.pollBusy || state.stopped) return {};
    state.pollBusy = true;
    const results = {};
    try {
      const users = only ? [store.userById(only.userId)].filter(Boolean) : store.users().filter(u => !u.disabled);
      for (const u of users) {
        const s = store.settings(spaceOf('live', u.id));
        if (s.paused && !only) continue;
        const every = s.criticalChecks ? criticalPollMs : s.reviewMinutes ? Math.max(criticalPollMs, s.reviewMinutes * 60000) : Infinity;
        for (const p of pollersFor(u.id)) {
          if (!p.ready) continue;
          if (only?.source && p.source !== only.source) continue;
          const key = `${p.space}:${p.source}`;
          if (!only && now - (state.lastPoll[key] || 0) < every) continue;
          state.lastPoll[key] = now;
          try {
            const r = await p.run(now);
            store.setConnectorStatus(u.id, p.source, { status: 'connected', lastSync: new Date(now).toISOString(), error: null, ...(r.team ? { team: r.team } : {}), ...(r.verified ? { verified: true } : {}) });
            if (r.ingested) store.run(p.space, 'poll', { source: p.source, ingested: r.ingested });
            results[p.source] = { ingested: r.ingested };
          } catch (e) {
            const message = e.slack ? `Slack API error: ${e.slack}` : e.message || 'Poll failed';
            store.setConnectorStatus(u.id, p.source, { status: 'error', error: message, lastAttempt: new Date(now).toISOString() });
            store.run(p.space, 'poll', { source: p.source, error: message });
            state.lastPoll[key] = now + 4 * 60000;
            results[p.source] = { error: message };
          }
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
  async function stop() { state.stopped = true; state.intervals.forEach(clearInterval); while (state.busy || state.pollBusy) await new Promise(r => setTimeout(r, 10)); }
  const status = () => ({ running: state.intervals.length > 0 && !state.stopped, heartbeat: state.heartbeat, busy: state.busy, polling: state.pollBusy, criticalPollSeconds: criticalPollMs / 1000 });

  return { analyze, tick, pollTick, start, stop, status, pollersFor };
}
