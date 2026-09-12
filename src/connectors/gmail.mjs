/**
 * Gmail connector (read-only OAuth, PKCE). The refresh token is stored encrypted
 * (AES-256-GCM, TOKEN_ENCRYPTION_KEY). Polling uses the History API after an initial
 * bounded import of the watched label (GMAIL_LABEL_ID, default INBOX).
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { hash, requestJson } from '../util.mjs';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const label = env => env.GMAIL_LABEL_ID || 'INBOX';

export function encrypt(text, keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || '')) throw new Error('TOKEN_ENCRYPTION_KEY must contain 64 hex characters');
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

export const gmailReady = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && /^[a-f0-9]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY || ''));

export function oauthStart(store, env, session) {
  if (!gmailReady(env)) throw new Error('Gmail client or encryption key not configured');
  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  store.set(`oauth:${state}`, { session, verifier, expires: Date.now() + 600000 });
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
  store.set('gmail.auth', { email: profile.emailAddress, refresh: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY) });
  store.remove('gmail.cursor');
  store.set('source:gmail', { status: 'authorized', lastSync: null, error: null, email: profile.emailAddress });
  return profile.emailAddress;
}

export function plainText(node) {
  if (node.mimeType === 'text/plain' && node.body?.data) return Buffer.from(node.body.data, 'base64url').toString('utf8');
  for (const p of node.parts || []) { const text = plainText(p); if (text) return text; }
  return '';
}
const header = (m, k) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === k.toLowerCase())?.value || '';

/** Convert one Gmail API message (format=full) into a raw ThreadRadar message. */
export function gmailToRaw(msg, email, labelId, backfill = false) {
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

export async function pollGmail(store, env, fetcher = fetch, now = Date.now()) {
  const connection = store.get('gmail.auth');
  if (!gmailReady(env) || !connection) return 0;
  const token = await requestJson(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: decrypt(connection.refresh, env.TOKEN_ENCRYPTION_KEY) }) });
  if (!token.access_token) throw new Error('Google refresh failed');
  const api = path => requestJson(fetcher, `https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { authorization: `Bearer ${token.access_token}` } });
  const labelId = label(env);
  let cursor = store.get('gmail.cursor'), backfill = !cursor, ids = new Set(), nextCursor = cursor;
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
    const recent = await api(`/messages?${new URLSearchParams({ labelIds: labelId, maxResults: String(env.GMAIL_BACKFILL_LIMIT || 25) })}`);
    ids = new Set((recent.messages || []).map(m => m.id));
  }
  const seenThreads = new Set();
  let ingested = 0;
  for (const id of ids) {
    let m;
    try { m = await api(`/messages/${encodeURIComponent(id)}?format=full`); } catch (e) {
      if (e.status !== 404) throw e;
      const old = store.message('live', hash(['gmail', connection.email, id]));
      if (old) store.ingest('live', [{ ...old, text: '', deleted: true }], { now });
      continue;
    }
    if (!(m.labelIds || []).includes(labelId)) {
      const old = store.message('live', hash(['gmail', connection.email, id]));
      if (old) store.ingest('live', [{ ...old, text: '', deleted: true }], { now });
      continue;
    }
    if (seenThreads.has(m.threadId)) continue;
    seenThreads.add(m.threadId);
    const thread = await api(`/threads/${encodeURIComponent(m.threadId)}?format=full`);
    const messages = (thread.messages || []).filter(x => (x.labelIds || []).includes(labelId)).slice(-30);
    ingested += store.ingest('live', messages.map(msg => gmailToRaw(msg, connection.email, labelId, backfill || !ids.has(msg.id))), { now });
  }
  store.set('gmail.cursor', nextCursor); // only after every page and write succeeded
  store.set('source:gmail', { status: 'connected', lastSync: new Date(now).toISOString(), error: null, email: connection.email, label: labelId });
  return ingested;
}
