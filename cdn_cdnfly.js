// ─── cdnfly CDN sync ───
//
// The admin is a cdnfly-class panel that keeps its WAF blocklist
// inside a global "openresty-config" value (a JSON string). The blacklist
// lives in its `custom_black` field: one IP/CIDR per line, IPv4 and IPv6
// mixed. Updates are a full-value PUT to /v1/configs/:id, so we must read
// the value first and only ever append missing lines.
//
// Verified live (2026-09): GET/PUT with `api-key`/`api-secret` headers
// work; a no-op PUT returns {"code":0,"msg":"更新config成功"} and triggers
// the panel's config push to the nodes.
//
// Sync semantics (add-only, same as the Cloudflare step):
//   existing = normalized set of current custom_black lines
//   toAdd    = cfSet − existing
//   write    = original custom_black lines + toAdd appended; all other
//              fields of the config value are passed through untouched.
// A failed read aborts the CDN sync (no write); a failed PUT leaves the
// previous value in place and is retried on the next run.

import { normalizeCfItem } from './sync_blocklist.js';

const FETCH_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const UA = 'cf-blocklist-sync/1.0';
const timedOut = (e) => e.name === 'AbortError' || e.name === 'TimeoutError';

/**
 * @typedef {{baseUrl: string, apiKey: string, apiSecret: string, wafConfigId: string}} CdnflyCfg
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   added: number,
 *   existing: number,
 *   error?: string,
 * }} CdnflyResult
 */

function headers(cfg) {
  return { 'User-Agent': UA, 'api-key': cfg.apiKey, 'api-secret': cfg.apiSecret };
}

/**
 * Fetch and decode the WAF config value object.
 * @param {CdnflyCfg} cfg
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Record<string, any> | null>} the decoded value, or null on failure
 */
export async function fetchCdnflyWafConfig(cfg, fetchImpl = fetch) {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/configs/${cfg.wafConfigId}`;
  try {
    const res = await fetchImpl(url, {
      headers: headers(cfg),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.code !== 0 || !data.data) {
      console.error(`[ERROR] cdnfly config read HTTP ${res.status}: ${JSON.stringify(data)}`);
      return null;
    }
    const raw = data.data.value;
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof value.custom_black !== 'string') {
      console.error('[ERROR] cdnfly config value has no custom_black field');
      return null;
    }
    return value;
  } catch (e) {
    console.error(`[ERROR] cdnfly config read: ${timedOut(e) ? 'timeout' : e.message}`);
    return null;
  }
}

/**
 * Write the WAF config value back (full-value PUT).
 * @param {CdnflyCfg} cfg
 * @param {Record<string, any>} value
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean>}
 */
export async function putCdnflyWafConfig(cfg, value, fetchImpl = fetch) {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/configs/${cfg.wafConfigId}`;
  try {
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: { ...headers(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value) }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.code === 0) {
      return true;
    }
    console.error(`[ERROR] cdnfly config update HTTP ${res.status}: ${JSON.stringify(data)}`);
    return false;
  } catch (e) {
    console.error(`[ERROR] cdnfly config update: ${timedOut(e) ? 'timeout' : e.message}`);
    return false;
  }
}

/**
 * Normalized set of entries currently in custom_black.
 * @param {string} customBlack
 * @returns {Set<string>}
 */
export function cdnflyBlackSet(customBlack) {
  const set = new Set();
  for (const line of customBlack.split(/\r?\n/)) {
    const norm = normalizeCfItem(line);
    if (norm !== null) set.add(norm);
  }
  return set;
}

/**
 * Append missing entries to the custom_black field of the value object.
 * Original lines are preserved byte-for-byte; only trailing whitespace is
 * normalized before appending. Returns the number of lines appended.
 * @param {Record<string, any>} value - mutated in place
 * @param {string[]} toAdd
 * @returns {number}
 */
export function appendToCdnflyBlack(value, toAdd) {
  if (toAdd.length === 0) return 0;
  const trimmed = value.custom_black.replace(/\s+$/, '');
  value.custom_black = `${trimmed}\n${toAdd.join('\n')}`;
  return toAdd.length;
}

/**
 * Sync the cdnfly blacklist against a reference set (the Cloudflare list).
 * @param {CdnflyCfg} cfg
 * @param {Set<string>} cfSet - normalized entries the CDN should also have
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<CdnflyResult>}
 */
export async function syncCdnfly(cfg, cfSet, fetchImpl = fetch) {
  const value = await fetchCdnflyWafConfig(cfg, fetchImpl);
  if (value === null) return { ok: false, added: 0, existing: 0, error: 'read failed' };

  const existing = cdnflyBlackSet(value.custom_black);
  const toAdd = [...cfSet].filter((e) => !existing.has(e)).sort();
  console.log(`[INFO] cdnfly: existing=${existing.size} missing=${toAdd.length} (reference set: ${cfSet.size})`);

  if (toAdd.length === 0) {
    return { ok: true, added: 0, existing: existing.size };
  }

  const added = appendToCdnflyBlack(value, toAdd);
  if (await putCdnflyWafConfig(cfg, value, fetchImpl)) {
    console.log(`[SUCCESS] cdnfly: appended ${added} entries (custom_black now ${existing.size + added})`);
    return { ok: true, added, existing: existing.size };
  }
  return { ok: false, added: 0, existing: existing.size, error: 'PUT rejected' };
}
