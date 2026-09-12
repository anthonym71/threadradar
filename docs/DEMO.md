# Two-minute demo script

Setup before recording: `npm start`, open http://127.0.0.1:3100, sign in, Demo workspace selected, nothing loaded. Optional: `OPENAI_API_KEY` in `.env` so the pill reads `openai · gpt-5.4-mini`.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Sign-in screen, then empty radar | "Your conversations are sensitive, so this is behind an account. I'm in busy Slack channels, Telegram groups and an inbox that never stops. I don't want another summary. I want to know what needs *me*." |
| 0:15–0:35 | Click **Load demo** | "ThreadRadar reads the conversations I've authorised, on a server, whether or not my laptop is open. Twenty-three messages, twelve conversations." |
| 0:35–0:55 | Point at the stats and the **Needs you now** card | "One thing needs me: the client launch is blocked on my approval with a deadline in twenty-five minutes. Four tasks for later. One briefing item. Six conversations filtered as noise, including a prompt-injection attempt." |
| 0:55–1:15 | Click **Evidence** on the critical card | "Every item is grounded. These are the source messages, and the highlighted line is the one the analyser cited. Nothing is invented: a CRITICAL grade needs relevance, a rule match, an unresolved ask for me, and an evidenced deadline." |
| 1:15–1:30 | Click **Simulate resolution** | "Dana says it's resolved. The critical item drops to a briefing item. No stale alerts." |
| 1:30–1:45 | Click **Simulate new blocker**, then **Activity** | "A new blocker arrives. Critical monitoring analyses it immediately, independent of the hourly review, and raises a private alert. In live mode this goes to my Telegram, and the receipt records exactly what Telegram answered." |
| 1:45–2:00 | **Integrations** / **Settings** | "Each user connects their own Slack, Telegram and Gmail, chooses how far back the first run reads, and sets responsibilities, critical rules and quiet hours. Tokens are encrypted on the server. Most AI waits for you to ask. Ours knows when to come and find you." |

Backup: record this flow once with `npm start` on a machine with no network. Nothing in the demo workspace needs connectivity.
