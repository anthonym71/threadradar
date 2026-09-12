#!/usr/bin/env node
/**
 * ThreadRadar entry point. One process: HTTP dashboard + JSON API + background worker.
 *   npm start        -> node --env-file-if-exists=.env server.mjs
 */
import { createApp } from './src/app.mjs';

const app = createApp();
app.server.listen(Number(app.config.PORT), app.config.HOST, () => {
  console.log(`ThreadRadar listening on http://${app.config.HOST}:${app.config.PORT}`);
  console.log('Demo space uses SYNTHETIC conversations only. Live connectors need configuration (see .env.example).');
  for (const s of app.sources()) console.log(`  ${s.label.padEnd(9)} ${s.status}${s.mode ? ` (${s.mode})` : ''}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
