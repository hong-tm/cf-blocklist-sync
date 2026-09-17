// Feed fetching plus the add-only set algebra (union, diff).

import { parseEntry } from './ip.js';
import { FETCH_TIMEOUT_MS, timedOut } from './http.js';

/**
 * @typedef {{entries: Set<string>, rejected: number}} FeedResult
 */

/**
 * Fetch one feed; returns its entries, normalized and deduplicated.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<FeedResult>}
 */
export async function fetchFeed(url, fetchImpl = fetch) {
  const host = new URL(url).hostname;
  const entries = new Set();
  let rejected = 0;
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'cf-blocklist-sync/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[ERROR] feed fetch failed (${host}): HTTP ${res.status}`);
      return { entries, rejected };
    }
    const content = await res.text();
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = parseEntry(line);
      if (entry === null) {
        if (!line.trim().startsWith('#')) rejected += 1;
      } else {
        entries.add(entry);
      }
    }
    console.log(`[INFO] ${host}: ${entries.size} unique entries (${rejected} unparseable lines discarded)`);
  } catch (e) {
    console.error(`[ERROR] feed fetch failed (${host}): ${timedOut(e) ? 'timeout' : e.message}`);
  }
  return { entries, rejected };
}

/**
 * Union of all feed entries; duplicates collapse to one canonical form.
 * @param {...FeedResult} results
 * @returns {Set<string>}
 */
export function mergeFeeds(...results) {
  const merged = new Set();
  for (const r of results) for (const e of r.entries) merged.add(e);
  return merged;
}

/**
 * Feed entries missing from the current Cloudflare list (add-only diff).
 * Both sets must contain normalized strings; order-independent.
 * @param {Set<string>} feedSet
 * @param {Set<string>} cfSet
 * @returns {string[]}
 */
export function computeToAdd(feedSet, cfSet) {
  const toAdd = [...feedSet].filter((e) => !cfSet.has(e));
  toAdd.sort();
  return toAdd;
}
