// Cloudflare Lists API client.
//
// Cloudflare Lists API (verified against api.cloudflare.com, 2026):
// - Items route: /accounts/{id}/rules/lists/{list_id}/items (GET /lists/{id}/items is no longer routed).
// - POST body is a BARE JSON array [{"ip":...}]; idempotent (replaces, never deletes).
// - DELETE body is WRAPPED {"items":[{"id":...}]} (opposite of POST); one pending async op per account.
// - All mutations are async and return an operation_id.

import { normalizeCfItem } from './ip.js';
import { PUSH_TIMEOUT_MS, timedOut } from './http.js';

/** @typedef {import('./config.js').Config} Config */

/** @typedef {{name: string, message?: string}} ErrLike */
/** @typedef {{
 *   success?: boolean,
 *   errors?: Array<{code: number, message: string}>,
 *   result?: Array<{ip?: string}>,
 *   result_info?: {cursors?: {after?: string}},
 * }} CfApiResponse */

export const MAX_ITEMS = 10_000; // Cloudflare list capacity (free/standard plans)
const CF_PAGE_SIZE = 500; // API max per_page for GET items
const CF_BATCH_SIZE = 500; // items per POST; steady-state deltas are far smaller
const CF_MAX_PAGES = 200; // pagination safety bound (500 * 200 = 100k items)

/**
 * @param {Config} cfg
 * @param {string | undefined} cursor
 */
function cfItemsUrl(cfg, cursor) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/rules/lists/${cfg.cfListId}/items`;
  const params = new URLSearchParams({ per_page: String(CF_PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  return `${base}?${params}`;
}

/**
 * Read the current Cloudflare list via cursor pagination.
 * Returns { set, total } (normalized items, raw item count), or null on
 * failure — a failed read must abort the sync rather than re-add everything.
 * @param {Config} cfg
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{set: Set<string>, total: number} | null>}
 */
export async function fetchCfItems(cfg, fetchImpl = fetch) {
  const set = new Set();
  let total = 0;
  let cursor;
  try {
    for (let page = 0; page < CF_MAX_PAGES; page++) {
      const res = await fetchImpl(cfItemsUrl(cfg, cursor), {
        headers: { Authorization: `Bearer ${cfg.cfAuthToken}` },
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      const data = /** @type {CfApiResponse | null} */ (await res.json().catch(() => null));
      if (!res.ok || !data || data.success !== true) {
        console.error(`[ERROR] Cloudflare list read HTTP ${res.status}: ${JSON.stringify(data && data.errors ? data.errors : data)}`);
        return null;
      }
      for (const item of data.result || []) {
        total += 1;
        const norm = normalizeCfItem(item.ip);
        if (norm !== null) set.add(norm);
      }
      cursor = data.result_info && data.result_info.cursors && data.result_info.cursors.after;
      if (!cursor) break;
    }
    console.log(`[INFO] Cloudflare list: ${total} items (${set.size} after normalization)`);
    return { set, total };
  } catch (e) {
    console.error(`[ERROR] Cloudflare list read: ${timedOut(e) ? 'timeout' : e.message}`);
    return null;
  }
}

/**
 * Append items to the Cloudflare list in batches (POST is idempotent:
 * entries already present are replaced, never deleted). Returns true when
 * every batch was accepted.
 * @param {Config} cfg
 * @param {string[]} items
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean>}
 */
export async function addItemsToCf(cfg, items, fetchImpl = fetch) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/rules/lists/${cfg.cfListId}/items`;
  let done = 0;
  for (let i = 0; i < items.length; i += CF_BATCH_SIZE) {
    const batch = items.slice(i, i + CF_BATCH_SIZE);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.cfAuthToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch.map((ip) => ({ ip }))), // BARE array body
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      const data = /** @type {CfApiResponse | null} */ (await res.json().catch(() => null));
      if (res.ok && data && data.success === true) {
        done += batch.length;
      } else {
        console.error(`[ERROR] Cloudflare add batch ${Math.floor(i / CF_BATCH_SIZE) + 1} HTTP ${res.status}: ${JSON.stringify(data && data.errors ? data.errors : data)}`);
        return false;
      }
    } catch (e) {
      console.error(`[ERROR] Cloudflare add batch ${Math.floor(i / CF_BATCH_SIZE) + 1}: ${timedOut(e) ? 'timeout' : e.message}`);
      return false;
    }
  }
  return done === items.length;
}
