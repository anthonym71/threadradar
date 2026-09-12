/* ThreadRadar dashboard. No framework, no inline scripts (strict CSP). All user data is set via textContent. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const state = { space: params.get('space') === 'live' ? 'live' : 'demo', tab: 'radar', data: null, session: null, timer: null, expanded: new Set() };

  // ---- helpers -------------------------------------------------------------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const fmtTime = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const ago = iso => {
    if (!iso) return '—';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (Math.abs(s) < 60) return `${s}s ago`;
    if (Math.abs(s) < 3600) return `${Math.round(s / 60)} min ago`;
    if (Math.abs(s) < 86400) return `${Math.round(s / 3600)} h ago`;
    return fmtTime(iso);
  };
  const until = iso => {
    if (!iso) return '—';
    const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (m < 0) return `${fmtTime(iso)} (overdue by ${-m} min)`;
    if (m < 120) return `${fmtTime(iso)} (in ${m} min)`;
    return fmtTime(iso);
  };
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const url = new URL(path, location.origin);
    if (!url.searchParams.has('space')) url.searchParams.set('space', state.space);
    const res = await fetch(url, { method, headers: { 'x-threadradar': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(true); throw new Error('Sign in required'); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  function banner(text, kind = '') {
    const b = $('#banner');
    b.textContent = text; b.className = `banner ${kind}`; b.hidden = !text;
  }
  function empty(text) { return h('div', { class: 'empty', text }); }

  // ---- session ---------------------------------------------------------------
  function showLogin(show) { $('#login').hidden = !show; }
  async function checkSession() {
    state.session = await fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json());
    $('#logout').hidden = !state.session.passwordRequired;
    showLogin(state.session.passwordRequired && !state.session.authenticated);
    return state.session.authenticated;
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try { await api('/api/login', { password: $('#password').value }); $('#password').value = ''; showLogin(false); await refresh(true); }
    catch (err) { $('#login-error').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/logout', {}); location.reload(); });

  // ---- navigation ------------------------------------------------------------
  document.querySelectorAll('.segmented button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.space === 'live' && state.session && !state.session.liveAvailable) { banner('Live mode needs APP_PASSWORD set on the server (at least 16 characters). Demo mode stays available.', 'warn'); return; }
    state.space = b.dataset.space; state.expanded.clear();
    document.querySelectorAll('.segmented button').forEach(x => x.classList.toggle('active', x === b));
    history.replaceState(null, '', `?space=${state.space}`);
    refresh(true);
  }));
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${state.tab}`; });
    render();
    if (state.tab === 'settings') { settingsDirty = false; renderSettings(state.data || { settings: {} }); }
  }));

  // ---- rendering -------------------------------------------------------------
  function renderPills(d) {
    const w = $('#pill-worker');
    w.textContent = d.worker.running ? `worker ${d.worker.heartbeat ? ago(d.worker.heartbeat) : 'starting'}${d.worker.queued ? ` · ${d.worker.queued} queued` : ''}` : 'worker stopped';
    w.className = `pill ${d.worker.running ? 'ok' : 'bad'}`;
    const a = $('#pill-ai');
    a.textContent = d.ai.configured ? `${d.ai.provider} · ${d.ai.model}` : 'rules only (no AI key)';
    a.className = `pill ${d.ai.configured ? 'ok' : 'warn'}`;
  }
  function render() {
    const d = state.data; if (!d) return;
    document.querySelectorAll('.segmented button').forEach(x => x.classList.toggle('active', x.dataset.space === d.space));
    renderPills(d);
    if (d.settings.paused) banner('Monitoring is paused in Settings. Nothing is analysed or sent until you resume.', 'warn');
    else if (d.space === 'demo') banner('Demo workspace: every message here is synthetic and clearly labelled. Alerts are simulated and never leave this app.');
    else banner('');
    renderRadar(d); renderSources(d); renderSettings(d); renderActivity(d);
  }

  function renderRadar(d) {
    const open = d.items.filter(i => i.status === 'open');
    const needs = open.filter(i => ['CRITICAL', 'REVIEW'].includes(i.classification)).sort((x, y) => (x.classification === 'CRITICAL' ? -1 : 1) - (y.classification === 'CRITICAL' ? -1 : 1));
    const tasks = open.filter(i => i.classification === 'TASK');
    const fyi = open.filter(i => i.classification === 'FYI');
    const ignored = open.filter(i => i.classification === 'IGNORE');
    const done = d.items.filter(i => i.status !== 'open');
    const sources = [...new Set(d.messages.map(m => m.source))].map(s => s[0].toUpperCase() + s.slice(1));
    $('#hero-source').textContent = d.space === 'demo' ? 'Synthetic demo conversations · ' + (sources.join(', ') || 'Slack, Telegram, Gmail') : (sources.length ? 'Live · ' + sources.join(', ') : 'Live · no messages yet');
    if (!d.counts.messages) {
      $('#hero-title').textContent = d.space === 'demo' ? 'Load the demo to see what you missed.' : 'Connect a source to start watching.';
      $('#hero-sub').textContent = d.space === 'demo' ? 'Twenty-three synthetic messages across twelve conversations. One of them genuinely needs you.' : 'Configure Slack, Telegram or Gmail on the Sources tab. The worker keeps watching while this browser is closed.';
    } else {
      const n = needs.filter(i => i.classification === 'CRITICAL').length;
      $('#hero-title').textContent = `${d.counts.messages} messages while you were away. ${n ? `${n} need${n === 1 ? 's' : ''} you now.` : 'Nothing needs you right now.'}`;
      $('#hero-sub').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'} for later · ${fyi.length} briefing item${fyi.length === 1 ? '' : 's'} · ${ignored.length} conversation${ignored.length === 1 ? '' : 's'} filtered as noise · analysed by ${d.ai.configured ? d.ai.provider : 'rules'}`;
    }
    const actions = $('#radar-actions'); actions.replaceChildren();
    if (d.space === 'demo') {
      actions.append(
        h('button', { class: 'primary', onclick: () => run('/api/demo/load', {}, 'Demo loaded and analysed.') }, d.counts.messages ? 'Reload demo' : 'Load demo'),
        h('button', { onclick: () => run('/api/demo/event', { kind: 'critical' }, 'Injected a new blocker.'), disabled: !d.counts.messages }, 'Simulate new blocker'),
        h('button', { onclick: () => run('/api/demo/event', { kind: 'resolved' }, 'Injected a resolution.'), disabled: !d.counts.messages }, 'Simulate resolution'),
        h('button', { onclick: () => run('/api/demo/event', { kind: 'noise' }, 'Injected noise.'), disabled: !d.counts.messages }, 'Simulate noise')
      );
    } else {
      actions.append(
        h('button', { class: 'primary', onclick: () => run('/api/poll', {}, 'Polled all configured sources.') }, 'Check sources now'),
        h('button', { onclick: () => run('/api/run', {}, 'Routine review queued.') }, 'Run review now')
      );
    }
    const stats = $('#stats'); stats.replaceChildren(
      stat('critical', needs.length, 'Needs you'), stat('task', tasks.length, 'Tasks'), stat('fyi', fyi.length, 'Briefing'), stat('ignore', ignored.length, 'Filtered'),
      stat('', d.counts.messages, 'Messages scanned'), stat('', d.nextReview && d.settings.reviewMinutes ? until(new Date(d.nextReview).toISOString()).replace(/^.*\((in .*)\)$/, '$1') : 'off', 'Next routine review'),
      stat('', d.lastAnalysis ? ago(d.lastAnalysis) : '—', 'Last analysis')
    );
    fill('#list-needs', '#count-needs', needs, 'Nothing needs you right now.');
    fill('#list-tasks', '#count-tasks', tasks, 'No open tasks.');
    fill('#list-fyi', '#count-fyi', fyi, 'No briefing items.');
    fill('#list-ignored', '#count-ignored', ignored, 'Nothing filtered yet.');
    fill('#list-done', '#count-done', done, 'Nothing closed yet.');
  }
  const stat = (cls, n, label) => h('div', { class: `stat ${cls}` }, h('div', { class: 'n', text: String(n) }), h('div', { class: 'l', text: label }));
  function fill(listSel, countSel, items, emptyText) {
    $(countSel).textContent = String(items.length);
    const list = $(listSel); list.replaceChildren();
    if (!items.length) { list.append(empty(emptyText)); return; }
    for (const i of items) list.append(card(i));
  }

  function card(i) {
    const node = $('#tpl-card').content.firstElementChild.cloneNode(true);
    node.classList.add(i.classification); if (i.status !== 'open') node.classList.add('closed');
    node.querySelector('.badge').textContent = i.status === 'open' ? i.classification : i.status.toUpperCase();
    node.querySelector('.badge').classList.add(i.classification);
    node.querySelector('.source').textContent = i.sources.join(' + ');
    node.querySelector('.conversation').textContent = i.conversationName;
    node.querySelector('.synthetic').hidden = !i.synthetic;
    node.querySelector('.title').textContent = i.title;
    node.querySelector('.summary').textContent = i.summary;
    const meta = node.querySelector('.meta');
    const row = (k, v, cls) => { if (v) meta.append(h('dt', { text: k }), h('dd', { text: v, class: cls })); };
    if (i.classification === 'CRITICAL') row('Why now', i.whyCritical, 'critical');
    row('Action', i.actionRequired);
    row('Deadline', i.dueAt ? until(i.dueAt) : null, i.classification === 'CRITICAL' ? 'critical' : '');
    row('Why relevant', i.whyRelevant);
    row('People', i.participants?.join(', '));
    row('Last message', ago(i.lastMessageAt));
    node.querySelector('.analyzer').textContent = `${i.analyzer} · ${i.messageCount} msg · ${i.evidenceIds.length} cited`;
    const buttons = node.querySelector('.buttons');
    const evidence = node.querySelector('.evidence');
    buttons.append(h('button', { class: 'small', onclick: () => toggleEvidence(i, node) }, state.expanded.has(i.id) ? 'Hide evidence' : 'Evidence'));
    if (i.sourceUrl) buttons.append(h('a', { href: i.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, h('button', { class: 'small' }, 'Open source')));
    if (i.status === 'open' && i.classification !== 'IGNORE') {
      buttons.append(h('button', { class: 'small', onclick: () => run('/api/item', { id: i.id, status: 'done' }, 'Marked done.') }, 'Done'));
      buttons.append(h('button', { class: 'small danger', onclick: () => run('/api/item', { id: i.id, status: 'dismissed' }, 'Dismissed.') }, 'Dismiss'));
    } else if (i.status !== 'open') {
      buttons.append(h('button', { class: 'small', onclick: () => run('/api/item', { id: i.id, status: 'open' }, 'Reopened.') }, 'Reopen'));
    }
    if (state.expanded.has(i.id)) loadEvidence(i, evidence);
    return node;
  }
  async function toggleEvidence(i, node) {
    if (state.expanded.has(i.id)) state.expanded.delete(i.id); else state.expanded.add(i.id);
    node.replaceWith(card(i));
  }
  async function loadEvidence(i, box) {
    box.hidden = false; box.replaceChildren(h('div', { class: 'muted', text: 'Loading source messages…' }));
    try {
      const { messages } = await api(`/api/item?id=${encodeURIComponent(i.id)}`);
      box.replaceChildren(h('div', { class: 'muted', text: `Source conversation (${messages.length} messages). Highlighted lines are the evidence the analyser cited.` }));
      for (const m of messages) {
        box.append(h('div', { class: `msg ${i.evidenceIds.includes(m.id) ? 'cited' : ''}` },
          h('div', { class: 'who' }, h('span', { text: `${m.sender}${m.deleted ? ' (deleted)' : ''}` }), h('span', { text: fmtTime(m.sentAt) })),
          h('div', { class: 'txt', text: m.deleted ? '' : m.text })));
      }
    } catch (e) { box.replaceChildren(h('div', { class: 'error', text: e.message })); }
  }

  function renderSources(d) {
    const box = $('#sources'); box.replaceChildren();
    for (const s of d.sources) {
      const dot = s.status === 'connected' ? 'ok' : s.status === 'error' ? 'bad' : s.configured ? 'warn' : '';
      const kv = h('div', { class: 'kv' });
      const add = (k, v) => { if (v) kv.append(h('span', { text: k }), h('b', { text: v })); };
      add('Status', s.status.replace(/_/g, ' '));
      add('Mode', s.mode || 'not configured');
      add('Detail', s.detail);
      add('Last sync', s.lastSync ? ago(s.lastSync) : 'never');
      if (s.error) add('Error', s.error);
      const buttons = h('div', { class: 'buttons' });
      if (s.source === 'gmail' && s.configured && d.space === 'live') buttons.append(h('button', { class: 'small primary', onclick: async () => { try { const { url } = await api('/api/gmail/connect', {}); location.href = url; } catch (e) { banner(e.message, 'bad'); } } }, s.status === 'awaiting_authorization' ? 'Connect Gmail (read-only)' : 'Re-authorise Gmail'));
      if (s.source === 'telegram' && s.configured && s.mode === 'webhook' && d.space === 'live') buttons.append(h('button', { class: 'small', onclick: () => run('/api/telegram/register', {}, 'Webhook registration requested.') }, 'Register webhook'));
      box.append(h('article', { class: 'card' },
        h('div', { class: 'card-head' }, h('span', { class: `dot ${dot}` }), h('strong', { text: s.label })),
        kv, buttons));
    }
    const t = d.sources.find(s => s.source === 'telegram').alerts;
    const st = $('#alerts-status'); st.replaceChildren();
    const rows = [
      [t.configured ? 'ok' : '', `Bot token and private chat id ${t.configured ? 'configured' : 'not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID)'}`],
      [t.verified ? 'ok' : 'warn', t.verified ? `Private chat verified ${ago(t.verifiedAt)} (you sent /start to the bot)` : 'Private chat not verified: send /start to the bot from your own Telegram account'],
      [t.liveSendAllowed ? 'ok' : 'warn', t.liveSendAllowed ? 'ALLOW_LIVE_SEND=true: real alerts enabled on the server' : 'ALLOW_LIVE_SEND is not true: alerts stay in-app only'],
      [d.settings.externalAlerts ? 'ok' : 'warn', d.settings.externalAlerts ? 'External alerts switched on in Settings' : 'External alerts switched off in Settings (live space)']
    ];
    for (const [cls, text] of rows) st.append(h('div', { class: 'status-row' }, h('span', { class: `dot ${cls}` }), h('span', { text })));
    if (d.space === 'live') st.append(h('div', { class: 'actions' }, h('button', { class: 'small', onclick: async () => { try { const r = await api('/api/telegram/test', {}); banner(`Test alert: ${r.state}. ${r.detail}`, r.state === 'provider_accepted' ? '' : 'warn'); refresh(); } catch (e) { banner(`Test alert not sent: ${e.message}`, 'bad'); } } }, 'Send test alert to my Telegram')));
    else st.append(h('p', { class: 'muted', text: 'Switch to Live to send a real test alert. Demo alerts are always simulated.' }));
    const sa = $('#source-actions'); sa.replaceChildren();
    if (d.space === 'live') sa.append(h('button', { class: 'primary', onclick: () => run('/api/poll', {}, 'Polled all configured sources.') }, 'Check sources now'));
  }

  let settingsDirty = false;
  function renderSettings(d) {
    const f = $('#settings-form');
    if (settingsDirty || document.activeElement?.form === f) return;
    for (const [k, v] of Object.entries(d.settings)) {
      const el = f.elements[k]; if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    }
    f.elements.externalAlerts.disabled = d.space === 'demo';
  }
  $('#settings-form').addEventListener('input', () => { settingsDirty = true; });
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target; const out = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'number' || el.tagName === 'SELECT') out[el.name] = Number(el.value);
      else out[el.name] = el.value;
    }
    try { await api('/api/settings', out); settingsDirty = false; $('#settings-status').textContent = 'Saved. Pending analysis re-timed.'; await refresh(true); }
    catch (err) { $('#settings-status').textContent = err.message; }
  });

  function renderActivity(d) {
    const al = $('#list-alerts'); al.replaceChildren();
    if (!d.notifications.length) al.append(empty('No alerts yet. Critical items appear here and, when enabled, in your private Telegram.'));
    for (const n of d.notifications) {
      const cls = n.state === 'provider_accepted' ? 'ok' : ['failed', 'unknown'].includes(n.state) ? 'bad' : n.state === 'pending' ? 'warn' : '';
      al.append(h('article', { class: 'card' },
        h('div', { class: 'card-head' }, h('span', { class: `dot ${cls}` }), h('span', { class: 'badge', text: n.state.replace(/_/g, ' ') }), h('span', { text: n.channel || 'in_app' }), h('span', { text: ago(n.at) })),
        h('h4', { class: 'title', text: n.title }),
        h('p', { class: 'muted', text: n.detail + (n.providerMessageId ? ` Telegram message id ${n.providerMessageId}.` : '') })));
    }
    const rl = $('#list-runs'); rl.replaceChildren();
    if (!d.runs.length) rl.append(empty('The worker has not run yet.'));
    for (const r of d.runs) {
      const text = r.error ? `${r.topic || r.source || ''}: ${r.error}` : r.kind === 'analysis' ? `${r.topic} → ${r.classification} (${r.analyzer})` : r.kind === 'poll' ? `${r.source}: ${r.ingested} new message${r.ingested === 1 ? '' : 's'}` : r.kind === 'alert' ? `${r.topic}: ${r.state}. ${r.detail}` : r.detail || '';
      rl.append(h('div', { class: `row ${r.error ? 'error' : ''}` }, h('span', { class: 't', text: ago(r.at) }), h('span', { class: 'k', text: r.kind }), h('span', { text })));
    }
  }

  // ---- data ------------------------------------------------------------------
  async function run(path, body, okText) {
    try { await api(path, body); if (okText) banner(okText); await refresh(true); }
    catch (e) { banner(e.message, 'bad'); }
  }
  let lastKey = '';
  async function refresh(force = false) {
    try {
      const data = await api('/api/state');
      // Re-render only when something meaningful changed, so open panels and buttons stay stable.
      const { worker, ...rest } = data;
      const key = JSON.stringify(rest);
      state.data = data;
      if (force || key !== lastKey) { lastKey = key; render(); }
      else renderPills(data);
    } catch (e) { if (e.message !== 'Sign in required') banner(e.message, 'bad'); }
  }
  async function boot() {
    if (params.get('gmail') === 'connected') banner('Gmail authorised. The worker will import recent mail on its next poll.');
    const ok = await checkSession();
    if (ok) await refresh();
    state.timer = setInterval(async () => { if (document.hidden) return; if (state.session?.passwordRequired && $('#login').hidden === false) return; await refresh(); }, 5000);
  }
  boot();
})();
