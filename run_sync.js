#!/usr/bin/env node

/**
 * Entry point: runs the blocklist sync once and exits with the result code.
 * The retry budget lives here — not in the supervisor (pm2/systemd) — so it
 * counts every failed run regardless of how long the run took. Supervisor
 * heuristics like pm2's min_uptime only bound fast crashes; a run that fails
 * after minutes (e.g. a Cloudflare bulk operation that never completes) would
 * otherwise retry forever.
 */
import { main } from './src/main.js';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = Number(process.env.SYNC_RETRY_DELAY_MS) || 5 * 60_000;

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let code = 1;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  code = await main().catch((e) => {
    console.error(`[FATAL] ${e.stack ?? e}`);
    return 1;
  });
  if (code === 0) break;
  if (attempt < ATTEMPTS) {
    console.error(`[WARN] attempt ${attempt}/${ATTEMPTS} failed; retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s`);
    await delay(RETRY_DELAY_MS);
  }
}
process.exit(code);
