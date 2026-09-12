/**
 * HTTP server: dashboard static files, JSON API, connector webhooks and OAuth.
 * Single owner, cookie session, optional password (required as soon as any live
 * provider is configured or the server binds beyond localhost).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Store } from './store.mjs';
import { hash, equal } from './util.mjs';
import { analyzerConfig } from './analysis.mjs';
import { demoMessages, demoEvent } from './demo.mjs';
import { createWorker, SPACES } from './worker.mjs';
import { verifySlack, slackEventMessage, slackPollingReady, slackWebhookReady } from './connectors/slack.mjs';
import { handleTelegramUpdate, registerTelegramWebhook, sendTelegram, telegramIntakeReady, telegramAlertsReady, telegramWebhookMode, alertChatFingerprint } from './connectors/telegram.mjs';
import { gmailReady, oauthStart, oauthFinish } from './connectors/gmail.mjs';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSETS = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

export function createApp({ env = process.env, dbPath, fetcher = fetch, timers = true, log = console.log } = {}) {
  const cfg = { HOST: '127.0.0.1', PORT: '3100', ...env };
  cfg.APP_ORIGIN = (cfg.APP_ORIGIN || `http://127.0.0.1:${cfg.PORT}`).replace(/\/$/, '');
  const origin = new URL(cfg.APP_ORIGIN);
  const hasPassword = typeof cfg.APP_PASSWORD === 'string' && cfg.APP_PASSWORD.length >= 16;
  const hasProvider = !!(cfg.SLACK_SIGNING_SECRET || cfg.SLACK_BOT_TOKEN || cfg.TELEGRAM_BOT_TOKEN || cfg.GOOGLE_CLIENT_SECRET);
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'];
  if ((!local.includes(cfg.HOST) || hasProvider) && !hasPassword) throw new Error('Set APP_PASSWORD (at least 16 characters) before binding beyond localhost or connecting live providers.');
  if (cfg.APP_PASSWORD && !hasPassword) throw new Error('APP_PASSWORD must have at least 16 characters');
  if (origin.protocol !== 'https:' && !local.includes(origin.hostname)) throw new Error('Public APP_ORIGIN must use HTTPS');

  const store = new Store(dbPath || cfg.DATABASE_PATH || 'data/threadradar.sqlite');
  const worker = createWorker({ store, env: cfg, fetcher, log });
  const loginAttempts = new Map();

  // ---- auth ----------------------------------------------------------------
  const sessionToken = req => String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tr_session='))?.slice(11) || '';
  function authenticated(req) {
    if (!hasPassword) return true;
    const token = sessionToken(req);
    if (!token) return false;
    const s = store.get(`session:${hash(token)}`);
    return !!(s && s.expires > Date.now() && s.version === hash(cfg.APP_PASSWORD));
  }
  const safeMutation = req => req.headers['x-threadradar'] === '1' && (!req.headers.origin || req.headers.origin === cfg.APP_ORIGIN) && String(req.headers['content-type'] || '').startsWith('application/json');

  // ---- source status ---------------------------------------------------------
  function sources() {
    const observed = s => store.get(`source:${s}`, {});
    const slackMode = slackPollingReady(cfg) ? 'polling' : slackWebhookReady(cfg) ? 'webhook' : null;
    const telegramMode = telegramIntakeReady(cfg) ? (telegramWebhookMode(cfg) ? 'webhook' : 'polling') : null;
    const gmail = observed('gmail');
    return [
      { source: 'slack', label: 'Slack', configured: !!slackMode, mode: slackMode, status: slackMode ? observed('slack').status || 'awaiting_first_poll' : 'not_configured', lastSync: observed('slack').lastSync || null, error: observed('slack').error || null, detail: slackMode === 'polling' ? `Polling ${cfg.SLACK_CHANNEL_IDS}` : slackMode === 'webhook' ? 'Events API webhook' : 'Set SLACK_BOT_TOKEN and SLACK_CHANNEL_IDS' },
      { source: 'telegram', label: 'Telegram', configured: !!telegramMode, mode: telegramMode, status: telegramMode ? observed('telegram').status || 'awaiting_first_poll' : 'not_configured', lastSync: observed('telegram').lastSync || null, error: observed('telegram').error || null, detail: telegramMode ? `Watching chats ${cfg.TELEGRAM_CHAT_IDS}` : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS', alerts: { configured: telegramAlertsReady(cfg), verified: store.get('telegram.verified') === alertChatFingerprint(cfg), verifiedAt: store.get('telegram.verifiedAt'), liveSendAllowed: cfg.ALLOW_LIVE_SEND === 'true' } },
      { source: 'gmail', label: 'Gmail', configured: gmailReady(cfg), mode: gmailReady(cfg) ? 'oauth-polling' : null, status: !gmailReady(cfg) ? 'not_configured' : store.get('gmail.auth') ? gmail.status || 'authorized' : 'awaiting_authorization', lastSync: gmail.lastSync || null, error: gmail.error || null, detail: gmailReady(cfg) ? (gmail.email ? `${gmail.email} / ${gmail.label || cfg.GMAIL_LABEL_ID || 'INBOX'}` : 'Click Connect Gmail') : 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY' }
    ];
  }

  // ---- helpers ---------------------------------------------------------------
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) { const e = new Error('Request too large'); e.status = 413; throw e; } chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8');
  }
  const parse = async req => { const raw = await body(req); return raw ? JSON.parse(raw) : {}; };

  function statePayload(space) {
    const items = store.items(space);
    const messages = store.messages(space, null, 400);
    const counts = { messages: store.messageCount(space) };
    for (const c of ['CRITICAL', 'REVIEW', 'TASK', 'FYI', 'IGNORE']) counts[c] = items.filter(i => i.classification === c && i.status === 'open').length;
    counts.done = items.filter(i => i.status !== 'open').length;
    const ai = analyzerConfig(cfg);
    return {
      space, settings: store.settings(space), items, messages, counts,
      notifications: store.notifications(space).slice(0, 50), runs: store.runs(space, 40), sources: sources(),
      worker: { ...worker.status(), queued: store.queued(space) },
      lastAnalysis: store.get(`analysis:${space}`), nextReview: store.get(`review:${space}`),
      ai: ai ? { configured: true, provider: ai.provider, model: ai.model } : { configured: false, provider: null, model: null },
      liveAvailable: hasPassword
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
      const path = url.pathname;

      if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true, worker: worker.status() });

      if (path === '/webhooks/slack' && req.method === 'POST') {
        const raw = await body(req);
        if (!verifySlack(raw, req.headers, cfg.SLACK_SIGNING_SECRET)) return json(res, 401, { error: 'Invalid Slack signature' });
        const p = JSON.parse(raw);
        if (p.type === 'url_verification') return json(res, 200, { challenge: p.challenge });
        if (typeof p.event_id !== 'string') return json(res, 400, { error: 'Missing event ID' });
        const m = slackEventMessage(p, cfg, store);
        if (m) { store.ingest('live', [m], { delivery: `slack:${p.event_id}` }); store.set('source:slack', { status: 'connected', mode: 'webhook', lastSync: new Date().toISOString(), error: null }); }
        return json(res, 200, { ok: true });
      }
      if (path === '/webhooks/telegram' && req.method === 'POST') {
        if (!cfg.TELEGRAM_WEBHOOK_SECRET || !equal(cfg.TELEGRAM_WEBHOOK_SECRET, req.headers['x-telegram-bot-api-secret-token'])) return json(res, 401, { error: 'Invalid webhook secret' });
        const p = JSON.parse(await body(req));
        if (!Number.isInteger(p.update_id)) return json(res, 400, { error: 'Invalid update ID' });
        const r = handleTelegramUpdate(p, cfg, store);
        if (r.raw) store.set('source:telegram', { status: 'connected', mode: 'webhook', lastSync: new Date().toISOString(), error: null });
        return json(res, 200, { ok: true });
      }

      if (path === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: authenticated(req), passwordRequired: hasPassword, liveAvailable: hasPassword });
      if (path === '/api/login' && req.method === 'POST') {
        if (!safeMutation(req)) return json(res, 403, { error: 'Invalid request origin or content type' });
        const ip = req.socket.remoteAddress || 'local', now = Date.now();
        for (const [k, v] of loginAttempts) if (v.until < now) loginAttempts.delete(k);
        const limit = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
        if (limit.count >= 5 || loginAttempts.size > 10000) return json(res, 429, { error: 'Too many attempts. Try again in a minute.' });
        limit.count++; loginAttempts.set(ip, limit);
        const input = await parse(req);
        if (hasPassword && !equal(hash(input.password || ''), hash(cfg.APP_PASSWORD))) return json(res, 401, { error: 'Incorrect password' });
        const token = randomBytes(32).toString('hex');
        store.set(`session:${hash(token)}`, { expires: now + 8 * 3600000, version: hash(cfg.APP_PASSWORD || 'local') });
        res.setHeader('set-cookie', `tr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${origin.protocol === 'https:' ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }

      if (path.startsWith('/api/') || path.startsWith('/oauth/')) {
        if (!authenticated(req)) return json(res, 401, { error: 'Sign in required' });
        if (req.method !== 'GET' && !safeMutation(req)) return json(res, 403, { error: 'Invalid request origin or content type' });
        const space = url.searchParams.get('space') || 'demo';
        if (!SPACES.includes(space)) return json(res, 400, { error: 'Invalid space' });
        if ((space === 'live' || path.startsWith('/oauth/')) && !hasPassword) return json(res, 403, { error: 'Set a strong APP_PASSWORD before using live accounts' });

        if (path === '/oauth/gmail/callback' && req.method === 'GET') {
          try { await oauthFinish(store, cfg, hash(sessionToken(req)), url, fetcher); res.writeHead(303, { location: '/?space=live&gmail=connected' }); return res.end(); }
          catch { return json(res, 400, { error: 'Gmail authorization failed or expired. Return to Sources and retry.' }); }
        }
        if (path === '/api/state' && req.method === 'GET') return json(res, 200, statePayload(space));
        if (path === '/api/item' && req.method === 'GET') {
          const item = store.item(space, url.searchParams.get('id') || '');
          if (!item) return json(res, 404, { error: 'Unknown item' });
          return json(res, 200, { item, messages: store.messages(space, item.id) });
        }
        if (path === '/api/item' && req.method === 'POST') {
          const b = await parse(req); const item = store.item(space, b.id);
          if (!item || !['open', 'done', 'dismissed'].includes(b.status)) return json(res, 400, { error: 'Invalid item or status' });
          store.saveItem(space, { ...item, status: b.status, updatedAt: new Date().toISOString() });
          return json(res, 200, { ok: true });
        }
        if (path === '/api/settings' && req.method === 'POST') {
          try { return json(res, 200, store.saveSettings(space, await parse(req))); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (path === '/api/run' && req.method === 'POST') {
          store.queueAll(space); store.run(space, 'review', { detail: 'Manual review requested.' });
          if (space === 'live') worker.pollTick(true).catch(() => {});
          await worker.tick();
          return json(res, 202, { queued: store.queued(space) });
        }
        if (path === '/api/poll' && req.method === 'POST') {
          const results = await worker.pollTick(true);
          await worker.tick();
          return json(res, 200, { results });
        }
        if (path === '/api/demo/load' && req.method === 'POST') {
          store.clearDemo();
          const n = store.ingest('demo', demoMessages(), { force: true });
          store.run('demo', 'load', { detail: `Loaded ${n} synthetic messages.` });
          await worker.tick(); await worker.tick(); await worker.tick();
          return json(res, 202, { loaded: n });
        }
        if (path === '/api/demo/event' && req.method === 'POST') {
          const b = await parse(req);
          let m; try { m = demoEvent(b.kind); } catch { return json(res, 400, { error: 'Unknown demo event' }); }
          store.ingest('demo', [m]);
          await worker.tick();
          return json(res, 202, { queued: true });
        }
        if (path === '/api/gmail/connect' && req.method === 'POST') {
          if (!gmailReady(cfg)) return json(res, 400, { error: 'Gmail is not configured on the server' });
          return json(res, 200, { url: oauthStart(store, cfg, hash(sessionToken(req))) });
        }
        if (path === '/api/telegram/register' && req.method === 'POST') {
          if (!telegramWebhookMode(cfg) || !cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_WEBHOOK_SECRET || origin.protocol !== 'https:') return json(res, 400, { error: 'Webhook mode needs TELEGRAM_MODE=webhook, a bot token, a secret and an HTTPS origin' });
          return json(res, 200, { registered: await registerTelegramWebhook(cfg, fetcher) });
        }
        if (path === '/api/telegram/test' && req.method === 'POST') {
          // Explicit owner action: sends one real test message and reports the provider's answer verbatim.
          if (!telegramAlertsReady(cfg)) return json(res, 400, { error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID are not configured' });
          if (store.get('telegram.verified') !== alertChatFingerprint(cfg)) return json(res, 400, { error: 'Send /start to the bot from your own Telegram account first' });
          if (cfg.ALLOW_LIVE_SEND !== 'true') return json(res, 400, { error: 'ALLOW_LIVE_SEND is not "true" on the server' });
          const delivery = await sendTelegram(cfg, `ThreadRadar test alert ${new Date().toISOString()}. If you can read this, private alerts work.`, fetcher);
          store.run('live', 'alert', { topic: 'Test alert', state: delivery.state, detail: delivery.detail });
          return json(res, 200, delivery);
        }
        if (path === '/api/logout' && req.method === 'POST') { store.remove(`session:${hash(sessionToken(req))}`); res.setHeader('set-cookie', 'tr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
        return json(res, 404, { error: 'Unknown API route' });
      }

      if (req.method === 'GET' && ASSETS[path]) {
        const [file, type] = ASSETS[path];
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
    server, store, worker, config: cfg, sources,
    async close() { await worker.stop(); await new Promise(r => server.listening ? server.close(r) : r()); store.close(); }
  };
}
