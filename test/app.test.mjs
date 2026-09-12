import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { demoEvent } from '../src/demo.mjs';
import { defaults } from '../src/profile.mjs';
import { spaceOf } from '../src/store.mjs';
import { alertChatFingerprint } from '../src/connectors/telegram.mjs';

const quiet = () => {};
const PW = 'correct-horse-battery';
async function listen(app) { await new Promise(r => app.server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${app.server.address().port}`; }
const headers = { 'x-threadradar': '1', 'content-type': 'application/json' };
const post = (base, path, body, cookie) => fetch(base + path, { method: 'POST', headers: { ...headers, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });
const get = (base, path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {} }).then(r => r.json());
async function setupAdmin(base, username = 'anthony') {
  const r = await post(base, '/api/setup', { username, password: PW });
  assert.equal(r.status, 201);
  return r.headers.get('set-cookie').split(';')[0];
}

test('first run: setup creates the admin, login works, sessions are required everywhere', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet });
  const base = await listen(app);
  try {
    let s = await get(base, '/api/session');
    assert.deepEqual([s.setupRequired, s.authenticated], [true, false]);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await post(base, '/api/setup', { username: 'x', password: 'short' })).status, 400, 'weak input rejected');
    const cookie = await setupAdmin(base);
    assert.equal((await post(base, '/api/setup', { username: 'other', password: PW })).status, 409, 'setup only once');
    s = await get(base, '/api/session', cookie);
    assert.equal(s.user.role, 'admin');
    assert.equal((await post(base, '/api/login', { username: 'anthony', password: 'wrong' })).status, 401);
    const login = await post(base, '/api/login', { username: 'ANTHONY', password: PW });
    assert.equal(login.status, 200, 'username is case-insensitive');
    const st = await get(base, '/api/state?mode=live', cookie);
    assert.equal(st.user.username, 'anthony');
    assert.equal(st.mode, 'live');
    assert.equal((await post(base, '/api/logout', {}, cookie)).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 401, 'session revoked');
  } finally { await app.close(); }
});

test('demo flow end to end per user: load -> critical -> simulated alert -> resolution -> re-escalation', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet });
  const base = await listen(app);
  try {
    const cookie = await setupAdmin(base);
    assert.equal((await post(base, '/api/demo/load', {}, cookie)).status, 202);
    let s = await get(base, '/api/state?mode=demo', cookie);
    assert.equal(s.counts.messages, 23);
    assert.equal(s.counts.CRITICAL, 1);
    assert.ok(s.counts.IGNORE >= 4);
    assert.ok(s.items.every(i => i.synthetic));
    assert.ok(s.items.filter(i => i.classification !== 'IGNORE').every(i => i.evidenceIds.length > 0));
    assert.equal(s.notifications[0].state, 'simulated');
    const critical = s.items.find(i => i.classification === 'CRITICAL');
    const detail = await get(base, `/api/item?mode=demo&id=${critical.id}`, cookie);
    assert.equal(detail.messages.length, 4);
    await post(base, '/api/demo/event?mode=demo', { kind: 'resolved' }, cookie);
    s = await get(base, '/api/state?mode=demo', cookie);
    assert.equal(s.counts.CRITICAL, 0);
    await post(base, '/api/demo/event?mode=demo', { kind: 'critical' }, cookie);
    s = await get(base, '/api/state?mode=demo', cookie);
    assert.equal(s.counts.CRITICAL, 1);
    assert.equal(s.notifications.length, 2);
    const item = s.items.find(i => i.classification === 'CRITICAL');
    await post(base, '/api/item?mode=demo', { id: item.id, status: 'done' }, cookie);
    await post(base, '/api/run?mode=demo', {}, cookie);
    s = await get(base, '/api/state?mode=demo', cookie);
    assert.equal(s.items.find(i => i.id === item.id).status, 'done');
    // a second user sees nothing of the first user's demo
    await post(base, '/api/admin/users', { username: 'bob', password: PW }, cookie);
    const bob = (await post(base, '/api/login', { username: 'bob', password: PW })).headers.get('set-cookie').split(';')[0];
    assert.equal((await get(base, '/api/state?mode=demo', bob)).counts.messages, 0);
  } finally { await app.close(); }
});

test('mutations require the anti-CSRF header and settings are validated', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet });
  const base = await listen(app);
  try {
    const cookie = await setupAdmin(base);
    const r = await fetch(`${base}/api/demo/load`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
    assert.equal(r.status, 403);
    const bad = await post(base, '/api/settings?mode=demo', { ...defaults(), reviewMinutes: 3 }, cookie);
    assert.equal(bad.status, 400);
  } finally { await app.close(); }
});

test('integrations: save, mask, reset cursors, delete; admin console with role rules', async () => {
  const calls = [];
  const fetcher = async url => { calls.push(url); if (url.includes('getMe')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 1, username: 'radar_bot' } }) }; if (url.includes('getUpdates')) return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; throw new Error(`unexpected ${url}`); };
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet, fetcher });
  const base = await listen(app);
  try {
    const cookie = await setupAdmin(base);
    assert.equal((await post(base, '/api/connectors', { source: 'slack', config: { botToken: 'nope', channelIds: 'C1' } }, cookie)).status, 400);
    const tg = await post(base, '/api/connectors', { source: 'telegram', config: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatIds: '-100123', alertChatId: '55', backfillHours: 12 } }, cookie);
    assert.equal(tg.status, 200);
    const body = await tg.json();
    assert.match(body.config.botToken, /^••••/, 'token is masked in responses');
    assert.equal(body.bot, '@radar_bot');
    assert.equal(app.store.connector(app.store.users()[0].id, 'telegram').config.botToken, '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'stored decrypted only server-side');
    assert.notEqual(app.store.db.prepare('SELECT config FROM connectors').get().config.includes('123456:ABC'), true, 'ciphertext at rest');
    // re-saving with the masked token keeps the real one
    const again = await post(base, '/api/connectors', { source: 'telegram', config: { ...body.config } }, cookie);
    assert.equal(again.status, 200);
    assert.equal(app.store.connector(app.store.users()[0].id, 'telegram').config.botToken, '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const state = await get(base, '/api/state?mode=live', cookie);
    assert.equal(state.connectors.telegram.configured, true);
    assert.equal(state.connectors.gmail.status, 'server_not_configured');
    assert.equal((await fetch(`${base}/api/connectors?source=telegram`, { method: 'DELETE', headers: { ...headers, cookie } })).status, 200);
    assert.equal((await get(base, '/api/state?mode=live', cookie)).connectors.telegram.configured, false);

    // admin console
    const users = await get(base, '/api/admin/users', cookie);
    assert.equal(users.users.length, 1);
    assert.equal((await post(base, '/api/admin/users', { username: 'bob', password: PW, role: 'user' }, cookie)).status, 201);
    const bob = (await post(base, '/api/login', { username: 'bob', password: PW })).headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/admin/users`, { headers: { cookie: bob } })).status, 403, 'non-admin blocked');
    const me = users.users[0];
    assert.equal((await post(base, '/api/admin/users/update', { id: me.id, role: 'user' }, cookie)).status, 400, 'cannot demote self');
    const bobId = (await get(base, '/api/admin/users', cookie)).users.find(u => u.username === 'bob').id;
    assert.equal((await post(base, '/api/admin/users/update', { id: bobId, disabled: true }, cookie)).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: bob } })).status, 401, 'disabled user is signed out');
    assert.equal((await post(base, '/api/admin/users/delete', { id: bobId }, cookie)).status, 200);
    assert.equal((await get(base, '/api/admin/users', cookie)).users.length, 1);
  } finally { await app.close(); }
});

test('live critical item: alert recorded in-app with the exact reason it was not sent', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet, fetcher: async () => { throw new Error('no network in test'); } });
  try {
    const u = app.store.createUser({ username: 'anthony', password: PW, role: 'admin' });
    const live = spaceOf('live', u.id);
    app.store.saveSettings(live, { ...defaults(), externalAlerts: true, criticalChecks: true });
    const now = new Date();
    app.store.ingest(live, [{ source: 'slack', account: 'T1', conversation: 'C1:1', conversationName: '#ops', messageId: 'C1:1', sender: 'Dana', text: `Anthony, the client launch needs your approval now. Deadline: ${new Date(now.getTime() + 10 * 60000).toISOString()}`, sentAt: now.toISOString(), receivedAt: now.toISOString() }]);
    await app.worker.tick();
    assert.equal(app.store.items(live)[0].classification, 'CRITICAL');
    const n = app.store.notifications(live);
    assert.equal(n[0].state, 'in_app');
    assert.match(n[0].detail, /ALLOW_LIVE_SEND/);
  } finally { await app.close(); }
});

test('live critical item with everything enabled sends exactly one Telegram alert via the user\'s own bot', async () => {
  const sent = [];
  const fetcher = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 777 } }) }; };
  const app = createApp({ env: { HOST: '127.0.0.1', ALLOW_LIVE_SEND: 'true' }, dbPath: ':memory:', timers: false, log: quiet, fetcher });
  try {
    const u = app.store.createUser({ username: 'anthony', password: PW, role: 'admin' });
    const live = spaceOf('live', u.id);
    const tg = { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatIds: '', alertChatId: '5', backfillHours: 24 };
    app.store.saveConnector(u.id, 'telegram', tg);
    app.store.set(`telegram.verified:${live}`, alertChatFingerprint(tg));
    app.store.saveSettings(live, { ...defaults(), externalAlerts: true, criticalChecks: true, quietStart: 0, quietEnd: 0 });
    const now = new Date();
    app.store.ingest(live, [{ source: 'slack', account: 'T1', conversation: 'C1:1', conversationName: '#ops', messageId: 'C1:1', sender: 'Dana', text: `Anthony, the client launch needs your approval now. Deadline: ${new Date(now.getTime() + 10 * 60000).toISOString()}`, sentAt: now.toISOString(), receivedAt: now.toISOString() }]);
    await app.worker.tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ\/sendMessage$/);
    assert.equal(sent[0].body.chat_id, '5');
    assert.equal(app.store.notifications(live)[0].providerMessageId, '777');
    app.store.queueAll(live); await app.worker.tick();
    assert.equal(sent.length, 1, 'no duplicate alert for the same state');
  } finally { await app.close(); }
});

test('worker: routine review re-queues on schedule; pollTick polls only configured users', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet });
  try {
    const u = app.store.createUser({ username: 'anthony', password: PW, role: 'admin' });
    const demo = spaceOf('demo', u.id);
    app.store.saveSettings(demo, { ...defaults(), reviewMinutes: 15, criticalChecks: true }, 0);
    app.store.ingest(demo, [demoEvent('noise')], { now: 0, force: true });
    await app.worker.tick(1);
    assert.equal(app.store.queued(demo), 0);
    await app.worker.tick(16 * 60000);
    assert.equal(app.store.runs(demo).some(r => r.kind === 'review'), true);
    assert.deepEqual(await app.worker.pollTick(null), {});
    assert.equal(app.worker.pollersFor(u.id).length, 0);
  } finally { await app.close(); }
});
