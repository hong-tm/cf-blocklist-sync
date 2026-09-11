#!/usr/bin/env node
// ─── How to run ───
// Manual one-shot sync:   node run_sync.js   (or: npm run sync)
// Scheduled via pm2 (daily at 12:00 local time):
//   pm2 start run_sync.js --name cf-blocklist-sync --cron "0 12 * * *"
// The process runs the sync once, prints a result line, and exits with 0/1.
// pm2 re-runs it on the cron schedule; logs go to /var/log/cf_sync.log.
// ──────────────────

/** Entry point: runs the blocklist sync once and exits with the result code. */
import { main } from './sync_blocklist.js';

const code = await main().catch((e) => {
  console.error(`[FATAL] ${e.stack ?? e}`);
  return 1;
});
process.exit(code);
