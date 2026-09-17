#!/usr/bin/env node

/** Entry point: runs the blocklist sync once and exits with the result code. */
import { main } from './src/main.js';

const code = await main().catch((e) => {
  console.error(`[FATAL] ${e.stack ?? e}`);
  return 1;
});
process.exit(code);
