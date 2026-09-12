import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash } from './util.mjs';
import { normalize } from './normalize.mjs';
import { defaults, validateSettings } from './profile.mjs';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(space TEXT, id TEXT, topic TEXT, source TEXT, sent TEXT, hash TEXT, body TEXT, PRIMARY KEY(space, id));
CREATE INDEX IF NOT EXISTS message_topic ON messages(space, topic, sent);
CREATE TABLE IF NOT EXISTS jobs(space TEXT, id TEXT, generation INTEGER DEFAULT 1, due INTEGER, lease INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, error TEXT, PRIMARY KEY(space, id));
CREATE TABLE IF NOT EXISTS items(space TEXT, id TEXT, body TEXT, PRIMARY KEY(space, id));
CREATE TABLE IF NOT EXISTS notifications(space TEXT, id TEXT, body TEXT, PRIMARY KEY(space, id));
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT, kind TEXT, at TEXT, body TEXT);
`;

/**
 * Persistent single-file SQLite store (node:sqlite, no native build step).
 * Everything the worker needs survives restarts: messages, analysis queue,
 * items, notification receipts, connector cursors and settings.
 */
export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // An interrupted external send may or may not have reached the provider. Never replay it blindly.
    for (const row of this.db.prepare('SELECT space,id,body FROM notifications').all()) {
      const n = JSON.parse(row.body);
      if (n.state === 'pending') this.notification(row.space, row.id, { ...n, state: 'unknown', detail: 'Server restarted before delivery confirmation.' });
    }
  }

  // ---- key/value -----------------------------------------------------------
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  remove(key) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }

  // ---- settings ------------------------------------------------------------
  settings(space) { return { ...defaults(), ...this.get(`settings:${space}`, {}) }; }
  saveSettings(space, input, now = Date.now()) {
    const value = validateSettings(input);
    if (space === 'demo') value.externalAlerts = false; // demo never sends outside the app
    this.set(`settings:${space}`, value);
    const next = value.reviewMinutes ? now + value.reviewMinutes * 60000 : Number.MAX_SAFE_INTEGER;
    this.set(`review:${space}`, next);
    // Re-time pending analysis: immediate when critical checks are on, otherwise at the next review.
    this.db.prepare('UPDATE jobs SET due=? WHERE space=?').run(value.criticalChecks ? now : next, space);
    return value;
  }

  // ---- ingestion -----------------------------------------------------------
  schedule(space, topic, due) {
    this.db.prepare(`INSERT INTO jobs(space,id,due) VALUES(?,?,?) ON CONFLICT(space,id)
      DO UPDATE SET generation=jobs.generation+1, due=MIN(jobs.due,excluded.due), attempts=0, error=NULL`).run(space, topic, due);
  }
  /**
   * Insert/refresh messages and queue their topics for analysis.
   * `delivery` makes webhook deliveries idempotent. Returns number of new/changed messages.
   */
  ingest(space, input, { delivery = null, force = false, now = Date.now() } = {}) {
    const events = input.map(normalize);
    const settings = this.settings(space);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (delivery && this.db.prepare('SELECT id FROM deliveries WHERE id=?').get(delivery)) { this.db.exec('COMMIT'); return 0; }
      let inserted = 0;
      const select = this.db.prepare('SELECT hash FROM messages WHERE space=? AND id=?');
      const upsert = this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?) ON CONFLICT(space,id)
        DO UPDATE SET topic=excluded.topic, sent=excluded.sent, hash=excluded.hash, body=excluded.body`);
      for (const m of events) {
        const fingerprint = hash([m.text, m.sender, m.sentAt, m.deleted]);
        if (select.get(space, m.id)?.hash === fingerprint) continue; // exact duplicate: no re-analysis
        upsert.run(space, m.id, m.topicId, m.source, m.sentAt, fingerprint, JSON.stringify(m));
        const due = force || settings.criticalChecks
          ? now
          : this.get(`review:${space}`, settings.reviewMinutes ? now + settings.reviewMinutes * 60000 : Number.MAX_SAFE_INTEGER);
        this.schedule(space, m.topicId, due);
        inserted++;
      }
      if (delivery) this.db.prepare('INSERT INTO deliveries VALUES(?,?)').run(delivery, now);
      this.db.exec('COMMIT');
      return inserted;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  messages(space, topic = null, limit = 500) {
    const rows = topic
      ? this.db.prepare('SELECT body FROM messages WHERE space=? AND topic=? ORDER BY sent DESC LIMIT 40').all(space, topic)
      : this.db.prepare('SELECT body FROM messages WHERE space=? ORDER BY sent DESC LIMIT ?').all(space, limit);
    return rows.map(r => JSON.parse(r.body)).reverse();
  }
  message(space, id) {
    const r = this.db.prepare('SELECT body FROM messages WHERE space=? AND id=?').get(space, id);
    return r ? JSON.parse(r.body) : null;
  }
  messageCount(space) { return this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE space=?').get(space).c; }

  // ---- analysis queue ------------------------------------------------------
  queueAll(space, now = Date.now()) {
    for (const row of this.db.prepare('SELECT DISTINCT topic FROM messages WHERE space=?').all(space)) this.schedule(space, row.topic, now);
  }
  queued(space) { return this.db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE space=?').get(space).c; }
  claim(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT * FROM jobs WHERE due<=? AND lease<=? AND attempts<5 ORDER BY due LIMIT 20').all(now, now);
      const j = rows.find(r => !this.settings(r.space).paused);
      if (j) this.db.prepare('UPDATE jobs SET lease=?, attempts=attempts+1 WHERE space=? AND id=?').run(now + 90000, j.space, j.id);
      this.db.exec('COMMIT');
      return j || null;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  jobGeneration(space, id) { return this.db.prepare('SELECT generation FROM jobs WHERE space=? AND id=?').get(space, id)?.generation ?? null; }
  release(space, id) { this.db.prepare('UPDATE jobs SET lease=0 WHERE space=? AND id=?').run(space, id); }
  finish(j) {
    this.db.prepare('DELETE FROM jobs WHERE space=? AND id=? AND generation=?').run(j.space, j.id, j.generation);
    this.release(j.space, j.id);
  }
  fail(j, error) {
    this.db.prepare('UPDATE jobs SET lease=0, due=?, error=? WHERE space=? AND id=? AND generation=?').run(Date.now() + 60000, error, j.space, j.id, j.generation);
  }

  // ---- items / notifications / runs ---------------------------------------
  items(space) {
    return this.db.prepare('SELECT body FROM items WHERE space=?').all(space).map(r => JSON.parse(r.body)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  item(space, id) { const r = this.db.prepare('SELECT body FROM items WHERE space=? AND id=?').get(space, id); return r ? JSON.parse(r.body) : null; }
  saveItem(space, item) { this.db.prepare('INSERT INTO items VALUES(?,?,?) ON CONFLICT(space,id) DO UPDATE SET body=excluded.body').run(space, item.id, JSON.stringify(item)); }
  notification(space, id, value) { this.db.prepare('INSERT INTO notifications VALUES(?,?,?) ON CONFLICT(space,id) DO UPDATE SET body=excluded.body').run(space, id, JSON.stringify(value)); }
  notifications(space) { return this.db.prepare('SELECT body FROM notifications WHERE space=?').all(space).map(r => JSON.parse(r.body)).sort((a, b) => b.at.localeCompare(a.at)); }
  run(space, kind, body) {
    this.db.prepare('INSERT INTO runs(space,kind,at,body) VALUES(?,?,?,?)').run(space, kind, new Date().toISOString(), JSON.stringify(body));
    this.db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 300)').run();
  }
  runs(space, limit = 40) {
    return this.db.prepare("SELECT id,kind,at,body FROM runs WHERE space=? OR space='*' ORDER BY id DESC LIMIT ?").all(space, limit)
      .map(r => ({ id: r.id, kind: r.kind, at: r.at, ...JSON.parse(r.body) }));
  }
  clearDemo() { for (const t of ['messages', 'jobs', 'items', 'notifications', 'runs']) this.db.prepare(`DELETE FROM ${t} WHERE space='demo'`).run(); }
  close() { this.db.close(); }
}
