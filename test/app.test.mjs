import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { demoEvent } from '../src/demo.mjs';
import { defaults } from '../src/profile.mjs';

const quiet = () => {};
async function listen(app) {
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${app.server.address().port}`;
}
const headers = { 'x-threadradar': '1', 'content-type': 'application/json' };
const post = (base, path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body || {}) });

test('demo flow end to end: load -> critical item -> simulated alert -> resolution -> re-escalation', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1', PORT: '0' }, dbPath: ':memory:', timers: false, log: quiet });
  const base = await listen(app);
  try {
    const health = await fetch(`${base}/health`).then(r => r.json());
    assert.equal(health.ok, true);

    const load = await post(base, '/api/demo/load');
    assert.equal(load.status, 202);
    let s = await fetch(`${base}/api/state?space=demo`).then(r => r.json());
    assert.equal(s.counts.messages, 23);
    assert.equal(s.counts.CRITICAL, 1, 'exactly one item needs the owner now');
    assert.ok(s.counts.IGNORE >= 4, 'noise is filtered');
    assert.ok(s.items.every(i => i.synthetic), 'every demo item is flagged synthetic');
    assert.ok(s.items.filter(i => i.classification !== 'IGNORE').every(i => i.evidenceIds.length > 0), 'every surfaced item cites evidence');
    assert.equal(s.notifications.length, 1);
    assert.equal(s.notifications[0].state, 'simulated');
    const critical = s.items.find(i => i.classification === 'CRITICAL');
    assert.equal(critical.conversationName, '#client-launch (Slack)');

    const detail = await fetch(`${base}/api/item?space=demo&id=${critical.id}`).then(r => r.json());
    assert.equal(detail.messages.length, 4);
    assert.ok(detail.messages.some(m => critical.evidenceIds.includes(m.id)));

    assert.equal((await post(base, '/api/demo/event?space=demo', { kind: 'resolved' })).status, 202);
    s = await fetch(`${base}/api/state?space=demo`).then(r => r.json());
    assert.equal(s.counts.CRITICAL, 0, 'resolution clears the critical item');

    assert.equal((await post(base, '/api/demo/event?space=demo', { kind: 'critical' })).status, 202);
    s = await fetch(`${base}/api/state?space=demo`).then(r => r.json());
    assert.equal(s.counts.CRITICAL, 1, 'new blocker re-escalates');
    assert.equal(s.notifications.length, 2, 'a distinct critical state produces a new (simulated) alert');

    const item = s.items.find(i => i.classification === 'CRITICAL');
    assert.equal((await post(base, '/api/item?space=demo', { id: item.id, status: 'done' })).status, 200);
    s = await fetch(`${base}/api/state?space=demo`).then(r => r.json());
    assert.equal(s.counts.CRITICAL, 0);
    assert.equal(s.counts.done, 1);

    // marking done persists across a re-analysis with the same signature
    await post(base, '/api/run?space=demo');
    s = await fetch(`${base}/api/state?space=demo`).then(r => r.json());
    assert.equal(s.items.find(i => i.id === item.id).status, 'done');
  } finally { await app.close(); }
});

test('mutations require the anti-CSRF header and JSON content type', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet });
  const base = await listen(app);
  try {
    const r = await fetch(`${base}/api/demo/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
    const bad = await post(base, '/api/settings?space=demo', { ...defaults(), reviewMinutes: 3 });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /review interval/);
  } finally { await app.close(); }
});

test('password gate: providers require APP_PASSWORD; login then access; live space blocked without it', async () => {
  assert.throws(() => createApp({ env: { TELEGRAM_BOT_TOKEN: 'x' }, dbPath: ':memory:', timers: false, log: quiet }), /APP_PASSWORD/);
  const app = createApp({ env: { HOST: '127.0.0.1', APP_PASSWORD: 'correct-horse-battery-staple' }, dbPath: ':memory:', timers: false, log: quiet });
  const base = await listen(app);
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await post(base, '/api/login', { password: 'wrong' })).status, 401);
    const ok = await post(base, '/api/login', { password: 'correct-horse-battery-staple' });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/state?space=live`, { headers: { cookie } })).status, 200);
  } finally { await app.close(); }

  const noPw = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet });
  const base2 = await listen(noPw);
  try { assert.equal((await fetch(`${base2}/api/state?space=live`)).status, 403); } finally { await noPw.close(); }
});

test('live critical item: alert is recorded in-app with the exact reason it was not sent', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1', APP_PASSWORD: 'correct-horse-battery-staple', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: '5' }, dbPath: ':memory:', timers: false, log: quiet, fetcher: async () => { throw new Error('no network in test'); } });
  try {
    app.store.saveSettings('live', { ...defaults(), externalAlerts: true, criticalChecks: true });
    const now = new Date();
    app.store.ingest('live', [{ source: 'slack', account: 'T1', conversation: 'C1:1', conversationName: '#ops', messageId: 'C1:1', sender: 'Dana', text: `Anthony, the client launch needs your approval now. Deadline: ${new Date(now.getTime() + 10 * 60000).toISOString()}`, sentAt: now.toISOString(), receivedAt: now.toISOString() }]);
    await app.worker.tick();
    const items = app.store.items('live');
    assert.equal(items[0].classification, 'CRITICAL');
    const n = app.store.notifications('live');
    assert.equal(n.length, 1);
    assert.equal(n[0].state, 'in_app');
    assert.match(n[0].detail, /ALLOW_LIVE_SEND/);
  } finally { await app.close(); }
});

test('live critical item with everything enabled sends exactly one Telegram alert and records the provider id', async () => {
  const sent = [];
  const fetcher = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 777 } }) }; };
  const env = { HOST: '127.0.0.1', APP_PASSWORD: 'correct-horse-battery-staple', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALERT_CHAT_ID: '5', ALLOW_LIVE_SEND: 'true' };
  const app = createApp({ env, dbPath: ':memory:', timers: false, log: quiet, fetcher });
  try {
    app.store.saveSettings('live', { ...defaults(), externalAlerts: true, criticalChecks: true, quietStart: 0, quietEnd: 0 });
    app.store.set('telegram.verified', (await import('../src/connectors/telegram.mjs')).alertChatFingerprint(app.config));
    const now = new Date();
    const m = { source: 'slack', account: 'T1', conversation: 'C1:1', conversationName: '#ops', messageId: 'C1:1', sender: 'Dana', text: `Anthony, the client launch needs your approval now. Deadline: ${new Date(now.getTime() + 10 * 60000).toISOString()}`, sentAt: now.toISOString(), receivedAt: now.toISOString() };
    app.store.ingest('live', [m]);
    await app.worker.tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /sendMessage$/);
    assert.equal(sent[0].body.chat_id, '5');
    const n = app.store.notifications('live');
    assert.equal(n[0].state, 'provider_accepted');
    assert.equal(n[0].providerMessageId, '777');
    // re-analysis of the same state must not send again
    app.store.queueAll('live'); await app.worker.tick();
    assert.equal(sent.length, 1);
  } finally { await app.close(); }
});

test('worker: routine review re-queues topics on schedule and pollTick respects readiness', async () => {
  const app = createApp({ env: { HOST: '127.0.0.1' }, dbPath: ':memory:', timers: false, log: quiet });
  try {
    app.store.saveSettings('demo', { ...defaults(), reviewMinutes: 15, criticalChecks: true }, 0);
    app.store.ingest('demo', [demoEvent('noise')], { now: 0, force: true });
    await app.worker.tick(1);
    assert.equal(app.store.queued('demo'), 0);
    await app.worker.tick(16 * 60000);
    assert.equal(app.store.runs('demo').some(r => r.kind === 'review'), true);
    assert.equal(app.store.queued('demo'), 0, 'review analysed the topic again within the same tick');
    assert.deepEqual(await app.worker.pollTick(true), {}, 'no live sources configured: nothing polled');
    assert.equal(app.worker.pollers().every(p => !p.ready), true);
  } finally { await app.close(); }
});
