// Feed fetching plus feed merging (the union of all feed entries).

import { parseEntry } from './ip.js';
import { FETCH_TIMEOUT_MS, timedOut } from './http.js';

/**
 * @typedef {{entries: Set<string>, rejected: number, ok: boolean}} FeedResult
 */

/**
 * Fetch one feed; returns its entries, normalized and deduplicated.
 * ok is false when the fetch failed or the feed yielded no valid entry, so
 * the caller can report the run as failed instead of silently syncing less.
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
      return { entries, rejected, ok: false };
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
    if (entries.size === 0) {
      console.error(`[ERROR] feed ${host} returned no valid entries (${rejected} unparseable lines)`);
      return { entries, rejected, ok: false };
    }
    console.log(`[INFO] ${host}: ${entries.size} unique entries (${rejected} unparseable lines discarded)`);
    return { entries, rejected, ok: true };
  } catch (e) {
    console.error(`[ERROR] feed fetch failed (${host}): ${timedOut(e) ? 'timeout' : e.message}`);
    return { entries, rejected, ok: false };
  }
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

