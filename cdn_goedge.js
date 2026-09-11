// ─── goedge CDN sync ───
//
// The admin is a GoEdge (EdgeAdmin v1.x) panel. Its API is
// session-based (no api-key), and every POST is guarded by a single-use
// CSRF token. All of the following was verified live against this build
// (v1.1.5) on 2026-09:
//
//   1. GET  /csrf/token                 -> {"code":200,"data":{"token":"..."}}
//      (token = base64(sha256(secret+ts)); single-use, ~30 min TTL)
//   2. GET  /                           -> login page HTML carrying
//      window.X_VIEW_DATA = {..., "token":"<md5+ts>"} (login token, 30 min)
//   3. POST /  (form-urlencoded)        -> login. Fields: token, username,
//      password = MD5 hex of the real password (server compares against
//      the stored hash; plaintext fails), otp_code, remember=on, csrfToken.
//      Success: {"code":200,"data":{"ip","localSid","requireOTP":false}}
//      plus Set-Cookie <session-cookie> (name is build-specific;
//      upstream calls it "geadsid" — capture it from the
//      response, never hardcode).
//   4. Authenticated requests: plain Cookie header + a browser-like
//      User-Agent (the panel's security filter rejects empty/search-engine
//      UAs with a bare 403).
//   5. GET  /servers/iplists/exportData?listId=N&format=txt
//      -> full list, one line per item:
//         value,expiredAt,type,eventLevel,reason   (note: this build maps
//         params as camelCase "listId", unlike upstream "list_id")
//   6. POST /servers/iplists/import (multipart: listId, csrfToken, file)
//      -> {"code":200,"data":{"count":N,"countIgnore":M}}. The file must be
//      named *.txt; one entry per line. Lines with extra comma fields get
//      expiredAt etc.; a bare IP is stored permanently (expiredAt=0).
//
// The panel keeps two global blacklists: an IPv4 list and an IPv6 list
// (GOEDGE_V4_LIST_ID / GOEDGE_V6_LIST_ID in .env). This client routes
// entries by family and imports each delta with import batches of 500.
// A failed batch triggers a re-export + re-diff so partially created items
// are never re-sent.

import { createHash } from 'node:crypto';
import { normalizeCfItem } from './sync_blocklist.js';

const FETCH_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const IMPORT_BATCH = 500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/**
 * @typedef {{baseUrl: string, username: string, password: string, v4ListId: string, v6ListId: string}} GoedgeCfg
 */

/**
 * @typedef {{ok: boolean, added: number, existing: number, error?: string}} GoedgeResult
 */

/** MD5 hex — the panel's LoginAdmin compares against the stored MD5 hash. */
export function md5hex(s) {
  return createHash('md5').update(s, 'utf-8').digest('hex');
}

/**
 * Extract the window.X_VIEW_DATA JSON object from an SPA shell page.
 * @param {string} html
 * @returns {Record<string, any> | null}
 */
export function parseXViewData(html) {
  const m = html.match(/window\.X_VIEW_DATA = (.*);/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * @typedef {{cookie: string}} GoedgeSession
 */

/**
 * Log in to the panel. Captures the session cookie generically from the
 * login response (the cookie name differs between builds).
 * @param {GoedgeCfg} cfg
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<GoedgeSession | null>}
 */
export async function goedgeLogin(cfg, fetchImpl = fetch) {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const baseHeaders = { 'User-Agent': UA };

  // 1. fresh CSRF token (JSON response)
  const csrfRes = await fetchImpl(`${base}/csrf/token`, {
    headers: baseHeaders,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const csrfData = await csrfRes.json().catch(() => null);
  const csrfToken = csrfData && csrfData.data && csrfData.data.token;
  if (!csrfRes.ok || !csrfToken) {
    console.error(`[ERROR] goedge /csrf/token HTTP ${csrfRes.status}: ${JSON.stringify(csrfData)}`);
    return null;
  }

  // 2. login page token (embedded in the page shell)
  const pageRes = await fetchImpl(`${base}/`, {
    headers: baseHeaders,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const pageData = parseXViewData(await pageRes.text());
  const pageToken = pageData && pageData.token;
  if (!pageRes.ok || !pageToken) {
    console.error(`[ERROR] goedge login page HTTP ${pageRes.status}`);
    return null;
  }

  // 3. login (password is sent as MD5 hex — plaintext is rejected)
  const form = new URLSearchParams();
  form.set('token', pageToken);
  form.set('username', cfg.username);
  form.set('password', md5hex(cfg.password));
  form.set('otp_code', '');
  form.set('remember', 'on');
  form.set('csrfToken', csrfToken);
  const loginRes = await fetchImpl(`${base}/`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  const loginData = await loginRes.json().catch(() => null);
  const cookieHeader = (loginRes.headers && loginRes.headers.get('set-cookie')) || '';
  const firstPair = cookieHeader.split(';')[0].trim();
  const eq = firstPair.indexOf('=');
  if (!loginRes.ok || !loginData || loginData.code !== 200 || eq < 1) {
    console.error(`[ERROR] goedge login HTTP ${loginRes.status}: ${JSON.stringify(loginData)}`);
    return null;
  }
  console.log(`[INFO] goedge: logged in as ${cfg.username}`);
  return { cookie: firstPair };
}

/**
 * @param {GoedgeCfg} cfg
 * @param {GoedgeSession} session
 * @param {string} path - e.g. /servers/iplists/exportData?listId=4&format=txt
 * @param {typeof fetch} fetchImpl
 */
async function goedgeFetch(cfg, session, path, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
    headers: { 'User-Agent': UA, Cookie: session.cookie },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[ERROR] goedge GET ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return res;
}

/**
 * Export one IP list; returns the set of normalized entries in it.
 * @param {GoedgeCfg} cfg
 * @param {GoedgeSession} session
 * @param {string} listId
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Set<string> | null>}
 */
export async function goedgeExportList(cfg, session, listId, fetchImpl = fetch) {
  const res = await goedgeFetch(cfg, session, `/servers/iplists/exportData?listId=${listId}&format=txt`, fetchImpl);
  if (res === null) return null;
  const text = await res.text();
  const set = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const value = line.split(',')[0].trim(); // export line: value,expiredAt,type,eventLevel,reason
    const norm = normalizeCfItem(value);
    if (norm !== null) set.add(norm);
  }
  return set;
}

/**
 * Import one batch of entries into an IP list (multipart upload).
 * @param {GoedgeCfg} cfg
 * @param {GoedgeSession} session
 * @param {string} listId
 * @param {string[]} entries
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ok: boolean, landed: number}>} landed = count − countIgnore
 */
async function goedgeImportBatch(cfg, session, listId, entries, fetchImpl = fetch) {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const tokenRes = await fetchImpl(`${base}/csrf/token`, {
    headers: { 'User-Agent': UA, Cookie: session.cookie },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const tokenData = await tokenRes.json().catch(() => null);
  const csrfToken = tokenData && tokenData.data && tokenData.data.token;
  if (!tokenRes.ok || !csrfToken) {
    console.error(`[ERROR] goedge /csrf/token (import) HTTP ${tokenRes.status}`);
    return { ok: false, landed: 0 };
  }

  const fd = new FormData();
  fd.append('listId', listId);
  fd.append('csrfToken', csrfToken);
  fd.append('file', new Blob([`${entries.join('\n')}\n`], { type: 'text/plain' }), 'blocklist-sync.txt');
  const res = await fetchImpl(`${base}/servers/iplists/import`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Cookie: session.cookie },
    body: fd,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data && data.code === 200) {
    const { count = 0, countIgnore = 0 } = data.data || {};
    if (countIgnore > 0) console.warn(`[WARN] goedge import: ${countIgnore} lines ignored by the panel`);
    return { ok: true, landed: count - countIgnore };
  }
  console.error(`[ERROR] goedge import HTTP ${res.status}: ${JSON.stringify(data)}`);
  return { ok: false, landed: 0 };
}

/** True for normalized IPv6 entries (contain ':'). */
function isV6(entry) {
  return entry.includes(':');
}

/**
 * Import entries into one list with batched uploads. A failed batch may
 * have been partially applied, so we re-export and re-diff before
 * continuing; if nothing landed we retry the same batch once, then give
 * up on this list (the next daily run picks the rest back up — the diff
 * is recomputed from a fresh export every time).
 * @param {GoedgeCfg} cfg
 * @param {GoedgeSession} session
 * @param {string} listId
 * @param {string[]} toAdd
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<number>} number of entries confirmed added
 */
async function importIntoList(cfg, session, listId, toAdd, fetchImpl = fetch) {
  let pending = [...toAdd];
  let added = 0;
  while (pending.length > 0) {
    const batch = pending.slice(0, IMPORT_BATCH);
    const first = await goedgeImportBatch(cfg, session, listId, batch, fetchImpl);
    if (first.ok) {
      added += first.landed;
      pending = pending.slice(batch.length);
      continue;
    }
    const existing = await goedgeExportList(cfg, session, listId, fetchImpl);
    if (existing === null) break;
    const remaining = pending.filter((e) => !existing.has(e));
    if (remaining.length < pending.length) {
      // Part of the batch was applied: count it and continue with the rest.
      added += pending.length - remaining.length;
      pending = remaining;
      continue;
    }
    // Nothing landed: retry the same batch once.
    const retry = await goedgeImportBatch(cfg, session, listId, batch, fetchImpl);
    if (!retry.ok) break;
    added += retry.landed;
    pending = pending.slice(batch.length);
  }
  return added;
}

/**
 * Sync the two goedge blacklists against a reference set (the Cloudflare
 * list). IPv4 entries go to the v4 list, IPv6 to the v6 list. Add-only.
 * @param {GoedgeCfg} cfg
 * @param {Set<string>} cfSet - normalized entries the CDN should also have
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<GoedgeResult>}
 */
export async function syncGoedge(cfg, cfSet, fetchImpl = fetch) {
  const session = await goedgeLogin(cfg, fetchImpl);
  if (session === null) return { ok: false, added: 0, existing: 0, error: 'login failed' };

  let ok = true;
  let added = 0;
  let existing = 0;

  /** @type {[string, (e: string) => boolean][]} */
  const targets = [
    [cfg.v4ListId, (e) => !isV6(e)],
    [cfg.v6ListId, (e) => isV6(e)],
  ];

  for (const [listId, family] of targets) {
    const wanted = [...cfSet].filter(family);
    const cur = await goedgeExportList(cfg, session, listId, fetchImpl);
    if (cur === null) {
      ok = false;
      continue;
    }
    existing += cur.size;
    const toAdd = wanted.filter((e) => !cur.has(e)).sort();
    console.log(`[INFO] goedge list ${listId}: existing=${cur.size} missing=${toAdd.length} (wanted: ${wanted.length})`);
    if (toAdd.length > 0) {
      const n = await importIntoList(cfg, session, listId, toAdd, fetchImpl);
      added += n;
      if (n < toAdd.length) ok = false;
    }
  }

  if (ok) console.log(`[SUCCESS] goedge: added ${added} entries total (existing: ${existing})`);
  return { ok, added, existing };
}
