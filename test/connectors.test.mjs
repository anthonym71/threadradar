import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { verifySlack, pollSlack, validateSlackConfig } from '../src/connectors/slack.mjs';
import { telegramMessage, handleTelegramUpdate, pollTelegram, sendTelegram, alertChatFingerprint, validateTelegramConfig } from '../src/connectors/telegram.mjs';
import { gmailToRaw, pollGmail, validateGmailConfig } from '../src/connectors/gmail.mjs';
import { encrypt, decrypt } from '../src/secrets.mjs';
import { alertBlockReason, inQuietHours } from '../src/policy.mjs';
import { defaults } from '../src/profile.mjs';

const jsonRes = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });

// ---- Slack -------------------------------------------------------------------
test('verifySlack accepts a correctly signed body and rejects stale or forged ones', () => {
  const secret = 's3cret', ts = String(Math.floor(Date.now() / 1000)), raw = '{"a":1}';
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
  assert.equal(verifySlack(raw, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, secret), true);
  assert.equal(verifySlack(raw, { 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=bad' }, secret), false);
  assert.equal(verifySlack(raw, { 'x-slack-request-timestamp': '1', 'x-slack-signature': sig }, secret), false);
});

test('pollSlack fetches history and thread replies, resolves names, stores a cursor', async () => {
  const store = new Store(':memory:');
  store.saveSettings('live:u1', { ...defaults(), criticalChecks: true });
  const config = validateSlackConfig({ botToken: 'xoxb-test', channelIds: 'C1', backfillHours: 24 });
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push(url);
    assert.equal(opts.headers.authorization, 'Bearer xoxb-test');
    const u = new URL(url);
    if (u.pathname.endsWith('auth.test')) return jsonRes({ ok: true, team_id: 'T1' });
    if (u.pathname.endsWith('conversations.info')) return jsonRes({ ok: true, channel: { name: 'client-launch' } });
    if (u.pathname.endsWith('users.info')) return jsonRes({ ok: true, user: { real_name: 'Dana Ryan' } });
    if (u.pathname.endsWith('conversations.history')) return jsonRes({ ok: true, messages: [
      { ts: '1757678400.000100', user: 'U1', text: 'Anthony, please approve', reply_count: 1 },
      { ts: '1757678300.000100', user: 'U2', text: 'joined', subtype: 'channel_join' }
    ] });
    if (u.pathname.endsWith('conversations.replies')) return jsonRes({ ok: true, messages: [
      { ts: '1757678400.000100', user: 'U1', text: 'Anthony, please approve' },
      { ts: '1757678500.000100', user: 'U1', text: 'Deadline is 3pm', thread_ts: '1757678400.000100' }
    ] });
    throw new Error(`unexpected ${url}`);
  };
  const { ingested: n, team } = await pollSlack(store, 'live:u1', config, fetcher, 1757678460000); // one minute after the fixture root message
  assert.equal(n, 2, 'root + reply ingested, channel_join skipped');
  assert.equal(team, 'T1');
  const msgs = store.messages('live:u1');
  assert.equal(msgs[0].sender, 'Dana Ryan');
  assert.equal(msgs[0].conversationName, '#client-launch');
  assert.equal(msgs[1].conversationName, '#client-launch (thread)');
  assert.equal(new Set(msgs.map(m => m.topicId)).size, 1, 'reply shares the root topic');
  assert.equal(store.get('slack.cursor:live:u1:C1'), '1757678500.000100');
  store.close();
});

test('pollSlack surfaces API errors', async () => {
  const store = new Store(':memory:');
  const fetcher = async () => jsonRes({ ok: false, error: 'not_in_channel' });
  await assert.rejects(() => pollSlack(store, 'live:u1', { botToken: 'xoxb-x', channelIds: 'C1' }, fetcher), /not_in_channel/);
  assert.throws(() => validateSlackConfig({ botToken: 'bad', channelIds: 'C1' }), /xoxb/);
  assert.throws(() => validateSlackConfig({ botToken: 'xoxb-x', channelIds: '' }), /channel ID/);
  store.close();
});

// ---- Telegram ----------------------------------------------------------------
const tgUpdate = (over = {}, chat = {}) => ({ update_id: 1, message: { message_id: 10, date: 1757678400, text: 'hello there', from: { id: 5, first_name: 'Tom', is_bot: false }, chat: { id: -100, type: 'supergroup', title: 'Founders', ...chat }, ...over } });

test('telegramMessage accepts watched groups only and ignores bot commands', () => {
  const store = new Store(':memory:');
  const config = { chatIds: '-100' };
  const m = telegramMessage(tgUpdate(), config, store, 'live:u1');
  assert.equal(m.source, 'telegram');
  assert.equal(m.conversationName, 'Founders (Telegram)');
  assert.equal(telegramMessage(tgUpdate({}, { id: -200 }), config, store, 'live:u1'), null);
  assert.equal(telegramMessage(tgUpdate({ text: '/start' }), config, store, 'live:u1'), null);
  assert.equal(telegramMessage(tgUpdate({}, { type: 'private' }), config, store, 'live:u1'), null);
  assert.throws(() => validateTelegramConfig({ botToken: 'bad', chatIds: '-100' }), /token/);
  assert.equal(validateTelegramConfig({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatIds: '-100', backfillHours: 99 }).backfillHours, 24, 'capped at 24h');
  store.close();
});

test('handleTelegramUpdate verifies the private alert chat on /start from the owner', () => {
  const store = new Store(':memory:');
  const config = { botToken: 'tok', alertChatId: '5', chatIds: '-100' };
  const r = handleTelegramUpdate({ update_id: 2, message: { message_id: 1, date: 1757678400, text: '/start', from: { id: 5, is_bot: false }, chat: { id: 5, type: 'private' } } }, config, store, 'live:u1');
  assert.equal(r.verified, true);
  assert.equal(store.get('telegram.verified:live:u1'), alertChatFingerprint(config));
  const wrong = handleTelegramUpdate({ update_id: 3, message: { message_id: 1, date: 1, text: '/start', from: { id: 6, is_bot: false }, chat: { id: 6, type: 'private' } } }, config, store, 'live:u1');
  assert.equal(wrong.verified, false);
  store.close();
});

test('pollTelegram ingests updates and advances the offset', async () => {
  const store = new Store(':memory:');
  store.saveSettings('live:u1', { ...defaults(), criticalChecks: true });
  const config = { botToken: 'tok', chatIds: '-100', backfillHours: 24 };
  const seen = [];
  const fetcher = async url => { seen.push(url); return jsonRes({ ok: true, result: [tgUpdate(), { ...tgUpdate({ message_id: 11, text: 'second' }), update_id: 2 }] }); };
  const { ingested: n } = await pollTelegram(store, 'live:u1', config, fetcher, 1757678400000 + 60000);
  assert.equal(n, 2);
  assert.equal(store.get('telegram.offset:live:u1'), 3);
  assert.match(seen[0], /offset=0/);
  assert.equal((await pollTelegram(store, 'live:u1', config, async () => jsonRes({ ok: true, result: [] }))).ingested, 0);
  // first run ignores updates older than the backfill window
  const fresh = new Store(':memory:');
  assert.equal((await pollTelegram(fresh, 'live:u1', { ...config, backfillHours: 1 }, fetcher, 1757678400000 + 5 * 3600000)).ingested, 0);
  fresh.close();
  store.close();
});

test('sendTelegram never reports success without a provider message id', async () => {
  const env = { botToken: 'tok', alertChatId: '5' };
  assert.equal((await sendTelegram(env, 'hi', async () => jsonRes({ ok: true, result: { message_id: 42 } }))).state, 'provider_accepted');
  assert.equal((await sendTelegram(env, 'hi', async () => jsonRes({ ok: true, result: {} }))).state, 'failed');
  assert.equal((await sendTelegram(env, 'hi', async () => jsonRes({ ok: false, description: 'chat not found' }, 400))).state, 'failed');
  assert.equal((await sendTelegram(env, 'hi', async () => { throw new Error('timeout'); })).state, 'unknown');
});

// ---- Gmail -------------------------------------------------------------------
test('encrypt/decrypt round-trips and rejects a bad key', () => {
  const key = 'a'.repeat(64);
  assert.equal(decrypt(encrypt('refresh-token', key), key), 'refresh-token');
  assert.throws(() => encrypt('x', 'short'), /64 hex/);
  assert.equal(validateGmailConfig({}).labelId, 'INBOX');
  assert.throws(() => validateGmailConfig({ backfillDays: 500 }), /Backfill/);
});

test('gmailToRaw decodes a text/plain part and builds subject line + thread link', () => {
  const msg = { id: 'm1', threadId: 't1', internalDate: '1757678400000', snippet: 'snip', labelIds: ['INBOX'],
    payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'Dana <dana@example.com>' }, { name: 'Subject', value: 'Proposal v3' }],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Please review before tomorrow.').toString('base64url') } }] } };
  const r = gmailToRaw(msg, 'me@example.com');
  assert.equal(r.conversation, 't1');
  assert.equal(r.conversationName, 'Email: Proposal v3');
  assert.match(r.text, /^Subject: Proposal v3\nPlease review/);
  assert.match(r.sourceUrl, /^https:\/\/mail\.google\.com\//);
});

test('pollGmail initial import: captures history cursor first, then imports recent threads', async () => {
  const store = new Store(':memory:');
  store.saveSettings('live:u1', { ...defaults(), criticalChecks: true });
  const config = { ...validateGmailConfig({ backfillDays: 3, backfillLimit: 10 }), email: 'me@example.com', refresh: 'rt' };
  const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' };
  const message = { id: 'm1', threadId: 't1', internalDate: '1757678400000', labelIds: ['INBOX'], snippet: 'Anthony please approve', payload: { headers: [{ name: 'From', value: 'Dana' }, { name: 'Subject', value: 'Approve' }] } };
  const fetcher = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com/token')) { assert.equal(new URLSearchParams(opts.body).get('refresh_token'), 'rt'); return jsonRes({ access_token: 'at' }); }
    if (url.endsWith('/profile')) return jsonRes({ historyId: '999' });
    if (url.includes('/messages?')) { assert.match(url, /newer_than%3A3d/); assert.match(url, /maxResults=10/); return jsonRes({ messages: [{ id: 'm1' }] }); }
    if (url.includes('/messages/m1')) return jsonRes(message);
    if (url.includes('/threads/t1')) return jsonRes({ messages: [message] });
    throw new Error(`unexpected ${url}`);
  };
  const { ingested: n } = await pollGmail(store, 'live:u1', config, env, fetcher);
  assert.equal(n, 1);
  assert.equal(store.get('gmail.cursor:live:u1'), '999');
  assert.equal(store.messages('live:u1')[0].backfill, true, 'initial import is marked backfill so it never triggers a live alert');
  store.close();
});

// ---- Policy ------------------------------------------------------------------
test('alert policy explains every block reason and allows only a full CRITICAL', () => {
  const s = { ...defaults(), externalAlerts: true, quietStart: 23, quietEnd: 7 };
  const r = { classification: 'CRITICAL', relevant: true, policyMatch: true, unresolved: true, actionRequired: 'x', evidenceIds: ['e'] };
  const day = new Date('2026-09-12T12:00:00Z'), night = new Date('2026-09-12T23:30:00Z');
  assert.equal(alertBlockReason(r, s, day), null);
  assert.match(alertBlockReason(r, { ...s, paused: true }, day), /paused/);
  assert.match(alertBlockReason(r, { ...s, criticalChecks: false }, day), /Critical monitoring/);
  assert.match(alertBlockReason(r, { ...s, externalAlerts: false }, day), /External alerts/);
  assert.match(alertBlockReason({ ...r, classification: 'TASK' }, s, day), /Only CRITICAL/);
  assert.match(alertBlockReason(r, s, night), /Quiet hours/);
  assert.equal(alertBlockReason(r, { ...s, criticalOverride: true }, night), null);
  assert.equal(inQuietHours(s, night), true);
  assert.equal(inQuietHours({ ...s, quietStart: 9, quietEnd: 9 }, night), false);
});
