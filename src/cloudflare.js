// Cloudflare Lists API client.
//
// Cloudflare Lists API (verified against api.cloudflare.com, 2026):
// - Items route: /accounts/{id}/rules/lists/{list_id}/items (GET /lists/{id}/items is no longer routed).
// - POST body is a BARE JSON array [{"ip":...}]; idempotent (replaces, never deletes).
// - DELETE body is WRAPPED {"items":[{"id":...}]} (opposite of POST); one pending async op per account.
// - All mutations are async and return an operation_id.

import { normalizeCfItem } from './ip.js';
import { FETCH_TIMEOUT_MS, PUSH_TIMEOUT_MS, timedOut } from './http.js';

/** @typedef {import('./config.js').Config} Config */

/** @typedef {{
 *   success?: boolean,
 *   errors?: Array<{code: number, message: string}>,
 *   result?: Array<{ip?: string}>,
 *   result_info?: {cursors?: {after?: string}},
 * }} CfApiResponse */

/** @typedef {CfApiResponse & {result?: {operation_id?: string}}} CfWriteResponse */
/** @typedef {{success?: boolean, errors?: unknown, result?: {status?: string, error?: string}}} CfOperationResponse */

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const MAX_ITEMS = 10_000; // Cloudflare list capacity (free/standard plans)
const CF_PAGE_SIZE = 500; // API max per_page for GET items
const CF_BATCH_SIZE = 500; // items per POST; steady-state deltas are far smaller
const CF_MAX_PAGES = 200; // pagination safety bound (500 * 200 = 100k items)
const CF_OP_POLL_MS = 1000; // delay between bulk operation status reads
const CF_OP_MAX_POLLS = 120; // give up on one bulk operation after about 2 minutes

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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    if (cursor) {
      // A truncated read would make the diff re-add items that are already listed.
      console.error(`[ERROR] Cloudflare list read: still paginating after ${CF_MAX_PAGES} pages; aborting`);
      return null;
    }
    console.log(`[INFO] Cloudflare list: ${total} items (${set.size} after normalization)`);
    return { set, total };
  } catch (e) {
    console.error(`[ERROR] Cloudflare list read: ${timedOut(e) ? 'timeout' : e.message}`);
    return null;
  }
}

/**
 * Wait until one bulk operation finishes. The first status read has no delay.
 * Network errors propagate to the caller's handler.
 * @param {Config} cfg
 * @param {string} operationId
 * @param {typeof fetch} fetchImpl
 * @param {(ms: number) => Promise<unknown>} sleep
 * @returns {Promise<boolean>} true only when the operation completed
 */
async function waitForOperation(cfg, operationId, fetchImpl, sleep) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/rules/lists/bulk_operations/${operationId}`;
  for (let poll = 0; poll < CF_OP_MAX_POLLS; poll++) {
    if (poll > 0) await sleep(CF_OP_POLL_MS);
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${cfg.cfAuthToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const reply = /** @type {CfOperationResponse | null} */ (await res.json().catch(() => null));
    if (!res.ok || !reply || reply.success !== true) {
      console.error(`[ERROR] Cloudflare operation ${operationId} read HTTP ${res.status}: ${JSON.stringify(reply && reply.errors ? reply.errors : reply)}`);
      return false;
    }
    const status = reply.result?.status;
    if (status === 'completed') return true;
    if (status === 'failed') {
      console.error(`[ERROR] Cloudflare operation ${operationId} failed: ${reply.result?.error ?? 'no error detail'}`);
      return false;
    }
  }
  console.error(`[ERROR] Cloudflare operation ${operationId} still pending after ${CF_OP_MAX_POLLS} status reads`);
  return false;
}

/**
 * Append items to the Cloudflare list in batches (POST is idempotent:
 * entries already present are replaced, never deleted). Each POST only queues
 * a bulk operation and Cloudflare answers 429 while one is pending, so every
 * batch waits for its operation. Returns true when every batch was applied.
 * @param {Config} cfg
 * @param {string[]} items
 * @param {typeof fetch} fetchImpl
 * @param {(ms: number) => Promise<unknown>} [sleep] - injected by tests
 * @returns {Promise<boolean>}
 */
export async function addItemsToCf(cfg, items, fetchImpl = fetch, sleep = delay) {
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
        body: JSON.stringify(batch.map((ip) => ({ ip }))),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      const data = /** @type {CfWriteResponse | null} */ (await res.json().catch(() => null));
      if (res.ok && data && data.success === true) {
        const operationId = data.result?.operation_id;
        if (operationId && !(await waitForOperation(cfg, operationId, fetchImpl, sleep))) return false;
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
