#!/usr/bin/env node
/**
 * ThreadRadar entry point. One process: HTTP dashboard + JSON API + background worker.
 *   npm start        -> node --env-file-if-exists=.env server.mjs
 */
import { createApp } from './src/app.mjs';
import { analyzerConfig } from './src/analysis.mjs';

const app = createApp();
app.server.listen(Number(app.config.PORT), app.config.HOST, () => {
  const ai = analyzerConfig(app.config);
  console.log(`ThreadRadar listening on http://${app.config.HOST}:${app.config.PORT}`);
  console.log(`  accounts: ${app.store.userCount() === 0 ? 'none yet - open the dashboard to create the admin account' : `${app.store.userCount()} user(s)`}`);
  console.log(`  analyser: ${ai ? `${ai.provider} ${ai.model}` : 'rules only (no AI key configured)'}`);
  console.log(`  credential encryption key: ${app.keySource}`);
  console.log(`  live alerts: ${app.config.ALLOW_LIVE_SEND === 'true' ? 'enabled (ALLOW_LIVE_SEND=true)' : 'in-app only (ALLOW_LIVE_SEND not true)'}`);
  console.log('  Demo workspaces use SYNTHETIC conversations only.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
