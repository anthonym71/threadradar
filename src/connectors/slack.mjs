/**
 * Slack connector. Two intake modes:
 *  - Polling (SLACK_BOT_TOKEN): conversations.history / conversations.replies for the
 *    configured channel IDs. Works from a laptop with no public URL.
 *  - Events API webhook (SLACK_SIGNING_SECRET): POST /webhooks/slack, signature-verified.
 * Bot scopes needed for polling: channels:history, channels:read, users:read
 * (add groups:history for private channels). The bot must be a member of each channel.
 */
import { createHmac } from 'node:crypto';
import { equal, list, hash, requestJson } from '../util.mjs';

export function verifySlack(raw, headers, secret, now = Date.now()) {
  const ts = headers['x-slack-request-timestamp'];
  if (!secret || !/^\d+$/.test(ts || '') || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  return equal(`v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`, headers['x-slack-signature']);
}

const permalink = (team, channel, ts) => `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${ts}`;

/** Normalise an Events API payload into a raw message (or null to ignore). */
export function slackEventMessage(p, env, store) {
  if (env.SLACK_TEAM_ID && p.team_id !== env.SLACK_TEAM_ID) return null;
  const e = p.event || {};
  if (e.type !== 'message' || !list(env.SLACK_CHANNEL_IDS).includes(e.channel) || e.bot_id) return null;
  const msg = e.subtype === 'message_changed' ? e.message : e;
  if (e.subtype === 'message_deleted') {
    const old = store.message('live', hash(['slack', p.team_id, `${e.channel}:${e.deleted_ts}`]));
    return old ? { ...old, text: '', deleted: true } : null;
  }
  if (e.subtype && !['message_changed', 'thread_broadcast'].includes(e.subtype)) return null;
  if (!msg?.ts || !msg.text || msg.bot_id || !Number.isFinite(Number(msg.ts))) return null;
  return toRaw(p.team_id, e.channel, msg, msg.user || 'unknown', store.get(`slack.channel:${e.channel}`) || e.channel);
}

function toRaw(team, channel, msg, senderName, channelName) {
  const thread = msg.thread_ts || msg.ts;
  return {
    source: 'slack',
    account: team,
    conversation: `${channel}:${thread}`,
    conversationName: `#${channelName}${msg.thread_ts && msg.thread_ts !== msg.ts ? ' (thread)' : ''}`,
    messageId: `${channel}:${msg.ts}`,
    sender: senderName,
    text: msg.text,
    sentAt: new Date(Number(msg.ts) * 1000).toISOString(),
    sourceUrl: permalink(team, channel, thread)
  };
}

export const slackPollingReady = env => !!(env.SLACK_BOT_TOKEN && list(env.SLACK_CHANNEL_IDS).length);
export const slackWebhookReady = env => !!(env.SLACK_SIGNING_SECRET && list(env.SLACK_CHANNEL_IDS).length);

/** Poll configured channels since the stored cursor. Returns number of ingested messages. */
export async function pollSlack(store, env, fetcher = fetch, now = Date.now()) {
  if (!slackPollingReady(env)) return 0;
  const api = async (method, params = {}) => {
    const data = await requestJson(fetcher, `https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
    if (!data.ok) { const e = new Error(`Slack ${method}: ${data.error || 'failed'}`); e.slack = data.error; throw e; }
    return data;
  };
  let team = store.get('slack.team');
  if (!team) { const auth = await api('auth.test'); team = auth.team_id; store.set('slack.team', team); }
  const userName = async id => {
    if (!id) return 'unknown';
    const cached = store.get(`slack.user:${id}`);
    if (cached) return cached;
    try {
      const u = await api('users.info', { user: id });
      const name = u.user?.real_name || u.user?.name || id;
      store.set(`slack.user:${id}`, name);
      return name;
    } catch { return id; }
  };
  let ingested = 0;
  const firstRun = min => new Date(now - min * 60000).getTime() / 1000;
  for (const channel of list(env.SLACK_CHANNEL_IDS)) {
    let channelName = store.get(`slack.channel:${channel}`);
    if (!channelName) {
      try { const info = await api('conversations.info', { channel }); channelName = info.channel?.name || channel; store.set(`slack.channel:${channel}`, channelName); }
      catch { channelName = channel; }
    }
    const cursor = store.get(`slack.cursor:${channel}`) || String(firstRun(Number(env.SLACK_BACKFILL_MINUTES || 1440)));
    const backfill = !store.get(`slack.cursor:${channel}`);
    let newest = cursor;
    const history = await api('conversations.history', { channel, oldest: cursor, limit: '200' });
    const raws = [];
    for (const msg of history.messages || []) {
      if (!msg.ts || Number(msg.ts) > Number(newest)) newest = msg.ts || newest;
      if (msg.subtype && msg.subtype !== 'thread_broadcast') continue;
      if (msg.bot_id || !msg.text) continue;
      raws.push({ ...toRaw(team, channel, msg, await userName(msg.user), channelName), backfill });
      if (msg.reply_count > 0) {
        const replies = await api('conversations.replies', { channel, ts: msg.ts, oldest: cursor, limit: '100' });
        for (const r of replies.messages || []) {
          if (r.ts === msg.ts || r.bot_id || !r.text) continue;
          if (Number(r.ts) > Number(newest)) newest = r.ts;
          raws.push({ ...toRaw(team, channel, r, await userName(r.user), channelName), backfill });
        }
      }
    }
    if (raws.length) ingested += store.ingest('live', raws, { now });
    store.set(`slack.cursor:${channel}`, newest);
  }
  store.set('source:slack', { status: 'connected', mode: 'polling', lastSync: new Date(now).toISOString(), error: null, team });
  return ingested;
}
