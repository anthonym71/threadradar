/* ThreadRadar dashboard. No framework, no inline scripts (strict CSP). All user data is set via textContent. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const state = { mode: params.get('mode') === 'live' ? 'live' : 'demo', tab: 'radar', data: null, session: null, admin: null, expanded: new Set() };
  let settingsDirty = false, lastKey = '';

  // ---- helpers -------------------------------------------------------------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
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
    if (!url.searchParams.has('mode')) url.searchParams.set('mode', state.mode);
    const res = await fetch(url, { method, headers: { 'x-threadradar': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !['/api/login', '/api/setup', '/api/password'].includes(path)) { await checkSession(); throw new Error('Sign in required'); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  function banner(text, kind = '') { const b = $('#banner'); b.textContent = text; b.className = `banner ${kind}`; b.hidden = !text; }
  const empty = text => h('div', { class: 'empty', text });
  const dot = cls => h('span', { class: `dot ${cls}` });

  // ---- session / auth --------------------------------------------------------
  async function checkSession() {
    state.session = await fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json());
    const s = state.session;
    $('#logout').hidden = !s.authenticated;
    $('#pill-user').hidden = !s.authenticated;
    if (s.user) $('#pill-user').textContent = `${s.user.username}${s.user.role === 'admin' ? ' · admin' : ''}`;
    $('#tab-admin-btn').hidden = s.user?.role !== 'admin';
    const show = !s.authenticated;
    $('#auth').hidden = !show;
    if (show) {
      const setup = s.setupRequired;
      $('#auth-intro').textContent = setup ? 'First run: create the administrator account. This account manages all other users.' : 'Sign in to your ThreadRadar workspace.';
      $('#auth-submit').textContent = setup ? 'Create admin account' : 'Sign in';
      $('#auth-confirm-row').hidden = !setup;
      $('#auth-confirm').required = setup;
      $('#auth-password').autocomplete = setup ? 'new-password' : 'current-password';
      $('#auth-username').focus();
    }
    return s.authenticated;
  }
  $('#auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#auth-error').textContent = '';
    const setup = state.session?.setupRequired;
    const username = $('#auth-username').value.trim(), password = $('#auth-password').value;
    if (setup && password !== $('#auth-confirm').value) { $('#auth-error').textContent = 'Passwords do not match'; return; }
    try {
      await api(setup ? '/api/setup' : '/api/login', { username, password });
      $('#auth-password').value = ''; $('#auth-confirm').value = '';
      await checkSession(); await refresh(true);
    } catch (err) { $('#auth-error').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/logout', {}); location.href = '/'; });

  // ---- navigation ------------------------------------------------------------
  document.querySelectorAll('.segmented button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode; state.expanded.clear();
    document.querySelectorAll('.segmented button').forEach(x => x.classList.toggle('active', x === b));
    history.replaceState(null, '', `?mode=${state.mode}&tab=${state.tab}`);
    refresh(true);
  }));
  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${tab}`; });
    history.replaceState(null, '', `?mode=${state.mode}&tab=${tab}`);
    if (tab === 'settings') { settingsDirty = false; }
    if (tab === 'admin') loadAdmin();
    render();
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

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
    document.querySelectorAll('.segmented button').forEach(x => x.classList.toggle('active', x.dataset.mode === d.mode));
    renderPills(d);
    if (d.settings.paused) banner('Monitoring is paused in Settings. Nothing is analysed or sent until you resume.', 'warn');
    else if (d.mode === 'demo') banner('Demo workspace: every message here is synthetic and clearly labelled. Alerts are simulated and never leave this app.');
    else banner('');
    renderRadar(d); renderIntegrations(d); renderSettings(d); renderActivity(d);
  }

  function renderRadar(d) {
    const open = d.items.filter(i => i.status === 'open');
    const needs = open.filter(i => ['CRITICAL', 'REVIEW'].includes(i.classification)).sort((x, y) => (x.classification === 'CRITICAL' ? -1 : 1) - (y.classification === 'CRITICAL' ? -1 : 1));
    const tasks = open.filter(i => i.classification === 'TASK');
    const fyi = open.filter(i => i.classification === 'FYI');
    const ignored = open.filter(i => i.classification === 'IGNORE');
    const done = d.items.filter(i => i.status !== 'open');
    const sources = [...new Set(d.messages.map(m => m.source))].map(s => s[0].toUpperCase() + s.slice(1));
    const connected = Object.values(d.connectors).filter(c => c.configured).map(c => c.label);
    $('#hero-source').textContent = d.mode === 'demo' ? 'Synthetic demo conversations · ' + (sources.join(', ') || 'Slack, Telegram, Gmail') : (connected.length ? 'Live · ' + connected.join(', ') : 'Live · no integrations yet');
    if (!d.counts.messages) {
      $('#hero-title').textContent = d.mode === 'demo' ? 'Load the demo to see what you missed.' : (connected.length ? 'Watching. Nothing has arrived yet.' : 'Connect an account to start watching.');
      $('#hero-sub').textContent = d.mode === 'demo' ? 'Twenty-three synthetic messages across twelve conversations. One of them genuinely needs you.' : 'Add Slack, Telegram or Gmail on the Integrations tab. The worker keeps watching while this browser is closed.';
    } else {
      const n = needs.filter(i => i.classification === 'CRITICAL').length;
      $('#hero-title').textContent = `${d.counts.messages} messages while you were away. ${n ? `${n} need${n === 1 ? 's' : ''} you now.` : 'Nothing needs you right now.'}`;
      $('#hero-sub').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'} for later · ${fyi.length} briefing item${fyi.length === 1 ? '' : 's'} · ${ignored.length} conversation${ignored.length === 1 ? '' : 's'} filtered as noise · analysed by ${d.ai.configured ? d.ai.model : 'rules'}`;
    }
    const actions = $('#radar-actions'); actions.replaceChildren();
    if (d.mode === 'demo') {
      actions.append(
        h('button', { class: 'primary', onclick: () => run('/api/demo/load', {}, 'Demo loaded and analysed.') }, d.counts.messages ? 'Reload demo' : 'Load demo'),
        h('button', { onclick: () => run('/api/demo/event', { kind: 'critical' }, 'Injected a new blocker.'), disabled: !d.counts.messages }, 'Simulate new blocker'),
        h('button', { onclick: () => run('/api/demo/event', { kind: 'resolved' }, 'Injected a resolution.'), disabled: !d.counts.messages }, 'Simulate resolution'),
        h('button', { onclick: () => run('/api/demo/event', { kind: 'noise' }, 'Injected noise.'), disabled: !d.counts.messages }, 'Simulate noise')
      );
    } else {
      actions.append(
        h('button', { class: 'primary', onclick: () => run('/api/poll', {}, 'Checked all your integrations.'), disabled: !connected.length }, 'Check sources now'),
        h('button', { onclick: () => run('/api/run', {}, 'Routine review queued.'), disabled: !d.counts.messages }, 'Run review now')
      );
    }
    $('#stats').replaceChildren(
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
    buttons.append(h('button', { class: 'small', onclick: () => { if (state.expanded.has(i.id)) state.expanded.delete(i.id); else state.expanded.add(i.id); node.replaceWith(card(i)); } }, state.expanded.has(i.id) ? 'Hide evidence' : 'Evidence'));
    if (i.sourceUrl) buttons.append(h('a', { href: i.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, h('button', { class: 'small' }, 'Open source')));
    if (i.status === 'open' && i.classification !== 'IGNORE') {
      buttons.append(h('button', { class: 'small', onclick: () => run('/api/item', { id: i.id, status: 'done' }, 'Marked done.') }, 'Done'));
      buttons.append(h('button', { class: 'small danger', onclick: () => run('/api/item', { id: i.id, status: 'dismissed' }, 'Dismissed.') }, 'Dismiss'));
    } else if (i.status !== 'open') buttons.append(h('button', { class: 'small', onclick: () => run('/api/item', { id: i.id, status: 'open' }, 'Reopened.') }, 'Reopen'));
    if (state.expanded.has(i.id)) loadEvidence(i, evidence);
    return node;
  }
  async function loadEvidence(i, box) {
    box.hidden = false; box.replaceChildren(h('div', { class: 'muted', text: 'Loading source messages…' }));
    try {
      const { messages } = await api(`/api/item?id=${encodeURIComponent(i.id)}`);
      box.replaceChildren(h('div', { class: 'muted', text: `Source conversation (${messages.length} messages). Highlighted lines are the evidence the analyser cited.` }));
      for (const m of messages) box.append(h('div', { class: `msg ${i.evidenceIds.includes(m.id) ? 'cited' : ''}` },
        h('div', { class: 'who' }, h('span', { text: `${m.sender}${m.deleted ? ' (deleted)' : ''}` }), h('span', { text: fmtTime(m.sentAt) })),
        h('div', { class: 'txt', text: m.deleted ? '' : m.text })));
    } catch (e) { box.replaceChildren(h('div', { class: 'error', text: e.message })); }
  }

  // ---- integrations ------------------------------------------------------------
  const statusDot = c => c.status === 'connected' ? 'ok' : c.status === 'error' ? 'bad' : c.configured || c.status === 'saved' || c.status === 'authorized' ? 'warn' : '';
  function field(label, name, value, opts = {}) {
    return h('label', {}, label, h('input', { name, value: value ?? '', type: opts.type || 'text', placeholder: opts.placeholder || '', min: opts.min, max: opts.max, autocomplete: 'off', spellcheck: 'false' }));
  }
  function formValues(form) { const out = {}; for (const el of form.elements) if (el.name) out[el.name] = el.type === 'number' ? Number(el.value) : el.value; return out; }
  async function saveConnector(source, form, statusEl) {
    statusEl.textContent = 'Saving…';
    try { await api('/api/connectors', { source, config: formValues(form) }); statusEl.textContent = 'Saved. First check running…'; await refresh(true); }
    catch (e) { statusEl.textContent = e.message; statusEl.className = 'error'; }
  }
  function renderIntegrations(d) {
    const box = $('#integrations');
    if (document.activeElement && box.contains(document.activeElement)) return; // do not clobber a form being edited
    box.replaceChildren();
    const c = d.connectors;
    const head = (x, extra) => h('div', { class: 'card-head' }, dot(statusDot(x)), h('strong', { text: x.label }), h('span', { class: 'muted', text: x.status.replace(/_/g, ' ') }), extra || null);
    const kv = x => { const k = h('div', { class: 'kv' }); const add = (a, b) => { if (b) k.append(h('span', { text: a }), h('b', { text: b })); }; add('Detail', x.detail); add('Last sync', x.lastSync ? ago(x.lastSync) : 'never'); if (x.error) add('Error', x.error); return k; };
    const common = (source, x, form, statusEl) => {
      const buttons = h('div', { class: 'buttons' }, h('button', { type: 'submit', class: 'small primary' }, x.configured ? 'Save changes' : 'Save and connect'));
      if (x.configured) {
        buttons.append(h('button', { type: 'button', class: 'small', onclick: () => run('/api/poll', { source }, `${x.label} checked.`) }, 'Check now'));
        buttons.append(h('button', { type: 'button', class: 'small danger', onclick: () => { if (confirm(`Remove ${x.label} and delete its stored credentials?`)) run(`/api/connectors?source=${source}`, null, `${x.label} removed.`, 'DELETE'); } }, 'Disconnect'));
      }
      form.append(buttons, statusEl);
      form.addEventListener('submit', e => { e.preventDefault(); saveConnector(source, form, statusEl); });
    };

    // Slack
    { const x = c.slack, st = h('span', { class: 'muted' });
      const form = h('form', {},
        field('Bot token (xoxb-…)', 'botToken', x.config.botToken, { type: 'password', placeholder: 'xoxb-…' }),
        field('Channel IDs (comma separated)', 'channelIds', x.config.channelIds, { placeholder: 'C0123ABCD, C0456EFGH' }),
        field('First run: read back this many hours', 'backfillHours', x.config.backfillHours, { type: 'number', min: 1, max: 2160 }),
        h('p', { class: 'hint', text: 'Create a Slack app with scopes channels:history, channels:read, users:read, install it, invite the bot to each channel (/invite @bot). Channel ID is in the channel details.' }));
      common('slack', x, form, st);
      box.append(h('article', { class: 'card integration' }, head(x), kv(x), form));
    }
    // Telegram
    { const x = c.telegram, st = h('span', { class: 'muted' });
      const form = h('form', {},
        field('Bot token from @BotFather', 'botToken', x.config.botToken, { type: 'password', placeholder: '123456789:ABC…' }),
        field('Group chat IDs to watch (comma separated)', 'chatIds', x.config.chatIds, { placeholder: '-1001234567890' }),
        field('Your private chat id (for alerts)', 'alertChatId', x.config.alertChatId, { placeholder: '123456789' }),
        field('First run: read back this many hours (max 24)', 'backfillHours', x.config.backfillHours, { type: 'number', min: 1, max: 24 }),
        h('p', { class: 'hint', text: 'In @BotFather run /setprivacy → Disable so the bot can read group messages, then add the bot to each group. Send /start to the bot from your own account to verify the alert chat. Telegram only replays the last 24 hours.' }));
      common('telegram', x, form, st);
      box.append(h('article', { class: 'card integration' }, head(x, x.bot ? h('span', { class: 'muted', text: x.bot }) : null), kv(x), form));
    }
    // Gmail
    { const x = c.gmail, st = h('span', { class: 'muted' });
      const form = h('form', {},
        field('Label to watch', 'labelId', x.config.labelId, { placeholder: 'INBOX' }),
        h('div', { class: 'row2' },
          field('First run: read back this many days', 'backfillDays', x.config.backfillDays, { type: 'number', min: 1, max: 90 }),
          field('Max messages on first run', 'backfillLimit', x.config.backfillLimit, { type: 'number', min: 1, max: 200 })),
        h('p', { class: 'hint', text: 'Read-only access (gmail.readonly). You approve it in your Google account; the refresh token is encrypted on the server. Save your settings first, then connect.' }));
      const buttons = h('div', { class: 'buttons' }, h('button', { type: 'submit', class: 'small' }, 'Save settings'));
      if (x.appReady) buttons.append(h('button', { type: 'button', class: 'small primary', onclick: async () => { try { const f = formValues(form); await api('/api/connectors', { source: 'gmail', config: f }); const { url } = await api('/api/gmail/connect', {}); location.href = url; } catch (e) { st.textContent = e.message; st.className = 'error'; } } }, x.configured ? 'Re-authorise with Google' : 'Connect with Google'));
      if (x.configured) {
        buttons.append(h('button', { type: 'button', class: 'small', onclick: () => run('/api/poll', { source: 'gmail' }, 'Gmail checked.') }, 'Check now'));
        buttons.append(h('button', { type: 'button', class: 'small danger', onclick: () => { if (confirm('Disconnect Gmail and delete the stored refresh token?')) run('/api/connectors?source=gmail', null, 'Gmail removed.', 'DELETE'); } }, 'Disconnect'));
      }
      form.append(buttons, st);
      form.addEventListener('submit', e => { e.preventDefault(); saveConnector('gmail', form, st); });
      box.append(h('article', { class: 'card integration' }, head(x), kv(x), form));
    }

    const t = c.telegram.alerts;
    const st = $('#alerts-status'); st.replaceChildren();
    const rows = [
      [t.configured ? 'ok' : '', t.configured ? 'Bot token and private chat id saved' : 'Save a Telegram bot token and your private chat id above'],
      [t.verified ? 'ok' : 'warn', t.verified ? `Private chat verified ${ago(t.verifiedAt)} (you sent /start to your bot)` : 'Private chat not verified: send /start to your bot from your own Telegram account, then Check now'],
      [t.liveSendAllowed ? 'ok' : 'warn', t.liveSendAllowed ? 'ALLOW_LIVE_SEND=true: real alerts enabled on the server' : 'ALLOW_LIVE_SEND is not true on the server: alerts stay in-app only'],
      [d.settings.externalAlerts ? 'ok' : 'warn', d.settings.externalAlerts ? 'External alerts switched on in Settings' : 'External alerts switched off in Settings (live workspace)']
    ];
    for (const [cls, text] of rows) st.append(h('div', { class: 'status-row' }, dot(cls), h('span', { text })));
    if (d.mode === 'live') st.append(h('div', { class: 'actions' }, h('button', { class: 'small', onclick: async () => { try { const r = await api('/api/telegram/test', {}); banner(`Test alert: ${r.state}. ${r.detail}`, r.state === 'provider_accepted' ? '' : 'warn'); refresh(true); } catch (e) { banner(`Test alert not sent: ${e.message}`, 'bad'); } } }, 'Send test alert to my Telegram')));
    else st.append(h('p', { class: 'muted', text: 'Switch to Live to send a real test alert. Demo alerts are always simulated.' }));
    const ia = $('#integration-actions'); ia.replaceChildren();
    if (d.mode === 'live') ia.append(h('button', { class: 'primary', onclick: () => run('/api/poll', {}, 'Checked all your integrations.') }, 'Check all now'));
  }

  // ---- settings ------------------------------------------------------------------
  function renderSettings(d) {
    const f = $('#settings-form');
    if (settingsDirty || (document.activeElement && f.contains(document.activeElement))) return;
    for (const [k, v] of Object.entries(d.settings)) {
      const el = f.elements[k]; if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    }
    f.elements.externalAlerts.disabled = d.mode === 'demo';
  }
  $('#settings-form').addEventListener('input', () => { settingsDirty = true; });
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const out = {};
    for (const el of e.target.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'number' || el.tagName === 'SELECT') out[el.name] = Number(el.value);
      else out[el.name] = el.value;
    }
    try { await api('/api/settings', out); settingsDirty = false; $('#settings-status').textContent = 'Saved. Pending analysis re-timed.'; await refresh(true); }
    catch (err) { $('#settings-status').textContent = err.message; }
  });
  $('#password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try { await api('/api/password', { currentPassword: f.elements.currentPassword.value, newPassword: f.elements.newPassword.value }); f.reset(); $('#password-status').textContent = 'Password updated.'; }
    catch (err) { $('#password-status').textContent = err.message; }
  });

  // ---- activity ------------------------------------------------------------------
  function renderActivity(d) {
    const al = $('#list-alerts'); al.replaceChildren();
    if (!d.notifications.length) al.append(empty('No alerts yet. Critical items appear here and, when enabled, in your private Telegram.'));
    for (const n of d.notifications) {
      const cls = n.state === 'provider_accepted' ? 'ok' : ['failed', 'unknown'].includes(n.state) ? 'bad' : n.state === 'pending' ? 'warn' : '';
      al.append(h('article', { class: 'card' },
        h('div', { class: 'card-head' }, dot(cls), h('span', { class: 'badge', text: n.state.replace(/_/g, ' ') }), h('span', { text: n.channel || 'in_app' }), h('span', { text: ago(n.at) })),
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

  // ---- admin ---------------------------------------------------------------------
  async function loadAdmin() {
    try { state.admin = await api('/api/admin/users'); renderAdmin(); } catch (e) { $('#admin-users').replaceChildren(empty(e.message)); }
  }
  function renderAdmin() {
    const a = state.admin; if (!a) return;
    const me = state.session?.user;
    const list = $('#admin-users'); list.replaceChildren();
    for (const u of a.users) {
      const buttons = h('div', { class: 'buttons' });
      const upd = (patch, msg) => async () => { try { await api('/api/admin/users/update', { id: u.id, ...patch }); $('#admin-status').textContent = msg; await loadAdmin(); } catch (e) { $('#admin-status').textContent = e.message; } };
      if (u.id !== me?.id) {
        buttons.append(h('button', { class: 'small', onclick: upd({ role: u.role === 'admin' ? 'user' : 'admin' }, 'Role updated.') }, u.role === 'admin' ? 'Make user' : 'Make admin'));
        buttons.append(h('button', { class: 'small', onclick: upd({ disabled: !u.disabled }, u.disabled ? 'Enabled.' : 'Disabled.') }, u.disabled ? 'Enable' : 'Disable'));
      }
      buttons.append(h('button', { class: 'small', onclick: async () => { const pw = prompt(`New temporary password for ${u.username} (10+ characters):`); if (pw) await upd({ password: pw }, 'Password reset. Their sessions were signed out.')(); } }, 'Reset password'));
      if (u.id !== me?.id) buttons.append(h('button', { class: 'small danger', onclick: async () => { if (confirm(`Delete ${u.username} and ALL their data and credentials? This cannot be undone.`)) { try { await api('/api/admin/users/delete', { id: u.id }); await loadAdmin(); } catch (e) { $('#admin-status').textContent = e.message; } } } }, 'Delete'));
      list.append(h('article', { class: 'card' }, h('div', { class: 'user-row' },
        h('div', { class: 'who' }, h('strong', {}, u.username, ' ', h('span', { class: `role ${u.role}` , text: u.role }), u.disabled ? h('span', { class: 'disabled-tag', text: ' disabled' }) : null),
          h('small', { text: `Integrations: ${u.connectors.join(', ') || 'none'} · ${u.messages} live messages · ${u.openItems} open items · last login ${u.lastLoginAt ? ago(u.lastLoginAt) : 'never'}` })),
        buttons)));
    }
    const s = a.server; const sb = $('#admin-server-body'); sb.replaceChildren();
    const k = h('div', { class: 'kv' });
    const add = (x, y) => k.append(h('span', { text: x }), h('b', { text: y }));
    add('Worker', a.worker.running ? `running, heartbeat ${ago(a.worker.heartbeat)}` : 'stopped');
    add('Analyser', s.ai || 'rules only');
    add('Credential encryption key', s.encryptionKey === 'env' ? 'TOKEN_ENCRYPTION_KEY from .env' : s.encryptionKey === 'file' || s.encryptionKey === 'generated' ? 'generated, stored in data/secret.key' : 'ephemeral (in-memory database)');
    add('Live Telegram alerts', s.liveSendAllowed ? 'enabled' : 'disabled (ALLOW_LIVE_SEND)');
    add('Gmail OAuth app', s.gmailAppReady ? 'configured' : 'not configured (GOOGLE_CLIENT_ID / SECRET)');
    sb.append(k);
  }
  $('#admin-create').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try { await api('/api/admin/users', { username: f.elements.username.value, password: f.elements.password.value, role: f.elements.role.value }); f.reset(); $('#admin-status').textContent = 'User created. Share the temporary password and ask them to change it in Settings.'; await loadAdmin(); }
    catch (err) { $('#admin-status').textContent = err.message; }
  });

  // ---- data ------------------------------------------------------------------------
  async function run(path, body, okText, method) {
    try { await api(path, body, method); if (okText) banner(okText); await refresh(true); }
    catch (e) { banner(e.message, 'bad'); }
  }
  async function refresh(force = false) {
    if (!state.session?.authenticated) return;
    try {
      const data = await api('/api/state');
      const { worker, ...rest } = data;
      const key = JSON.stringify(rest);
      state.data = data;
      if (force || key !== lastKey) { lastKey = key; render(); } else renderPills(data);
    } catch (e) { if (e.message !== 'Sign in required') banner(e.message, 'bad'); }
  }
  async function boot() {
    if (params.get('gmail') === 'connected') banner('Gmail authorised. The first import is running now.');
    const ok = await checkSession();
    const tab = params.get('tab');
    if (['radar', 'integrations', 'settings', 'activity', 'admin'].includes(tab)) showTab(tab);
    if (ok) await refresh(true);
    setInterval(async () => { if (document.hidden || !state.session?.authenticated) return; await refresh(); }, 5000);
  }
  boot();
})();
