# ThreadRadar

**Most AI waits for you to ask. Ours knows when to come and find you.**

ThreadRadar is a *conversation attention agent*. Each user connects the Slack channels, Telegram groups and Gmail label they choose. A server-side worker reads only those, filters out noise, synthesises what actually matters with evidence you can click through to, files tasks and briefing items for later, and privately alerts you (in-app and on Telegram) only when something is genuinely critical.

Built during the **AI Tinkerers "Agents Everywhere" hackathon, Dublin, 12 September 2026**. Everything in this repository was created during the event.

## What it does

| You were away | ThreadRadar says |
|---|---|
| 23 messages across 12 conversations | **1 needs you now** (client launch blocked on your approval, deadline in 25 min) |
| | tasks for later (proposal review, overdue invoice, partnership reply) |
| | briefing items (a production incident that was already resolved) |
| | conversations filtered as noise (lunch, memes, newsletters, cold sales, a prompt-injection attempt) |

Every surfaced item cites the exact source messages that justify it. Nothing is marked critical unless it is relevant to you, matches your critical rules, is unresolved, needs *your* action and has an evidenced deadline inside your alert window.

## How it works

```
per user: Slack / Telegram / Gmail ──► connectors (read-only; tokens encrypted at rest)
                                           │
                                           ▼
                                  normalise + dedupe (SQLite)
                                           │
                      ┌────────────────────┴────────────────────┐
                      ▼                                         ▼
          Critical monitoring (every 60 s)           Routine review (15 min … daily)
          new messages analysed immediately          every topic re-analysed on schedule
                      └────────────────────┬────────────────────┘
                                           ▼
                            analyser: OpenAI gpt-5.4-mini (JSON mode)
                            (rules engine when no key is configured)
                            → IGNORE · FYI · TASK · REVIEW · CRITICAL + evidence ids
                                           │
                                           ▼
                        dashboard  ·  in-app alert feed  ·  private Telegram alert
```

* **Accounts.** Username + password (scrypt-hashed), HttpOnly cookie sessions, admin and user roles. The first run creates the admin account; admins manage users in the Admin console. Every user has their own profile, integrations, demo and live workspaces.
* **Integrations in the UI.** Users add their own Slack bot token and channels, Telegram bot token and groups, and authorise Gmail with Google. Tokens are AES-256-GCM encrypted in the database and never returned to the browser.
* **First run window, then continuous.** Each integration has a backfill setting (Slack up to 90 days, Gmail up to 90 days with a message cap, Telegram up to the 24 hours the Bot API keeps). After the first import the worker polls continuously.
* **One process.** `node server.mjs` runs the dashboard, the JSON API and the background worker. The worker keeps polling and analysing while the browser is closed.
* **Persistent storage.** SQLite via Node's built-in `node:sqlite`. No native build step, no external database, zero npm dependencies.
* **Two independent cadences.** *Critical monitoring* polls every `CRITICAL_POLL_SECONDS` and analyses new messages at once. *Routine review* re-queues every topic on its own interval. An hourly review never delays critical detection.
* **Evidence-gated grading.** Model output is validated: unknown evidence ids, invented deadlines or a CRITICAL grade that fails policy are rejected or downgraded to REVIEW.
* **Truthful side effects.** A Telegram alert is recorded as `provider_accepted` only when Telegram returns a message id. Otherwise the receipt says `failed` or `unknown`, and the exact reason an alert was *not* sent is stored with the item.
* **Untrusted input.** Conversation text is treated as data, never instructions; obvious prompt-injection is filtered before analysis.

## Quick start (demo, no credentials needed)

Requires Node.js 22.16 or newer. No `npm install`: there are zero dependencies.

```bash
git clone https://github.com/anthonym71/threadradar.git
cd threadradar
npm test
npm start
```

**Windows PowerShell:** `&&` is not supported and `npm` may be blocked by the script execution policy. Run one command per line and use `npm.cmd test` / `npm.cmd start`, or call Node directly:

```powershell
node --test test/*.test.mjs
node --env-file-if-exists=.env server.mjs
```

Open http://127.0.0.1:3100. The first visit asks you to **create the admin account**. Sign in, stay on the **Demo** workspace and click **Load demo**. Demo conversations are synthetic and clearly labelled; demo alerts are simulated and never leave the app. *Simulate new blocker*, *Simulate resolution* and *Simulate noise* show critical detection, de-escalation and filtering live.

To analyse with a real model instead of the rules engine, put an `OPENAI_API_KEY` in `.env` and restart. The default model is `gpt-5.4-mini`; the analyser in use is shown on every card and in the top-right pill.

## Live mode

1. Switch the workspace toggle to **Live** and open **Integrations**.
2. **Slack**: create a Slack app with bot scopes `channels:history`, `channels:read`, `users:read`, install it, invite the bot to each channel, paste the `xoxb-` token and the channel IDs, choose how many hours to read back on the first run, save.
3. **Telegram**: create a bot with @BotFather, run `/setprivacy` → Disable, add the bot to the groups, paste the token and the group chat IDs. For private alerts add your own chat id and send `/start` to the bot from your account; the Integrations tab shows when that is verified.
4. **Gmail**: the server needs a Google OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, redirect URI `APP_ORIGIN/oauth/gmail/callback`). Then each user clicks **Connect with Google** and approves read-only access to their own mailbox.
5. Click **Check all now**. Each card shows its real status, last sync and last error.
6. Real Telegram alerts additionally need `ALLOW_LIVE_SEND=true` on the server and *Send private Telegram alerts* on in Settings. **Send test alert** proves the path with a real message.

Settings let you choose the routine review interval, toggle critical monitoring, set the critical window, quiet hours and pause everything. Admins manage accounts on the **Admin** tab.

## Status: what is tested, what is implemented, what is blocked

| Area | Status |
|---|---|
| Accounts: first-run setup, login, sessions, password change, admin console, per-user isolation | **Tested** (`test/app.test.mjs`, `test/store.test.mjs`) |
| Demo workspace: load, classify, critical alert (simulated), resolution, re-escalation, done/dismiss, evidence | **Tested** end to end and exercised in the browser |
| Integrations: validation, encryption at rest, masking, cursor reset, delete | **Tested** |
| Rules analyser, model-output validation, alert policy, quiet hours | **Tested** |
| OpenAI analysis (`gpt-5.4-mini`) | **Verified live** on the demo workspace with a real key; CI uses a mocked provider |
| Slack polling connector (history, thread replies, name resolution, cursor, backfill window) | **Implemented and tested against recorded API shapes**; live test blocked until a bot token is supplied |
| Telegram intake (polling), `/start` verification, `sendMessage` receipt handling, backfill window | **Implemented and tested against recorded API shapes**; live send blocked until a bot token, chat id and `ALLOW_LIVE_SEND=true` are supplied |
| Gmail OAuth (PKCE), encrypted refresh token, History-API polling, first-run window | **Implemented and tested against recorded API shapes**; live test blocked until a Google OAuth client is supplied |

No account is connected and no notification has been sent by this repository until an Integrations card shows `connected` with a last-sync time, or the Activity tab shows an alert in state `provider_accepted` with a Telegram message id.

## Repository layout

```
server.mjs                entry point
src/app.mjs               HTTP routes, auth, integrations API, admin API, OAuth callback
src/worker.mjs            analysis queue, routine review timer, per-user critical polling
src/store.mjs             SQLite persistence (users, sessions, encrypted connectors, messages, jobs, items, receipts)
src/users.mjs             scrypt password hashing, validation
src/secrets.mjs           encryption key resolution, AES-256-GCM
src/analysis.mjs          rules analyser, AI analyser, output validation, system prompt
src/policy.mjs            when a critical result may leave the app
src/profile.mjs           owner profile + monitoring settings
src/normalize.mjs         canonical message shape
src/demo.mjs              synthetic demo conversations
src/connectors/{slack,telegram,gmail}.mjs
public/                   dashboard (vanilla JS, strict CSP)
test/                     node:test suites (npm test)
docs/DEPLOY.md            deployment (VPS + Docker, systemd, Cloud Run notes)
docs/DEMO.md              two-minute demo script
```

## Scripts

```bash
npm start      # run the server (reads .env if present)
npm run dev    # same, restarts on file change
npm test       # 38 tests, no network
npm run check  # syntax check
npm run keygen # generate TOKEN_ENCRYPTION_KEY
```

## Disclosure

* No starter kit or template was used. Plain Node.js (>= 22.16) with zero npm dependencies; the dashboard is hand-written HTML/CSS/JS.
* Sponsor technology used: **OpenAI** (`gpt-5.4-mini`, JSON-mode analysis), with OpenRouter as an alternative provider. No other sponsor technology is claimed.
* Earlier design documents (WhatsApp export intake, CopilotKit UI, GoHighLevel voice escalation) describe a previous plan and are not part of this build.

## Licence

MIT. See `LICENSE`.
