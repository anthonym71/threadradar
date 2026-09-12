/**
 * HTTP server: dashboard static files, JSON API, OAuth callback.
 * Accounts: username + scrypt-hashed password, HttpOnly cookie sessions, admin/user roles.
 * First run: no users exist -> the UI shows a one-time "create admin account" screen.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Store, MODES, spaceOf } from './store.mjs';
import { hash } from './util.mjs';
import { resolveKey } from './secrets.mjs';
import { publicUser } from './users.mjs';
import { analyzerConfig } from './analysis.mjs';
import { demoMessages, demoEvent } from './demo.mjs';
import { createWorker } from './worker.mjs';
import { validateSlackConfig } from './connectors/slack.mjs';
import { validateTelegramConfig, sendTelegram, getBotInfo, alertChatFingerprint } from './connectors/telegram.mjs';
import { validateGmailConfig, gmailAppReady, oauthStart, oauthFinish } from './connectors/gmail.mjs';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSETS = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const mask = s => (s ? `••••••••${String(s).slice(-4)}` : '');

export function createApp({ env = process.env, dbPath, fetcher = fetch, timers = true, log = console.log } = {}) {
  const cfg = { HOST: '127.0.0.1', PORT: '3100', ...env };
  cfg.APP_ORIGIN = (cfg.APP_ORIGIN || `http://127.0.0.1:${cfg.PORT}`).replace(/\/$/, '');
  const origin = new URL(cfg.APP_ORIGIN);
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'];
  if (origin.protocol !== 'https:' && !local.includes(origin.hostname)) throw new Error('Public APP_ORIGIN must use HTTPS');
  const path = dbPath || cfg.DATABASE_PATH || 'data/threadradar.sqlite';
  const keyInfo = resolveKey(cfg, path);
  const store = new Store(path, { encryptionKey: keyInfo.key });
  const worker = createWorker({ store, env: cfg, fetcher, log });
  const loginAttempts = new Map();

  // ---- helpers ---------------------------------------------------------------
  const cookieToken = req => String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tr_session='))?.slice(11) || '';
  const safeMutation = req => req.headers['x-threadradar'] === '1' && (!req.headers.origin || req.headers.origin === cfg.APP_ORIGIN) && String(req.headers['content-type'] || '').startsWith('application/json');
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) { const e = new Error('Request too large'); e.status = 413; throw e; } chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8');
  }
  const parse = async req => { const raw = await body(req); return raw ? JSON.parse(raw) : {}; };
  function setSession(res, userId) {
    const token = store.createSession(userId);
    res.setHeader('set-cookie', `tr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${origin.protocol === 'https:' ? '; Secure' : ''}`);
  }
  function rateLimited(req) {
    const ip = req.socket.remoteAddress || 'local', now = Date.now();
    for (const [k, v] of loginAttempts) if (v.until < now) loginAttempts.delete(k);
    const limit = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
    if (limit.count >= 8 || loginAttempts.size > 10000) return true;
    limit.count++; loginAttempts.set(ip, limit);
    return false;
  }

  /** With the background worker running, analysis proceeds on its own and the UI shows progress;
   *  without it (tests, timers:false) run the ticks inline so results are immediate. */
  async function settle(ticks) { if (worker.status().running) return; for (let i = 0; i < ticks; i++) await worker.tick(); }

  function connectorsPayload(user) {
    const space = spaceOf('live', user.id);
    const c = s => store.connector(user.id, s);
    const slack = c('slack'), telegram = c('telegram'), gmail = c('gmail');
    return {
      slack: { source: 'slack', label: 'Slack', configured: !!slack, status: slack?.status.status || 'not_configured', lastSync: slack?.status.lastSync || null, error: slack?.status.error || null,
        config: slack ? { botToken: mask(slack.config.botToken), channelIds: slack.config.channelIds, backfillHours: slack.config.backfillHours } : { botToken: '', channelIds: '', backfillHours: 24 },
        detail: slack ? `Watching ${slack.config.channelIds}${slack.status.team ? ` in workspace ${slack.status.team}` : ''}` : 'Add a bot token and channel IDs' },
      telegram: { source: 'telegram', label: 'Telegram', configured: !!telegram, status: telegram?.status.status || 'not_configured', lastSync: telegram?.status.lastSync || null, error: telegram?.status.error || null,
        config: telegram ? { botToken: mask(telegram.config.botToken), chatIds: telegram.config.chatIds, alertChatId: telegram.config.alertChatId, backfillHours: telegram.config.backfillHours } : { botToken: '', chatIds: '', alertChatId: '', backfillHours: 24 },
        bot: telegram?.status.bot || null,
        alerts: { configured: !!(telegram?.config.botToken && telegram?.config.alertChatId), verified: !!telegram && store.get(`telegram.verified:${space}`) === alertChatFingerprint(telegram.config), verifiedAt: store.get(`telegram.verifiedAt:${space}`), liveSendAllowed: cfg.ALLOW_LIVE_SEND === 'true' },
        detail: telegram ? `Watching ${telegram.config.chatIds || 'no groups'}${telegram.config.alertChatId ? `, alerts to chat ${telegram.config.alertChatId}` : ''}` : 'Add a bot token and chat IDs' },
      gmail: { source: 'gmail', label: 'Gmail', appReady: gmailAppReady(cfg), configured: !!gmail?.config.refresh, status: !gmailAppReady(cfg) ? 'server_not_configured' : !gmail ? 'not_configured' : !gmail.config.refresh ? 'awaiting_authorization' : gmail.status.status || 'authorized', lastSync: gmail?.status.lastSync || null, error: gmail?.status.error || null,
        config: gmail ? { labelId: gmail.config.labelId, backfillDays: gmail.config.backfillDays, backfillLimit: gmail.config.backfillLimit, email: gmail.config.email } : { labelId: 'INBOX', backfillDays: 1, backfillLimit: 25, email: null },
        detail: !gmailAppReady(cfg) ? 'The server has no Google OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)' : gmail?.config.email ? `${gmail.config.email} / ${gmail.config.labelId}` : 'Save your settings, then connect with Google' }
    };
  }

  function statePayload(user, mode) {
    const space = spaceOf(mode, user.id);
    const items = store.items(space);
    const counts = { messages: store.messageCount(space) };
    for (const c of ['CRITICAL', 'REVIEW', 'TASK', 'FYI', 'IGNORE']) counts[c] = items.filter(i => i.classification === c && i.status === 'open').length;
    counts.done = items.filter(i => i.status !== 'open').length;
    const ai = analyzerConfig(cfg);
    return {
      mode, user: publicUser(user), settings: store.settings(space), items, messages: store.messages(space, null, 400), counts,
      notifications: store.notifications(space).slice(0, 50), runs: store.runs(space, 40), connectors: connectorsPayload(user),
      worker: { ...worker.status(), queued: store.queued(space) },
      lastAnalysis: store.get(`analysis:${space}`), nextReview: store.get(`review:${space}`),
      ai: ai ? { configured: true, provider: ai.provider, model: ai.model } : { configured: false, provider: null, model: null },
      server: { encryptionKey: keyInfo.source, liveSendAllowed: cfg.ALLOW_LIVE_SEND === 'true', gmailAppReady: gmailAppReady(cfg) }
    };
  }

  // ---- routes --------------------------------------------------------------
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, cfg.APP_ORIGIN);
      const p = url.pathname;

      if (p === '/health' && req.method === 'GET') return json(res, 200, { ok: true, worker: worker.status(), users: store.userCount() });

      // ---- public auth endpoints ----
      if (p === '/api/session' && req.method === 'GET') {
        const user = store.session(cookieToken(req));
        return json(res, 200, { setupRequired: store.userCount() === 0, authenticated: !!user, user: publicUser(user) });
      }
      if (p === '/api/setup' && req.method === 'POST') {
        if (!safeMutation(req)) return json(res, 403, { error: 'Invalid request origin or content type' });
        if (store.userCount() > 0) return json(res, 409, { error: 'Setup already completed' });
        const b = await parse(req);
        try { const u = store.createUser({ username: b.username, password: b.password, role: 'admin' }); setSession(res, u.id); store.run(spaceOf('live', u.id), 'account', { detail: 'Admin account created (first-run setup).' }); return json(res, 201, { user: publicUser(u) }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (!safeMutation(req)) return json(res, 403, { error: 'Invalid request origin or content type' });
        if (rateLimited(req)) return json(res, 429, { error: 'Too many attempts. Try again in a minute.' });
        const b = await parse(req);
        const u = store.authenticate(b.username, b.password);
        if (!u) return json(res, 401, { error: 'Incorrect username or password' });
        setSession(res, u.id);
        return json(res, 200, { user: publicUser(u) });
      }

      // ---- everything else needs a session ----
      if (p.startsWith('/api/') || p.startsWith('/oauth/')) {
        const user = store.session(cookieToken(req));
        if (!user) return json(res, 401, { error: 'Sign in required' });
        if (req.method !== 'GET' && !safeMutation(req)) return json(res, 403, { error: 'Invalid request origin or content type' });
        const mode = url.searchParams.get('mode') || 'demo';
        if (!MODES.includes(mode)) return json(res, 400, { error: 'Invalid mode' });
        const space = spaceOf(mode, user.id);
        const live = spaceOf('live', user.id);

        if (p === '/api/logout' && req.method === 'POST') { store.revokeSession(cookieToken(req)); res.setHeader('set-cookie', 'tr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
        if (p === '/api/password' && req.method === 'POST') {
          const b = await parse(req);
          if (!store.authenticate(user.username, b.currentPassword)) return json(res, 401, { error: 'Current password is incorrect' });
          try { store.updateUser(user.id, { password: b.newPassword }); setSession(res, user.id); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (p === '/api/state' && req.method === 'GET') return json(res, 200, statePayload(user, mode));
        if (p === '/api/item' && req.method === 'GET') {
          const item = store.item(space, url.searchParams.get('id') || '');
          if (!item) return json(res, 404, { error: 'Unknown item' });
          return json(res, 200, { item, messages: store.messages(space, item.id) });
        }
        if (p === '/api/item' && req.method === 'POST') {
          const b = await parse(req); const item = store.item(space, b.id);
          if (!item || !['open', 'done', 'dismissed'].includes(b.status)) return json(res, 400, { error: 'Invalid item or status' });
          store.saveItem(space, { ...item, status: b.status, updatedAt: new Date().toISOString() });
          return json(res, 200, { ok: true });
        }
        if (p === '/api/settings' && req.method === 'POST') {
          try { return json(res, 200, store.saveSettings(space, await parse(req))); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (p === '/api/run' && req.method === 'POST') {
          store.queueAll(space); store.run(space, 'review', { detail: 'Manual review requested.' });
          if (mode === 'live') worker.pollTick({ userId: user.id }).catch(() => {});
          await worker.tick();
          return json(res, 202, { queued: store.queued(space) });
        }
        if (p === '/api/poll' && req.method === 'POST') {
          const b = await parse(req);
          const results = await worker.pollTick({ userId: user.id, source: b.source || null });
          await worker.tick();
          return json(res, 200, { results });
        }
        if (p === '/api/demo/load' && req.method === 'POST') {
          const demo = spaceOf('demo', user.id);
          store.clearDemo(user.id);
          const n = store.ingest(demo, demoMessages(), { force: true });
          store.run(demo, 'load', { detail: `Loaded ${n} synthetic messages.` });
          await settle(3);
          return json(res, 202, { loaded: n });
        }
        if (p === '/api/demo/event' && req.method === 'POST') {
          const b = await parse(req);
          let m; try { m = demoEvent(b.kind); } catch { return json(res, 400, { error: 'Unknown demo event' }); }
          store.ingest(spaceOf('demo', user.id), [m]);
          await settle(1);
          return json(res, 202, { queued: true });
        }

        // ---- integrations (per user) ----
        if (p === '/api/connectors' && req.method === 'GET') return json(res, 200, connectorsPayload(user));
        if (p === '/api/connectors' && req.method === 'POST') {
          const b = await parse(req);
          const existing = store.connector(user.id, b.source)?.config || null;
          try {
            let config, status = { status: 'saved', error: null };
            if (b.source === 'slack') config = validateSlackConfig(b.config || {}, existing);
            else if (b.source === 'telegram') {
              config = validateTelegramConfig(b.config || {}, existing);
              try { const bot = await getBotInfo(config, fetcher); status.bot = bot.username ? `@${bot.username}` : String(bot.id); status.status = 'saved'; }
              catch (e) { return json(res, 400, { error: `Telegram rejected the bot token: ${e.message}` }); }
            } else if (b.source === 'gmail') config = validateGmailConfig(b.config || {}, existing);
            else return json(res, 400, { error: 'Unknown source' });
            const credentialChanged = existing && ((b.source !== 'gmail' && config.botToken !== existing.botToken) || config.channelIds !== existing.channelIds || config.chatIds !== existing.chatIds || config.labelId !== existing.labelId || config.alertChatId !== existing.alertChatId);
            store.saveConnector(user.id, b.source, config, status);
            if (!existing || credentialChanged || b.reset) store.resetConnectorCursors(user.id, b.source);
            store.run(live, 'account', { detail: `${b.source} integration ${existing ? 'updated' : 'added'}.` });
            if (b.source !== 'gmail') worker.pollTick({ userId: user.id, source: b.source }).then(() => worker.tick()).catch(() => {});
            return json(res, 200, connectorsPayload(user)[b.source]);
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (p === '/api/connectors' && req.method === 'DELETE') {
          const source = url.searchParams.get('source');
          if (!['slack', 'telegram', 'gmail'].includes(source)) return json(res, 400, { error: 'Unknown source' });
          store.deleteConnector(user.id, source);
          store.run(live, 'account', { detail: `${source} integration removed. Stored credentials deleted.` });
          return json(res, 200, { ok: true });
        }
        if (p === '/api/gmail/connect' && req.method === 'POST') {
          if (!gmailAppReady(cfg)) return json(res, 400, { error: 'Gmail is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)' });
          if (!store.connector(user.id, 'gmail')) store.saveConnector(user.id, 'gmail', validateGmailConfig({}), { status: 'awaiting_authorization' });
          return json(res, 200, { url: oauthStart(store, cfg, hash(cookieToken(req)), user.id) });
        }
        if (p === '/oauth/gmail/callback' && req.method === 'GET') {
          try { await oauthFinish(store, cfg, hash(cookieToken(req)), url, fetcher); worker.pollTick({ userId: user.id, source: 'gmail' }).then(() => worker.tick()).catch(() => {}); res.writeHead(303, { location: '/?mode=live&tab=integrations&gmail=connected' }); return res.end(); }
          catch (e) { log(`gmail oauth failed: ${e.message}`); return json(res, 400, { error: 'Gmail authorization failed or expired. Return to Integrations and retry.' }); }
        }
        if (p === '/api/telegram/test' && req.method === 'POST') {
          const tg = store.connector(user.id, 'telegram')?.config;
          if (!tg?.botToken || !tg?.alertChatId) return json(res, 400, { error: 'Save a Telegram bot token and your private chat id first' });
          if (store.get(`telegram.verified:${live}`) !== alertChatFingerprint(tg)) return json(res, 400, { error: 'Send /start to your bot from your own Telegram account, then click Check now' });
          if (cfg.ALLOW_LIVE_SEND !== 'true') return json(res, 400, { error: 'ALLOW_LIVE_SEND is not "true" on the server' });
          const delivery = await sendTelegram(tg, `ThreadRadar test alert ${new Date().toISOString()}. If you can read this, private alerts work.`, fetcher);
          store.run(live, 'alert', { topic: 'Test alert', state: delivery.state, detail: delivery.detail });
          return json(res, 200, delivery);
        }

        // ---- admin console ----
        if (p.startsWith('/api/admin/')) {
          if (user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
          if (p === '/api/admin/users' && req.method === 'GET') {
            return json(res, 200, { users: store.users().map(u => ({ ...publicUser(u), connectors: store.connectors(u.id).map(c => c.source), messages: store.messageCount(spaceOf('live', u.id)), openItems: store.items(spaceOf('live', u.id)).filter(i => i.status === 'open' && i.classification !== 'IGNORE').length })), worker: worker.status(), server: { encryptionKey: keyInfo.source, liveSendAllowed: cfg.ALLOW_LIVE_SEND === 'true', gmailAppReady: gmailAppReady(cfg), ai: analyzerConfig(cfg)?.model || null } });
          }
          if (p === '/api/admin/users' && req.method === 'POST') {
            const b = await parse(req);
            try { const u = store.createUser({ username: b.username, password: b.password, role: b.role === 'admin' ? 'admin' : 'user' }); store.run(live, 'account', { detail: `User ${u.username} created by ${user.username}.` }); return json(res, 201, { user: publicUser(u) }); }
            catch (e) { return json(res, 400, { error: e.message }); }
          }
          if (p === '/api/admin/users/update' && req.method === 'POST') {
            const b = await parse(req);
            const target = store.userById(b.id);
            if (!target) return json(res, 404, { error: 'Unknown user' });
            if (target.id === user.id && (b.disabled === true || b.role === 'user')) return json(res, 400, { error: 'You cannot disable or demote your own account' });
            if (target.role === 'admin' && (b.role === 'user' || b.disabled === true) && store.adminCount() <= 1) return json(res, 400, { error: 'At least one active admin is required' });
            try { const u = store.updateUser(target.id, { role: b.role, disabled: b.disabled, password: b.password }); store.run(live, 'account', { detail: `User ${u.username} updated by ${user.username}.` }); return json(res, 200, { user: publicUser(u) }); }
            catch (e) { return json(res, 400, { error: e.message }); }
          }
          if (p === '/api/admin/users/delete' && req.method === 'POST') {
            const b = await parse(req);
            const target = store.userById(b.id);
            if (!target) return json(res, 404, { error: 'Unknown user' });
            if (target.id === user.id) return json(res, 400, { error: 'You cannot delete your own account' });
            store.deleteUser(target.id);
            store.run(live, 'account', { detail: `User ${target.username} and all their data deleted by ${user.username}.` });
            return json(res, 200, { ok: true });
          }
        }
        return json(res, 404, { error: 'Unknown API route' });
      }

      if (req.method === 'GET' && ASSETS[p]) {
        const [file, type] = ASSETS[p];
        const data = await readFile(resolve(PUBLIC_DIR, file));
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        return res.end(data);
      }
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      log(`request failed: ${e.message}`);
      return json(res, e.status || 400, { error: e.status === 413 ? 'Payload too large' : 'Request failed. Check input and server configuration.' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  if (timers) worker.start();

  return {
    server, store, worker, config: cfg, keySource: keyInfo.source,
    async close() { await worker.stop(); await new Promise(r => server.listening ? server.close(r) : r()); store.close(); }
  };
}
