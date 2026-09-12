/**
 * Slack connector (per user). Config: { botToken, channelIds, backfillHours }.
 * Polling uses conversations.history / conversations.replies for the configured
 * channel IDs. Works from a laptop with no public URL.
 * Bot scopes: channels:history, channels:read, users:read (+ groups:* for private channels).
 * The bot must be a member of each channel.
 */
import { createHmac } from 'node:crypto';
import { equal, list, requestJson } from '../util.mjs';

export function validateSlackConfig(input, existing = null) {
  const botToken = typeof input.botToken === 'string' && input.botToken && !/^•+/.test(input.botToken) ? input.botToken.trim() : existing?.botToken;
  if (!botToken || !/^xox[bp]-/.test(botToken)) throw new Error('Slack bot token must start with xoxb-');
  const channelIds = list(input.channelIds);
  if (!channelIds.length || channelIds.some(c => !/^[CGD][A-Z0-9]{1,}$/i.test(c))) throw new Error('Enter at least one Slack channel ID (e.g. C0123ABCD)');
  const backfillHours = Number(input.backfillHours ?? existing?.backfillHours ?? 24);
  if (!Number.isFinite(backfillHours) || backfillHours < 1 || backfillHours > 24 * 90) throw new Error('Backfill must be between 1 hour and 90 days');
  return { botToken, channelIds: channelIds.join(','), backfillHours };
}

export function verifySlack(raw, headers, secret, now = Date.now()) {
  const ts = headers['x-slack-request-timestamp'];
  if (!secret || !/^\d+$/.test(ts || '') || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  return equal(`v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`, headers['x-slack-signature']);
}

const permalink = (team, channel, ts) => `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${ts}`;

export function toRaw(team, channel, msg, senderName, channelName) {
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

/** Poll configured channels since the stored cursor. Returns number of ingested messages. */
export async function pollSlack(store, space, config, fetcher = fetch, now = Date.now()) {
  const api = async (method, params = {}) => {
    const data = await requestJson(fetcher, `https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${config.botToken}` } });
    if (!data.ok) { const e = new Error(`Slack ${method}: ${data.error || 'failed'}`); e.slack = data.error; throw e; }
    return data;
  };
  let team = store.get(`slack.team:${space}`);
  if (!team) { const auth = await api('auth.test'); team = auth.team_id; store.set(`slack.team:${space}`, team); }
  const userName = async id => {
    if (!id) return 'unknown';
    const cached = store.get(`slack.user:${space}:${id}`);
    if (cached) return cached;
    try { const u = await api('users.info', { user: id }); const name = u.user?.real_name || u.user?.name || id; store.set(`slack.user:${space}:${id}`, name); return name; }
    catch { return id; }
  };
  let ingested = 0;
  for (const channel of list(config.channelIds)) {
    let channelName = store.get(`slack.channel:${space}:${channel}`);
    if (!channelName) {
      try { const info = await api('conversations.info', { channel }); channelName = info.channel?.name || channel; store.set(`slack.channel:${space}:${channel}`, channelName); }
      catch { channelName = channel; }
    }
    const saved = store.get(`slack.cursor:${space}:${channel}`);
    const backfill = !saved;
    const cursor = saved || String((now - Number(config.backfillHours || 24) * 3600000) / 1000);
    let newest = cursor;
    const history = await api('conversations.history', { channel, oldest: cursor, limit: '200' });
    const raws = [];
    for (const msg of history.messages || []) {
      if (msg.ts && Number(msg.ts) > Number(newest)) newest = msg.ts;
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
    if (raws.length) ingested += store.ingest(space, raws, { now });
    store.set(`slack.cursor:${space}:${channel}`, newest);
  }
  return { ingested, team };
}
