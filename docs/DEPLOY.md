# Deploying ThreadRadar

ThreadRadar is one Node.js process with a SQLite file. The worker runs inside that process, so anything that keeps the process alive and the `data/` directory persistent is enough.

## Requirements

* Node.js 22.16+ (uses `node:sqlite`), or Docker.
* A persistent directory for `data/threadradar.sqlite`.
* An HTTPS origin if you expose the dashboard beyond localhost. Accounts are created in the UI (first visit creates the admin).

## Option A: VPS with Docker (recommended)

```bash
git clone https://github.com/anthonym71/threadradar.git
cd threadradar
cp .env.example .env         # set APP_ORIGIN, OPENAI_API_KEY, optionally TOKEN_ENCRYPTION_KEY and the Google OAuth client
docker compose up -d --build
docker compose logs -f
```

`docker-compose.yml` binds the app to `127.0.0.1:3100` and mounts `./data` for the database. Put a TLS reverse proxy in front, for example Caddy:

```
threadradar.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

Then set `APP_ORIGIN=https://threadradar.example.com` in `.env` and `docker compose up -d` again. `APP_ORIGIN` must match the public URL exactly: it is used for the session cookie, the CSRF origin check and the Gmail OAuth redirect URI.

## Option B: bare Node with systemd

```bash
sudo useradd -r -m -d /opt/threadradar threadradar
sudo -u threadradar git clone https://github.com/anthonym71/threadradar.git /opt/threadradar/app
sudo -u threadradar cp /opt/threadradar/app/.env.example /opt/threadradar/app/.env   # edit it
```

`/etc/systemd/system/threadradar.service`:

```
[Unit]
Description=ThreadRadar
After=network-online.target

[Service]
User=threadradar
WorkingDirectory=/opt/threadradar/app
ExecStart=/usr/bin/node --env-file=.env server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now threadradar
journalctl -u threadradar -f
```

## Option C: Google Cloud Run (demo only)

Cloud Run works for the **demo workspace** (`gcloud run deploy --source .` with `HOST=0.0.0.0`, `PORT=8080`), but Cloud Run's filesystem is ephemeral and instances scale to zero, so:

* the SQLite database is lost on each new revision or cold start, and
* the background worker stops when there is no traffic.

For live monitoring use a VPS (Option A or B) or set Cloud Run `--min-instances=1` with a mounted persistent volume. We did not test the volume path.

## Verifying a deployment

1. `curl https://your-origin/health` returns `{"ok":true,"worker":{"running":true,...}}`.
2. Create the admin account, switch to **Live**, open **Integrations** and add a source: the card should reach `connected` with a recent *Last sync* after **Check now**. Any API error is shown verbatim on the card.
3. **Activity** shows `poll` rows with message counts, `analysis` rows per topic, and `alert` rows with the provider's answer.

## Security notes

* Credentials live only in `.env` on the server; the browser never sees them.
* Every page and API call needs a signed-in user. Passwords are scrypt-hashed; the first account is the admin.
* Sessions are HttpOnly cookies; mutations require a custom header and matching origin.
* Per-user Slack/Telegram tokens and Gmail refresh tokens are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` (or the generated `data/secret.key`). Back up that key with the database.
* Strict CSP (`default-src 'self'`), no inline scripts, all dynamic content set via `textContent`.
* External alerts require four independent switches: `ALLOW_LIVE_SEND=true`, the user's private chat verified via `/start`, *Send private Telegram alerts* on in Settings, and a result that passes the critical policy.

## Updating

```bash
git pull
docker compose up -d --build      # or: sudo systemctl restart threadradar
```

The schema is created with `CREATE TABLE IF NOT EXISTS`; existing data is kept.

## Hetzner or Hostinger?

Either works; the app only needs Node 22+ or Docker and a persistent disk. Recommendation: **Hetzner Cloud CX22** (2 vCPU, 4 GB, about EUR 4/month), Ubuntu 24.04, Docker, Caddy for TLS. Steps:

1. Create the server, point a DNS A record (e.g. `radar.example.com`) at it.
2. `apt install docker.io docker-compose-v2 caddy`, clone the repo, `cp .env.example .env`, set `APP_ORIGIN=https://radar.example.com`, `HOST=0.0.0.0`, your `OPENAI_API_KEY`, and `ALLOW_LIVE_SEND=true` when you are ready for real alerts.
3. `docker compose up -d --build`, then the Caddyfile above and `systemctl reload caddy`.
4. Open the URL, create the admin account, add integrations.

Hostinger VPS works identically (KVM 1 or 2 plan). Shared web hosting does not: it cannot run a long-lived Node process.

For the hackathon video, hosting is optional: the demo workspace and live polling both run on a laptop. A VPS matters for two things only: monitoring while the laptop is closed, and a public HTTPS URL for the Gmail OAuth redirect (Google also accepts `http://127.0.0.1:3100/oauth/gmail/callback` for local testing).
