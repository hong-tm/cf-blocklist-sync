#!/usr/bin/env node
// ─── How to run ───
// Manual one-shot sync:   node run_sync.js   (or: npm run sync)
// Scheduled via pm2 (daily at 12:00 local):
//   pm2 start ecosystem.config.cjs && pm2 save
// Tests:
//   node --test
// Config: .env at the project root; OS environment variables override.
// OS env vars override both.
// Must not auto-run here: pm2 loads this file via import()
// (ProcessContainerFork), which breaks argv[1]-based entry guards.
// The entry point is run_sync.js.
// ──────────────────

/**
 * Sync IP blocklist feeds into a Cloudflare list, then mirror the
 * result into two self-hosted CDNs — all INCREMENTAL.
 *
 * Each run:
 *   1. downloads the v4 + v6 feeds, validates/normalizes (ipaddr.js) and
 *      deduplicates them (notation variants such as expanded vs compressed
 *      IPv6 collapse to the same string);
 *   2. reads the current Cloudflare list items (cursor pagination);
 *   3. uploads ONLY feed entries missing from the Cloudflare list;
 *   4. reads each CDN's current blacklist, and pushes ONLY entries that
 *      are in the Cloudflare list but missing from the CDN.
 *
 * Add-only everywhere: entries that leave a source stay in the lists, so
 * per-run transfer volume is just the delta, not the whole list.
 *
 * Cloudflare Lists API notes (verified against api.cloudflare.com, 2026):
 *   - Routes live under /accounts/{id}/rules/lists/{list_id}/items
 *     (GET /lists/{id}/items is no longer routed).
 *   - POST body is a BARE JSON array [{"ip": ...}]; it is idempotent for
 *     entries already present (replaces, never deletes).
 *   - DELETE body is WRAPPED {"items": [{"id": ...}]} (opposite of POST);
 *     async ops are limited to one pending operation per account.
 *   - All mutations are asynchronous and return an operation_id.
 *
 * CDN notes: see cdn_cdnfly.js and cdn_goedge.js for the per-panel API
 * details; both were verified live against the running panels in 2026-09.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ipaddr from 'ipaddr.js';
import { syncCdnfly } from './cdn_cdnfly.js';
import { syncGoedge } from './cdn_goedge.js';

const MAX_ITEMS = 10_000; // Cloudflare list capacity (free/standard plans)
const FETCH_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const CF_PAGE_SIZE = 500; // API max per_page for GET items
const CF_BATCH_SIZE = 500; // items per POST; steady-state deltas are far smaller
const CF_MAX_PAGES = 200; // pagination safety bound (500 * 200 = 100k items)
const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, '.env');
const REQUIRED_KEYS = ['CF_AUTH_TOKEN', 'CF_ACCOUNT_ID', 'CF_LIST_ID', 'URL_IPV4', 'URL_IPV6'];
const timedOut = (e) => e.name === 'AbortError' || e.name === 'TimeoutError';

/**
 * @typedef {{baseUrl: string, apiKey: string, apiSecret: string, wafConfigId: string}} CdnflyCfg
 * @typedef {{baseUrl: string, username: string, password: string, v4ListId: string, v6ListId: string}} GoedgeCfg
 * @typedef {{
 *   cfAuthToken: string,
 *   cfAccountId: string,
 *   cfListId: string,
 *   feedUrls: string[],
 *   cdnfly: CdnflyCfg | null,
 *   goedge: GoedgeCfg | null,
 * }} Config
 */

/**
 * Load config from the .env file; OS environment variables override file
 * values. CDN sections are optional — a CDN is enabled only when its
 * BASE_URL is present.
 */
export function loadConfig(envFile = ENV_FILE, env = process.env) {
  /** @type {Map<string, string>} */
  const values = new Map();
  try {
    for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      values.set(t.slice(0, i).trim(), t.slice(i + 1).trim().replace(/^['"]|['"]$/g, ''));
    }
  } catch (e) {
    throw new Error(`cannot read ${envFile}: ${e.message}`);
  }
  for (const [k, v] of Object.entries(env)) if (v) values.set(k, v);
  const missing = REQUIRED_KEYS.filter((k) => !values.get(k));
  if (missing.length > 0) {
    throw new Error(`missing config in ${envFile}: ${missing.join(', ')}`);
  }
  const cdnfly = values.get('CDNFLY_BASE_URL')
    ? {
        baseUrl: values.get('CDNFLY_BASE_URL'),
        apiKey: values.get('CDNFLY_API_KEY') ?? '',
        apiSecret: values.get('CDNFLY_API_SECRET') ?? '',
        wafConfigId: values.get('CDNFLY_WAF_CONFIG_ID') ?? 'global-0-openresty_config-openresty-config',
      }
    : null;
  const goedge = values.get('GOEDGE_BASE_URL')
    ? {
        baseUrl: values.get('GOEDGE_BASE_URL'),
        username: values.get('GOEDGE_USERNAME') ?? '',
        password: values.get('GOEDGE_PASSWORD') ?? '',
        v4ListId: values.get('GOEDGE_V4_LIST_ID') ?? '',
        v6ListId: values.get('GOEDGE_V6_LIST_ID') ?? '',
      }
    : null;
  return {
    cfAuthToken: values.get('CF_AUTH_TOKEN'),
    cfAccountId: values.get('CF_ACCOUNT_ID'),
    cfListId: values.get('CF_LIST_ID'),
    feedUrls: [values.get('URL_IPV4'), values.get('URL_IPV6')],
    cdnfly,
    goedge,
  };
}

/** True for dotted-quad tokens whose octets have leading zeros (ambiguous decimal/octal). */
function hasLeadingZeroOctets(token) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(token)) return false;
  return token.split('.').some((p) => p.length > 1 && p.startsWith('0'));
}

/**
 * Normalize one feed line to a canonical IP or CIDR string, or null for
 * blank/comment/garbage lines. Notation variants (expanded vs compressed
 * IPv6) normalize to the same string, which is what makes set-based
 * deduplication exact.
 */
export function parseEntry(raw) {
  const stripped = raw.trim();
  if (!stripped || stripped.startsWith('#')) return null;
  const token = stripped.split(/\s+/)[0];
  const slashParts = token.split('/');
  if (slashParts.length > 2) return null;
  try {
    if (slashParts.length === 2) {
      const [addr, prefix] = ipaddr.parseCIDR(token); // throws on malformed
      if (prefix > (addr instanceof ipaddr.IPv4 ? 32 : 128)) return null;
      if (addr instanceof ipaddr.IPv4 && hasLeadingZeroOctets(slashParts[0])) return null;
      return `${addr.toString()}/${prefix}`;
    }
    const addr = ipaddr.parse(token); // throws on malformed
    if (addr instanceof ipaddr.IPv4 && hasLeadingZeroOctets(token)) return null;
    return addr.toString();
  } catch {
    return null;
  }
}

/**
 * Normalize a Cloudflare list item for comparison against feed entries.
 * Returns null for empty values; unparseable values keep their raw (trimmed)
 * form so they never collide with feed entries and are left in place.
 */
export function normalizeCfItem(raw) {
  const stripped = (raw ?? '').trim();
  if (!stripped) return null;
  return parseEntry(stripped) ?? stripped;
}

/** Union of all feed entries; duplicates collapse to one canonical form. */
export function mergeFeeds(...results) {
  const merged = new Set();
  for (const r of results) for (const e of r.entries) merged.add(e);
  return merged;
}

/**
 * Feed entries missing from the current Cloudflare list (add-only diff).
 * Both sets must contain normalized strings; order-independent.
 */
export function computeToAdd(feedSet, cfSet) {
  const toAdd = [...feedSet].filter((e) => !cfSet.has(e));
  toAdd.sort();
  return toAdd;
}

/** Fetch one feed; returns its entries, normalized and deduplicated. */
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
      const data = await res.json().catch(() => null);
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
      const data = await res.json().catch(() => null);
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

  // ── Step: Cloudflare ──
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

  // ── Steps: CDNs (reference set = the Cloudflare list, add-only diff) ──
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
