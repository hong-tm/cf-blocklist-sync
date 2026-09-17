// Orchestration: feeds -> Cloudflare list -> CDN mirrors, all add-only/incremental
// (per-run transfer is just the delta).
//
// Must not auto-run here: pm2 loads the entry point via import() (ProcessContainerFork),
// which breaks argv[1] entry guards. Entry point: ../run_sync.js.

import { loadConfig } from './config.js';
import { fetchFeed, mergeFeeds, computeToAdd } from './feed.js';
import { fetchCfItems, addItemsToCf, MAX_ITEMS } from './cloudflare.js';
import { syncCdnfly } from './cdn_cdnfly.js';
import { syncGoedge } from './cdn_goedge.js';

export async function main() {
  const cfg = loadConfig();
  const results = await Promise.all(cfg.feedUrls.map((url) => fetchFeed(url)));
  const merged = mergeFeeds(...results);
  if (merged.size === 0) {
    console.error('[ABORT] no valid entries fetched; all lists left untouched');
    return 1;
  }

  const current = await fetchCfItems(cfg);
  if (current === null) {
    console.error('[ABORT] could not read current Cloudflare list; lists left untouched');
    return 1;
  }

  let cfOk = true;
  let refSet = current.set; // the Cloudflare list, as it stands after this run
  const toAdd = computeToAdd(merged, current.set);
  if (toAdd.length === 0) {
    console.log(`[SUCCESS] Cloudflare list already up to date (feed: ${merged.size} entries, list: ${current.total} items, nothing to add)`);
  } else {
    if (current.total + toAdd.length > MAX_ITEMS) {
      console.warn(`[WARN] Cloudflare list would reach ${current.total + toAdd.length} items, over the ${MAX_ITEMS} capacity; continuing anyway`);
    }
    cfOk = await addItemsToCf(cfg, toAdd);
    if (cfOk) {
      console.log(`[SUCCESS] added ${toAdd.length} new items to the Cloudflare list (feed: ${merged.size}, list total now ~${current.total + toAdd.length})`);
      refSet = new Set([...current.set, ...toAdd]);
    } else {
      console.error('[ABORT] some Cloudflare batches were rejected; re-run to retry (already-added items are safe to re-POST)');
    }
  }

  let cdnOk = true;
  if (cfg.cdnfly) {
    const r = await syncCdnfly(cfg.cdnfly, refSet);
    if (!r.ok) cdnOk = false;
  } else {
    console.log('[INFO] cdnfly sync disabled (no CDNFLY_BASE_URL)');
  }
  if (cfg.goedge) {
    const r = await syncGoedge(cfg.goedge, refSet);
    if (!r.ok) cdnOk = false;
  } else {
    console.log('[INFO] goedge sync disabled (no GOEDGE_BASE_URL)');
  }

  if (cfOk && cdnOk) {
    console.log('[DONE] sync done: Cloudflare list + both CDNs in sync');
    return 0;
  }
  return 1;
}
