# ThreadRadar

**Most AI waits for you to ask. Ours knows when to come and find you.**

ThreadRadar is a single-owner *conversation attention agent*. It watches the Slack channels, Telegram groups and Gmail threads you choose, filters out noise, synthesises what actually matters with evidence you can click through to, files tasks and briefing items for later, and privately alerts you (in-app and on Telegram) only when something is genuinely critical.

Built during the **AI Tinkerers "Agents Everywhere" hackathon, Dublin, 12 September 2026**. Everything in this repository was created during the event.

## What it does

| You were away | ThreadRadar says |
|---|---|
| 23 messages across 12 conversations | **1 needs you now** (client launch blocked on your approval, deadline in 25 min) |
| | 4 tasks for later (proposal review, overdue invoice, partnership reply, a question about you) |
| | 1 briefing item (a production incident that was already resolved) |
| | 6 conversations filtered as noise (lunch, memes, newsletters, cold sales, a prompt-injection attempt) |

Every surfaced item cites the exact source messages that justify it. Nothing is marked critical unless it is relevant to you, matches your critical rules, is unresolved, needs *your* action and has an evidenced deadline inside your alert window.

## How it works

```
Slack / Telegram / Gmail ──► connectors (read-only, server-side credentials)
                                   │
                                   ▼
                          normalise + dedupe (SQLite)
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
  Critical monitoring (every 60 s)           Routine review (every 15 min … daily)
  new messages analysed immediately          every topic re-analysed on schedule
              └────────────────────┬────────────────────┘
                                   ▼
                    analyser: OpenAI / OpenRouter JSON mode
                    (rules engine when no key is configured)
                    → IGNORE · FYI · TASK · REVIEW · CRITICAL + evidence ids
                                   │
                                   ▼
                 dashboard  ·  in-app alert feed  ·  private Telegram alert
```

* **One process.** `node server.mjs` runs the dashboard, the JSON API and the background worker. The worker keeps polling and analysing while the browser is closed.
* **Persistent storage.** SQLite via Node's built-in `node:sqlite` (no native build step, no external database).
* **Two independent cadences.** *Critical monitoring* polls sources every `CRITICAL_POLL_SECONDS` and analyses new messages at once. *Routine review* re-queues every topic on its own interval. An hourly review never delays critical detection.
* **Owner profile drives relevance.** Name, responsibilities, priorities, important people, ignored topics and critical-alert rules are editable in the dashboard.
* **Evidence-gated grading.** Model output is validated: unknown evidence ids, invented deadlines or a CRITICAL grade that fails policy are rejected or downgraded to REVIEW.
* **Truthful side effects.** A Telegram alert is recorded as `provider_accepted` only when Telegram returns a message id. Otherwise the receipt says `failed` or `unknown`, and the exact reason an alert was *not* sent is stored with the item.
* **Untrusted input.** Conversation text is treated as data, never instructions; obvious prompt-injection is filtered before analysis.

## Quick start (demo, no credentials needed)

Requires Node.js 22.16 or newer (uses `node:sqlite`). No `npm install` is needed: there are zero dependencies.

```bash
git clone https://github.com/anthonym71/threadradar.git
cd threadradar
npm test
npm start
```

**Windows PowerShell:** `&&` is not supported in Windows PowerShell 5.1 and `npm` may be blocked by the script execution policy. Run the commands one per line and use `npm.cmd` (or call Node directly):

```powershell
cd threadradar
git checkout build/functional-mvp
npm.cmd test
npm.cmd start
```

or, without npm at all:

```powershell
node --test test/*.test.mjs
node --env-file-if-exists=.env server.mjs
```

Open http://127.0.0.1:3100 and click **Load demo**. The Demo workspace contains only synthetic, clearly labelled conversations and never sends anything outside the app. Use *Simulate new blocker*, *Simulate resolution* and *Simulate noise* to show critical detection, de-escalation and filtering live.

To analyse with a real model instead of the rules engine, put an `OPENAI_API_KEY` in `.env` and restart. The analyser in use is shown on every card and in the top-right pill.

## Live mode

1. `cp .env.example .env` and set `APP_PASSWORD` (16+ characters). Live mode is disabled without it.
2. Configure at least one source (see `.env.example` for the exact variable names and required scopes):
   * **Slack** (polling): a bot token with `channels:history`, `channels:read`, `users:read`; invite the bot to each channel in `SLACK_CHANNEL_IDS`.
   * **Telegram** (polling): a BotFather bot with privacy mode disabled, added to the groups in `TELEGRAM_CHAT_IDS`.
   * **Gmail** (read-only OAuth): a Google OAuth web client whose redirect URI is `APP_ORIGIN/oauth/gmail/callback`, plus a `TOKEN_ENCRYPTION_KEY` (`npm run keygen`). Click **Connect Gmail** on the Sources tab.
3. Restart, sign in, switch the workspace toggle to **Live**, and click **Check sources now**. The Sources tab shows each connector's real status, last sync and last error.
4. For private alerts: set `TELEGRAM_ALERT_CHAT_ID` to your own numeric chat id, send `/start` to the bot from your account (the Sources tab shows when this is verified), set `ALLOW_LIVE_SEND=true`, and enable *Send private Telegram alerts* in Settings. **Send test alert** proves the path with a real message.

Settings let you choose the routine review interval (off, 15 min, hourly, 4 h, daily), toggle critical monitoring, set the critical window, quiet hours and pause everything.

## Status: what is tested, what is implemented, what is blocked

| Area | Status |
|---|---|
| Demo workspace: load, classify, critical alert (simulated), resolution, re-escalation, done/dismiss, evidence drill-down | **Tested** end to end (`test/app.test.mjs`) and exercised in the browser |
| Rules analyser, model-output validation, alert policy, quiet hours | **Tested** (`test/analysis.test.mjs`, `test/connectors.test.mjs`) |
| SQLite store: idempotent ingest, job leasing/generations, review scheduling, restart safety | **Tested** (`test/store.test.mjs`) |
| OpenAI / OpenRouter analysis request + response validation | **Tested with a mocked provider**; not run against the real API in CI (needs a key) |
| Slack polling connector (history, thread replies, name resolution, cursor) | **Implemented and tested against recorded API shapes**; live test blocked until a bot token is supplied |
| Telegram intake (polling + webhook), `/start` verification, `sendMessage` receipt handling | **Implemented and tested against recorded API shapes**; live send blocked until a bot token, chat id and `ALLOW_LIVE_SEND=true` are supplied |
| Gmail OAuth (PKCE), encrypted refresh token, History-API polling, initial import | **Implemented and tested against recorded API shapes**; live test blocked until Google OAuth client credentials are supplied |
| Password login, CSRF header check, CSP, rate-limited login | **Tested** |

No account is connected and no notification has been sent by this repository until the Sources tab shows a `connected` status with a last-sync time, or the Activity tab shows an alert in state `provider_accepted` with a Telegram message id.

## Repository layout

```
server.mjs                entry point
src/app.mjs               HTTP routes, auth, webhooks, OAuth callback
src/worker.mjs            analysis queue, routine review timer, critical polling
src/store.mjs             SQLite persistence (messages, jobs, items, receipts, runs)
src/analysis.mjs          rules analyser, AI analyser, output validation, system prompt
src/policy.mjs            when a critical result may leave the app
src/profile.mjs           owner profile + monitoring settings and validation
src/normalize.mjs         canonical message shape
src/demo.mjs              synthetic demo conversations
src/connectors/{slack,telegram,gmail}.mjs
public/                   dashboard (vanilla JS, strict CSP)
test/                     node:test suites (npm test)
docs/DEPLOY.md            deployment (VPS + Docker, Cloud Run notes)
docs/DEMO.md              two-minute demo script
```

## Scripts

```bash
npm start      # run the server (reads .env if present)
npm run dev    # same, restarts on file change
npm test       # 37 tests, no network
npm run check  # syntax check
npm run keygen # generate TOKEN_ENCRYPTION_KEY
```

## Disclosure

* No starter kit or template was used. The application is plain Node.js (>= 22.16) with zero npm dependencies; the dashboard is hand-written HTML/CSS/JS.
* Sponsor technology used: **OpenAI** (structured JSON-mode analysis, with OpenRouter as an alternative provider). No other sponsor technology is claimed.
* Earlier design documents (WhatsApp export intake, CopilotKit UI, GoHighLevel voice escalation) describe a previous plan and are not part of this build.

## Licence

MIT. See `LICENSE`.
