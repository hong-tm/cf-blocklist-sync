// Orchestration: feeds -> Cloudflare list -> CDN mirrors, all add-only/incremental
// (per-run transfer is just the delta).
//
// Must not auto-run here: pm2 loads the entry point via import() (ProcessContainerFork),
// which breaks argv[1] entry guards. Entry point: ../run_sync.js.

import { loadConfig } from './config.js';
import { fetchFeed, mergeFeeds } from './feed.js';
import { computeToAdd } from './diff.js';
import { fetchCfItems, addItemsToCf, MAX_ITEMS } from './cloudflare.js';
import { syncCdnfly } from './cdn_cdnfly.js';
import { syncGoedge } from './cdn_goedge.js';

/** @typedef {import('./config.js').Config} Config */

/**
 * Cloudflare step: read the list, add the feed delta (add-only).
 * @param {Config} cfg
 * @param {Set<string>} feedSet - merged feed entries
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ok: boolean, refSet: Set<string>} | null>} null when the list read fails
 */
export async function syncCloudflare(cfg, feedSet, fetchImpl = fetch) {
  const current = await fetchCfItems(cfg, fetchImpl);
  if (current === null) {
    console.error('[ABORT] could not read current Cloudflare list; lists left untouched');
    return null;
  }

  let ok = true;
  let refSet = current.set; // the Cloudflare list, as it stands after this run
  const toAdd = computeToAdd(feedSet, current.set);
  if (toAdd.length === 0) {
    console.log(`[SUCCESS] Cloudflare list already up to date (feed: ${feedSet.size} entries, list: ${current.total} items, nothing to add)`);
  } else {
    if (current.total + toAdd.length > MAX_ITEMS) {
      console.warn(`[WARN] Cloudflare list would reach ${current.total + toAdd.length} items, over the ${MAX_ITEMS} capacity; continuing anyway`);
    }
    ok = await addItemsToCf(cfg, toAdd, fetchImpl);
    if (ok) {
      console.log(`[SUCCESS] added ${toAdd.length} new items to the Cloudflare list (feed: ${feedSet.size}, list total now ~${current.total + toAdd.length})`);
      refSet = new Set([...current.set, ...toAdd]);
    } else {
      console.error('[ABORT] some Cloudflare batches were rejected; re-run to retry (already-added items are safe to re-POST)');
    }
  }
  return { ok, refSet };
}

/**
 * CDN mirror step: push refSet to cdnfly and GoEdge when enabled.
 * @param {Config} cfg
 * @param {Set<string>} refSet
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean>}
 */
export async function syncCdnMirrors(cfg, refSet, fetchImpl = fetch) {
  let cdnOk = true;
  if (cfg.cdnfly) {
    const r = await syncCdnfly(cfg.cdnfly, refSet, fetchImpl);
    if (!r.ok) cdnOk = false;
  } else {
    console.log('[INFO] cdnfly sync disabled (no CDNFLY_BASE_URL)');
  }
  if (cfg.goedge) {
    const r = await syncGoedge(cfg.goedge, refSet, fetchImpl);
    if (!r.ok) cdnOk = false;
  } else {
    console.log('[INFO] goedge sync disabled (no GOEDGE_BASE_URL)');
  }
  return cdnOk;
}

/**
 * Full run. A failed feed does not stop the sync of the entries that were
 * fetched, but it makes the run exit 1 so pm2 retries it.
 * @param {Config} [cfg]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number>} exit code
 */
export async function main(cfg = loadConfig(), fetchImpl = fetch) {
  const results = await Promise.all(cfg.feedUrls.map((url) => fetchFeed(url, fetchImpl)));
  const merged = mergeFeeds(...results);
  if (merged.size === 0) {
    console.error('[ABORT] no valid entries fetched; all lists left untouched');
    return 1;
  }
  const failedFeeds = results.filter((r) => !r.ok).length;
  if (failedFeeds > 0) {
    console.warn(`[WARN] ${failedFeeds} of ${results.length} feeds failed; syncing the ${merged.size} entries that were fetched`);
  }

  const cf = await syncCloudflare(cfg, merged, fetchImpl);
  if (cf === null) return 1;
  const cdnOk = await syncCdnMirrors(cfg, cf.refSet, fetchImpl);
  if (cf.ok && cdnOk && failedFeeds === 0) {
    const targets = ['Cloudflare list', cfg.cdnfly && 'cdnfly', cfg.goedge && 'goedge'].filter(Boolean);
    console.log(`[DONE] sync done: ${targets.join(' + ')} in sync`);
    return 0;
  }
  console.error('[ERROR] sync incomplete: a feed, the Cloudflare write or a CDN mirror failed (see above); exit 1');
  return 1;
}
