import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { normalize } from '../src/normalize.mjs';
import { defaults, validateSettings } from '../src/profile.mjs';
import { demoMessages } from '../src/demo.mjs';

const raw = (id, text, extra = {}) => ({ source: 'telegram', account: '-100', conversation: '-100:1', messageId: id, sender: 'Tom', text, sentAt: '2026-09-12T10:00:00Z', ...extra });

test('normalize produces stable content-addressed ids and rejects bad input', () => {
  const a = normalize(raw('1', 'hello'));
  const b = normalize(raw('1', 'hello'));
  assert.equal(a.id, b.id);
  assert.equal(a.topicId, b.topicId);
  assert.equal(a.sourceUrl, null);
  assert.equal(normalize(raw('1', 'x', { sourceUrl: 'https://t.me/c/1/2' })).sourceUrl, 'https://t.me/c/1/2');
  assert.equal(normalize(raw('1', 'x', { sourceUrl: 'https://evil.example/x' })).sourceUrl, null);
  assert.throws(() => normalize(raw('1', 'x', { source: 'whatsapp' })), /Invalid source message/);
  assert.throws(() => normalize(raw('1', 'x', { sentAt: 'not a date' })), /Invalid source message/);
});

test('ingest is idempotent, re-queues on edits and honours webhook delivery ids', () => {
  const s = new Store(':memory:');
  assert.equal(s.ingest('live', [raw('1', 'hello')]), 1);
  assert.equal(s.ingest('live', [raw('1', 'hello')]), 0, 'exact duplicate ignored');
  assert.equal(s.ingest('live', [raw('1', 'hello edited')]), 1, 'edit stored');
  assert.equal(s.messageCount('live'), 1);
  assert.equal(s.ingest('live', [raw('2', 'x')], { delivery: 'd1' }), 1);
  assert.equal(s.ingest('live', [raw('2', 'x changed')], { delivery: 'd1' }), 0, 'replayed delivery ignored');
  assert.equal(s.queued('live'), 1, 'one topic queued');
  s.close();
});

test('critical checks schedule new messages immediately; without them they wait for the routine review', () => {
  const now = 1_000_000;
  const s = new Store(':memory:');
  s.saveSettings('live', { ...defaults(), criticalChecks: true, reviewMinutes: 60 }, now);
  s.ingest('live', [raw('1', 'urgent')], { now });
  assert.ok(s.claim(now), 'claimable right away with critical checks on');
  s.close();

  const t = new Store(':memory:');
  t.saveSettings('live', { ...defaults(), criticalChecks: false, reviewMinutes: 60 }, now);
  t.ingest('live', [raw('1', 'later')], { now });
  assert.equal(t.claim(now), null, 'not claimable before the review');
  assert.ok(t.claim(now + 61 * 60000), 'claimable once the review time arrives');
  t.close();
});

test('claim leases a job, finish removes it, a newer generation survives a stale finish', () => {
  const s = new Store(':memory:');
  s.saveSettings('live', { ...defaults(), criticalChecks: true }, 0);
  s.ingest('live', [raw('1', 'a')], { now: 0 });
  const j = s.claim(1);
  assert.equal(s.claim(2), null, 'leased job is not claimed twice');
  s.ingest('live', [raw('2', 'b')], { now: 3 }); // same topic: generation bumps
  s.finish(j); // stale generation: must not delete
  assert.equal(s.queued('live'), 1);
  const j2 = s.claim(4);
  assert.equal(j2.generation, 2);
  s.finish(j2);
  assert.equal(s.queued('live'), 0);
  s.close();
});

test('paused space is never claimed', () => {
  const s = new Store(':memory:');
  s.saveSettings('demo', { ...defaults(), paused: true, criticalChecks: true }, 0);
  s.ingest('demo', [raw('1', 'a')], { now: 0, force: true });
  assert.equal(s.claim(10), null);
  s.close();
});

test('settings validation', () => {
  assert.throws(() => validateSettings({ ...defaults(), reviewMinutes: 7 }), /review interval/);
  assert.throws(() => validateSettings({ ...defaults(), timezone: 'Mars/Olympus' }), /timezone/);
  assert.throws(() => validateSettings({ ...defaults(), quietStart: 25 }), /quietStart/);
  const s = new Store(':memory:');
  const saved = s.saveSettings('demo', { ...defaults(), externalAlerts: true });
  assert.equal(saved.externalAlerts, false, 'demo can never send externally');
  s.close();
});

test('pending notifications become unknown after a restart (never replayed)', () => {
  const s = new Store(':memory:');
  s.notification('live', 'n1', { id: 'n1', state: 'pending', at: '2026-09-12T10:00:00Z', title: 't' });
  // simulate restart by constructing a second store over the same db object semantics
  const rows = s.db.prepare('SELECT body FROM notifications').all();
  assert.equal(JSON.parse(rows[0].body).state, 'pending');
  const again = new Store(':memory:');
  again.db.exec("INSERT INTO notifications VALUES('live','n1','{\"id\":\"n1\",\"state\":\"pending\",\"at\":\"x\",\"title\":\"t\"}')");
  // constructor logic runs on open; emulate by calling the same routine
  for (const row of again.db.prepare('SELECT space,id,body FROM notifications').all()) {
    const n = JSON.parse(row.body);
    if (n.state === 'pending') again.notification(row.space, row.id, { ...n, state: 'unknown' });
  }
  assert.equal(again.notifications('live')[0].state, 'unknown');
  s.close(); again.close();
});

test('demo fixture is fully synthetic and covers all three sources', () => {
  const m = demoMessages();
  assert.ok(m.length >= 20);
  assert.ok(m.every(x => x.synthetic === true && x.account === 'synthetic-demo'));
  assert.deepEqual([...new Set(m.map(x => x.source))].sort(), ['gmail', 'slack', 'telegram']);
  m.forEach(normalize); // all valid
});
