/**
 * Gmail connector (per user, read-only OAuth with PKCE).
 * Server-level: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (the app registration).
 * Per user config: { labelId, backfillDays, backfillLimit, email, refresh } - the whole
 * config is encrypted at rest by the store. Polling uses the History API after an
 * initial bounded import limited to `backfillDays` / `backfillLimit`.
 */
import { randomBytes } from 'node:crypto';
import { hash, requestJson } from '../util.mjs';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const gmailAppReady = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function validateGmailConfig(input, existing = null) {
  const labelId = String(input.labelId ?? existing?.labelId ?? 'INBOX').trim() || 'INBOX';
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(labelId)) throw new Error('Gmail label id may contain letters, digits, dash and underscore only');
  const backfillDays = Number(input.backfillDays ?? existing?.backfillDays ?? 1);
  if (!Number.isFinite(backfillDays) || backfillDays < 1 || backfillDays > 90) throw new Error('Backfill must be between 1 and 90 days');
  const backfillLimit = Number(input.backfillLimit ?? existing?.backfillLimit ?? 25);
  if (!Number.isInteger(backfillLimit) || backfillLimit < 1 || backfillLimit > 200) throw new Error('Backfill limit must be 1-200 messages');
  return { labelId, backfillDays, backfillLimit, email: existing?.email || null, refresh: existing?.refresh || null };
}

export function oauthStart(store, env, session, userId) {
  if (!gmailAppReady(env)) throw new Error('Gmail is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  store.set(`oauth:${state}`, { session, userId, verifier, expires: Date.now() + 600000 });
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.APP_ORIGIN}/oauth/gmail/callback`, response_type: 'code', scope: GMAIL_SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: Buffer.from(hash(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function oauthFinish(store, env, session, url, fetcher = fetch) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const saved = store.get(`oauth:${state}`);
  if (!saved || saved.session !== session || saved.expires < Date.now() || !code) throw new Error('Invalid, expired or unbound OAuth state');
  store.remove(`oauth:${state}`);
  const body = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${env.APP_ORIGIN}/oauth/gmail/callback`, code, code_verifier: saved.verifier, grant_type: 'authorization_code' });
  const token = await requestJson(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', body });
  if (!token.refresh_token || !token.access_token) throw new Error('Google did not return an offline refresh token');
  if (token.scope && !token.scope.split(' ').includes(GMAIL_SCOPE)) throw new Error('Read-only Gmail consent was not granted');
  const profile = await requestJson(fetcher, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${token.access_token}` } });
  const existing = store.connector(saved.userId, 'gmail')?.config || validateGmailConfig({});
  store.saveConnector(saved.userId, 'gmail', { ...existing, email: profile.emailAddress, refresh: token.refresh_token }, { status: 'authorized', lastSync: null, error: null, email: profile.emailAddress });
  store.resetConnectorCursors(saved.userId, 'gmail');
  return { userId: saved.userId, email: profile.emailAddress };
}

export function plainText(node) {
  if (node.mimeType === 'text/plain' && node.body?.data) return Buffer.from(node.body.data, 'base64url').toString('utf8');
  for (const p of node.parts || []) { const text = plainText(p); if (text) return text; }
  return '';
}
const header = (m, k) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === k.toLowerCase())?.value || '';

export function gmailToRaw(msg, email, backfill = false) {
  const text = plainText(msg.payload || {}) || msg.snippet || '';
  return {
    source: 'gmail',
    account: email,
    conversation: msg.threadId,
    conversationName: `Email: ${header(msg, 'Subject') || '(no subject)'}`,
    messageId: msg.id,
    sender: header(msg, 'From'),
    text: `Subject: ${header(msg, 'Subject')}\n${text}`.slice(0, 8000),
    sentAt: new Date(Number(msg.internalDate)).toISOString(),
    sourceUrl: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${msg.threadId}`,
    backfill
  };
}

export async function pollGmail(store, space, config, env, fetcher = fetch, now = Date.now()) {
  if (!config.refresh) throw new Error('Gmail is not authorised yet');
  const token = await requestJson(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: config.refresh }) });
  if (!token.access_token) throw new Error('Google refresh failed; reconnect Gmail');
  const api = path => requestJson(fetcher, `https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { authorization: `Bearer ${token.access_token}` } });
  const labelId = config.labelId || 'INBOX';
  let cursor = store.get(`gmail.cursor:${space}`), backfill = !cursor, ids = new Set(), nextCursor = cursor;
  if (cursor) {
    try {
      let page = '', pages = 0;
      do {
        const data = await api(`/history?${new URLSearchParams({ startHistoryId: cursor, labelId, maxResults: '100', ...(page ? { pageToken: page } : {}) })}`);
        for (const h of data.history || []) for (const group of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) for (const entry of h[group] || []) ids.add(entry.message.id);
        nextCursor = data.historyId || nextCursor;
        page = data.nextPageToken || '';
        if (++pages >= 20 && page) throw new Error('History backlog exceeds MVP batch limit; narrow the watched label');
      } while (page);
    } catch (e) { if (e.status !== 404) throw e; backfill = true; }
  }
  if (backfill) {
    nextCursor = (await api('/profile')).historyId; // capture BEFORE the bounded import so newer mail stays in history
    const recent = await api(`/messages?${new URLSearchParams({ labelIds: labelId, q: `newer_than:${Math.max(1, Math.round(config.backfillDays || 1))}d`, maxResults: String(config.backfillLimit || 25) })}`);
    ids = new Set((recent.messages || []).map(m => m.id));
  }
  const seenThreads = new Set();
  let ingested = 0;
  for (const id of ids) {
    let m;
    try { m = await api(`/messages/${encodeURIComponent(id)}?format=full`); } catch (e) {
      if (e.status !== 404) throw e;
      const old = store.message(space, hash(['gmail', config.email, id]));
      if (old) store.ingest(space, [{ ...old, text: '', deleted: true }], { now });
      continue;
    }
    if (!(m.labelIds || []).includes(labelId)) {
      const old = store.message(space, hash(['gmail', config.email, id]));
      if (old) store.ingest(space, [{ ...old, text: '', deleted: true }], { now });
      continue;
    }
    if (seenThreads.has(m.threadId)) continue;
    seenThreads.add(m.threadId);
    const thread = await api(`/threads/${encodeURIComponent(m.threadId)}?format=full`);
    const messages = (thread.messages || []).filter(x => (x.labelIds || []).includes(labelId)).slice(-30);
    ingested += store.ingest(space, messages.map(msg => gmailToRaw(msg, config.email, backfill || !ids.has(msg.id))), { now });
  }
  store.set(`gmail.cursor:${space}`, nextCursor);
  return { ingested, email: config.email };
}
