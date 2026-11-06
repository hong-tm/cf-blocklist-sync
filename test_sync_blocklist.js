import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntry, normalizeCfItem, isPrivateOrLocal } from './src/ip.js';
import { fetchFeed, mergeFeeds } from './src/feed.js';
import { computeToAdd } from './src/diff.js';
import { fetchCfItems, addItemsToCf } from './src/cloudflare.js';
import { loadConfig, ENV_FILE } from './src/config.js';
import { syncCloudflare, syncCdnMirrors, main } from './src/main.js';

const V6_EXPANDED = '2001:0db8:0000:0000:0000:0000:0000:0001';
const V6_COMPRESSED = '2001:db8::1';
const OP_COMPLETED = () => fakeResponse({ success: true, result: { id: 'op', status: 'completed' } });

test('parseEntry: bare v4 stays canonical', () => {
  assert.equal(parseEntry('1.2.3.4'), '1.2.3.4');
});

test('parseEntry: bare v6 stays canonical', () => {
  assert.equal(parseEntry(V6_COMPRESSED), V6_COMPRESSED);
});

test('parseEntry: expanded v6 normalizes to compressed form', () => {
  assert.equal(parseEntry(V6_EXPANDED), V6_COMPRESSED);
});

test('parseEntry: v4 CIDR preserved', () => {
  assert.equal(parseEntry('10.0.0.0/8'), '10.0.0.0/8');
});

test('parseEntry: v6 CIDR preserved', () => {
  assert.equal(parseEntry('2001:db8::/32'), '2001:db8::/32');
});

test('parseEntry: trailing columns ignored, first token wins', () => {
  assert.equal(parseEntry('1.2.3.4  2025-01-01  active'), '1.2.3.4');
});

test('parseEntry: blank or comment -> null', () => {
  assert.equal(parseEntry('   '), null);
  assert.equal(parseEntry('# comment'), null);
});

test('parseEntry: garbage or malformed -> null', () => {
  assert.equal(parseEntry('not-an-ip'), null);
  assert.equal(parseEntry('1.2.3.4.5'), null);
  assert.equal(parseEntry('010.001.002.003'), null); // leading zeros = ambiguous
  assert.equal(parseEntry('1.2.3.4/33'), null);
  assert.equal(parseEntry('2001:db8::/129'), null);
});

test('dedupe: repeated line in one feed -> single entry', () => {
  const entries = new Set();
  for (const line of ['7.7.7.7', '7.7.7.7', '7.7.7.7']) {
    const e = parseEntry(line);
    if (e !== null) entries.add(e);
  }
  assert.deepEqual(entries, new Set(['7.7.7.7']));
});

test('dedupe: same IP present in both feeds counted once', () => {
  const v4 = { entries: new Set(['9.9.9.9', '1.2.3.4']), rejected: 0 };
  const v6 = { entries: new Set(['1.2.3.4']), rejected: 0 };
  assert.deepEqual(mergeFeeds(v4, v6), new Set(['9.9.9.9', '1.2.3.4']));
});

test('dedupe: notation variants across feeds collapse to one entry', () => {
  const a = { entries: new Set([parseEntry(V6_EXPANDED)]), rejected: 0 };
  const b = { entries: new Set([parseEntry(V6_COMPRESSED)]), rejected: 0 };
  assert.deepEqual(mergeFeeds(a, b), new Set([V6_COMPRESSED]));
});

test('mergeFeeds: no feeds -> empty set', () => {
  assert.deepEqual(mergeFeeds(), new Set());
});

test('normalizeCfItem: canonical values pass through', () => {
  assert.equal(normalizeCfItem('1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeCfItem('10.0.0.0/8'), '10.0.0.0/8');
});

test('normalizeCfItem: expanded v6 normalizes to compressed form', () => {
  assert.equal(normalizeCfItem(V6_EXPANDED), V6_COMPRESSED);
});

test('normalizeCfItem: unparseable values keep raw form (left in place, never collide)', () => {
  assert.equal(normalizeCfItem('not-an-ip'), 'not-an-ip');
  assert.equal(normalizeCfItem('  9.9.9.9  '), '9.9.9.9');
  assert.equal(normalizeCfItem(''), null);
  assert.equal(normalizeCfItem(null), null);
});

test('computeToAdd: returns feed entries missing from the CF list, sorted', () => {
  const feed = new Set(['1.2.3.4', '5.6.7.8', '9.9.9.9']);
  const cf = new Set(['1.2.3.4']);
  assert.deepEqual(computeToAdd(feed, cf), ['5.6.7.8', '9.9.9.9']);
});

test('computeToAdd: nothing to add when feed is a subset of the list', () => {
  assert.deepEqual(computeToAdd(new Set(['1.2.3.4']), new Set(['1.2.3.4', '5.6.7.8'])), []);
});

test('computeToAdd: empty feed -> nothing to add (nothing is ever removed)', () => {
  assert.deepEqual(computeToAdd(new Set(), new Set(['1.2.3.4'])), []);
});

test('computeToAdd: notation variants already in the list are not re-added', () => {
  const feed = new Set([V6_COMPRESSED]);
  const cf = new Set([normalizeCfItem(V6_EXPANDED)]);
  assert.deepEqual(computeToAdd(feed, cf), []);
});

// fetchImpl is mocked in the tests below; no live endpoints are touched.
function fakeResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function textResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => body };
}

const CFG = { cfAuthToken: 't', cfAccountId: 'a', cfListId: 'l', feedUrls: [] };

test('fetchCfItems: follows cursor pagination and normalizes items', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!url.includes('cursor=')) {
      return fakeResponse({
        success: true,
        result: [{ id: '1', ip: '1.1.1.1' }, { id: '2', ip: V6_EXPANDED }],
        result_info: { cursors: { after: 'CUR1' } },
      });
    }
    return fakeResponse({
      success: true,
      result: [{ id: '3', ip: '9.9.9.9' }, { id: '4', ip: 'weird-entry' }],
      result_info: {},
    });
  };
  const out = await fetchCfItems(CFG, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(out.total, 4);
  assert.deepEqual(out.set, new Set(['1.1.1.1', V6_COMPRESSED, '9.9.9.9', 'weird-entry']));
});

test('fetchCfItems: pagination that never ends -> null, not a truncated set', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const fetchImpl = async () => fakeResponse({ success: true, result: [{ ip: '1.1.1.1' }], result_info: { cursors: { after: 'MORE' } } });
    assert.equal(await fetchCfItems(CFG, fetchImpl), null);
  } finally {
    console.error = orig;
  }
});

test('fetchCfItems: API failure -> null (sync must abort, not re-add everything)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 9109, message: 'unauthorized' }] }) });
  assert.equal(await fetchCfItems(CFG, fetchImpl), null);
});

test('addItemsToCf: batches items in bare-array POST bodies', async () => {
  const items = Array.from({ length: 1200 }, (_, i) => `10.0.${Math.floor(i / 256)}.${(i % 256) + 1}`);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/bulk_operations/')) return OP_COMPLETED();
    calls.push(opts);
    return fakeResponse({ success: true, result: { operation_id: 'op' } });
  };
  assert.equal(await addItemsToCf(CFG, items, fetchImpl), true);
  assert.equal(calls.length, 3); // 500 + 500 + 200
  const first = JSON.parse(calls[0].body);
  assert.equal(first.length, 500);
  assert.deepEqual(Object.keys(first[0]), ['ip']); // bare array of {ip}, no wrapper
  assert.equal(JSON.parse(calls[2].body).length, 200);
});

test('addItemsToCf: rejected batch -> false', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ success: false, errors: [{ code: 10026, message: 'filters.api.invalid_json' }] }) });
  assert.equal(await addItemsToCf(CFG, ['1.1.1.1'], fetchImpl), false);
});

test('loadConfig: missing required keys throws listing them', () => {
  const f = join(tmpdir(), 'cf-sync-test-missing.env');
  writeFileSync(f, 'CF_AUTH_TOKEN=x\n');
  try {
    assert.throws(() => loadConfig(f, {}), /missing config .*CF_ACCOUNT_ID.*CF_LIST_ID.*URL_IPV4/);
  } finally {
    rmSync(f);
  }
});

test('loadConfig: OS env overrides file; CDN sections optional (null)', () => {
  const f = join(tmpdir(), 'cf-sync-test-override.env');
  writeFileSync(f, ['CF_AUTH_TOKEN=file-token', 'CF_ACCOUNT_ID=a', 'CF_LIST_ID=l', 'URL_IPV4=https://x/v4', 'URL_IPV6=https://x/v6'].join('\n') + '\n');
  try {
    const cfg = loadConfig(f, { CF_AUTH_TOKEN: 'os-token' });
    assert.equal(cfg.cfAuthToken, 'os-token');
    assert.equal(cfg.feedUrls.length, 2);
    assert.equal(cfg.cdnfly, null);
    assert.equal(cfg.goedge, null);
  } finally {
    rmSync(f);
  }
});

test('loadConfig: an enabled CDN with missing keys throws listing them', () => {
  const f = join(tmpdir(), 'cf-sync-test-cdn.env');
  writeFileSync(f, ['CF_AUTH_TOKEN=t', 'CF_ACCOUNT_ID=a', 'CF_LIST_ID=l', 'URL_IPV4=https://x/v4', 'URL_IPV6=https://x/v6',
    'GOEDGE_BASE_URL=http://edge.example', 'GOEDGE_USERNAME=u', 'GOEDGE_PASSWORD=p', 'GOEDGE_V4_LIST_ID=4'].join('\n') + '\n');
  try {
    assert.throws(() => loadConfig(f, {}), /missing config .*: GOEDGE_V6_LIST_ID$/);
  } finally {
    rmSync(f);
  }
});

test('loadConfig: an empty CDNFLY_WAF_CONFIG_ID falls back to the default id', () => {
  const f = join(tmpdir(), 'cf-sync-test-waf.env');
  writeFileSync(f, ['CF_AUTH_TOKEN=t', 'CF_ACCOUNT_ID=a', 'CF_LIST_ID=l', 'URL_IPV4=https://x/v4', 'URL_IPV6=https://x/v6',
    'CDNFLY_BASE_URL=http://cdn.example', 'CDNFLY_API_KEY=k', 'CDNFLY_API_SECRET=s', 'CDNFLY_WAF_CONFIG_ID='].join('\n') + '\n');
  try {
    assert.equal(loadConfig(f, {}).cdnfly.wafConfigId, 'global-0-openresty_config-openresty-config');
  } finally {
    rmSync(f);
  }
});

test('loadConfig: unreadable env file throws', () => {
  assert.throws(() => loadConfig('/nonexistent/cf-sync.env', {}), /cannot read/);
});

// Guards the src/ move: a relocated config.js must not shift the default .env path to src/.env.
test('ENV_FILE: default env path resolves to the project root, not src/', () => {
  assert.equal(ENV_FILE, join(dirname(fileURLToPath(import.meta.url)), '.env'));
});

test('fetchCfItems: TimeoutError maps to null + "timeout" log line', async () => {
  const fetchImpl = async () => {
    const e = new Error('x');
    e.name = 'TimeoutError';
    throw e;
  };
  const errs = [];
  const orig = console.error;
  console.error = (msg) => { errs.push(String(msg)); };
  try {
    assert.equal(await fetchCfItems(CFG, fetchImpl), null);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\[ERROR\] Cloudflare list read: timeout$/);
});

test('fetchCfItems: AbortError still maps to "timeout" (pin)', async () => {
  const fetchImpl = async () => {
    const e = new Error('x');
    e.name = 'AbortError';
    throw e;
  };
  const errs = [];
  const orig = console.error;
  console.error = (msg) => { errs.push(String(msg)); };
  try {
    assert.equal(await fetchCfItems(CFG, fetchImpl), null);
  } finally {
    console.error = orig;
  }
});

// --- fetchFeed + the main() orchestration steps ---

test('fetchFeed: normalizes, dedupes, and sends UA + a timeout signal', async () => {
  let seen;
  const body = ['1.2.3.4', '1.2.3.4', V6_EXPANDED, '10.0.0.0/8  extra column', '', '# comment'].join('\n');
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return textResponse(body);
  };
  const { entries, rejected, ok } = await fetchFeed('https://feeds.example/v4.txt', fetchImpl);
  assert.deepEqual(entries, new Set(['1.2.3.4', '10.0.0.0/8', V6_COMPRESSED]));
  assert.equal(rejected, 0);
  assert.equal(ok, true);
  assert.equal(seen.url, 'https://feeds.example/v4.txt');
  assert.equal(seen.opts.headers['User-Agent'], 'cf-blocklist-sync/1.0');
  assert.ok(seen.opts.signal instanceof AbortSignal);
});

test('fetchFeed: unparseable lines counted, comments and blanks not', async () => {
  const fetchImpl = async () => textResponse('not-an-ip\n# comment\n\n1.2.3.4\n');
  const { entries, rejected } = await fetchFeed('https://feeds.example/v4.txt', fetchImpl);
  assert.deepEqual(entries, new Set(['1.2.3.4']));
  assert.equal(rejected, 1);
});

test('fetchFeed: HTTP error -> empty set, no throw', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (msg) => errs.push(String(msg));
  try {
    const fetchImpl = async () => textResponse('nope', { ok: false, status: 503 });
    const { entries, rejected, ok } = await fetchFeed('https://feeds.example/v4.txt', fetchImpl);
    assert.deepEqual(entries, new Set());
    assert.equal(rejected, 0);
    assert.equal(ok, false);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\[ERROR\] feed fetch failed \(feeds\.example\): HTTP 503$/);
});

test('fetchFeed: timeout -> empty set with a "timeout" log', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (msg) => errs.push(String(msg));
  try {
    const fetchImpl = async () => {
      const e = new Error('x');
      e.name = 'TimeoutError';
      throw e;
    };
    const { entries } = await fetchFeed('https://feeds.example/v4.txt', fetchImpl);
    assert.deepEqual(entries, new Set());
  } finally {
    console.error = orig;
  }
  assert.match(errs[0], /\[ERROR\] feed fetch failed \(feeds\.example\): timeout$/);
});

test('fetchFeed: HTTP 200 with no valid entry -> ok:false', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const out = await fetchFeed('https://feeds.example/v4.txt', async () => textResponse('<html>maintenance</html>\n'));
    assert.deepEqual(out, { entries: new Set(), rejected: 1, ok: false });
  } finally {
    console.error = orig;
  }
});

test('fetchFeed: an unparseable feed URL throws instead of being swallowed', async () => {
  await assert.rejects(() => fetchFeed('not-a-url', async () => textResponse('')), TypeError);
});

test('syncCloudflare: posts only the missing items and returns the widened refSet', async () => {
  const posts = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/bulk_operations/')) return OP_COMPLETED();
    if (opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return fakeResponse({ success: true, result: { operation_id: 'op' } });
    }
    return fakeResponse({ success: true, result: [{ ip: '1.1.1.1' }], result_info: {} });
  };
  const out = await syncCloudflare(CFG, new Set(['1.1.1.1', '2.2.2.2']), fetchImpl);
  assert.deepEqual(out, { ok: true, refSet: new Set(['1.1.1.1', '2.2.2.2']) });
  assert.deepEqual(posts, [[{ ip: '2.2.2.2' }]]);
});

test('syncCloudflare: nothing missing -> no POST', async () => {
  const posts = [];
  const fetchImpl = async (_url, opts) => {
    if (opts.method === 'POST') posts.push(opts.body);
    return fakeResponse({ success: true, result: [{ ip: '1.1.1.1' }], result_info: {} });
  };
  const out = await syncCloudflare(CFG, new Set(['1.1.1.1']), fetchImpl);
  assert.deepEqual(out, { ok: true, refSet: new Set(['1.1.1.1']) });
  assert.equal(posts.length, 0);
});

test('syncCloudflare: read failure -> null, so the caller aborts before the mirrors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [] }) });
  assert.equal(await syncCloudflare(CFG, new Set(['1.1.1.1']), fetchImpl), null);
});

test('syncCloudflare: add failure -> ok:false but keeps the pre-existing refSet', async () => {
  const fetchImpl = async (_url, opts) => {
    if (opts.method === 'POST') return { ok: false, status: 400, json: async () => ({ success: false, errors: [] }) };
    return fakeResponse({ success: true, result: [{ ip: '1.1.1.1' }], result_info: {} });
  };
  const out = await syncCloudflare(CFG, new Set(['1.1.1.1', '2.2.2.2']), fetchImpl);
  assert.equal(out.ok, false);
  assert.deepEqual(out.refSet, new Set(['1.1.1.1']));
});

test('syncCloudflare: warns when the list would exceed MAX_ITEMS', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    const full = Array.from({ length: 10_000 }, () => ({ ip: '1.1.1.1' }));
    const fetchImpl = async (url, opts) => {
      if (url.includes('/bulk_operations/')) return OP_COMPLETED();
      if (opts.method === 'POST') return fakeResponse({ success: true, result: { operation_id: 'op' } });
      return fakeResponse({ success: true, result: full, result_info: {} });
    };
    const out = await syncCloudflare(CFG, new Set(['1.1.1.1', '2.2.2.2']), fetchImpl);
    assert.equal(out.ok, true);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /\[WARN\] Cloudflare list would reach 10001 items/);
  } finally {
    console.warn = orig;
  }
});

test('syncCdnMirrors: both disabled -> true without any request', async () => {
  const fetchImpl = async () => { throw new Error('no request expected'); };
  const cfg = { ...CFG, cdnfly: null, goedge: null };
  assert.equal(await syncCdnMirrors(cfg, new Set(['1.2.3.4']), fetchImpl), true);
});

test('syncCdnMirrors: cdnfly success -> true', async () => {
  const cfg = {
    ...CFG,
    cdnfly: { baseUrl: 'http://cdn.example', apiKey: 'k', apiSecret: 's', wafConfigId: 'global-0-openresty_config' },
    goedge: null,
  };
  const fetchImpl = async (_url, opts) => {
    if (opts.method === 'PUT') return fakeResponse({ code: 0, msg: 'ok' });
    return fakeResponse({ code: 0, data: { value: JSON.stringify({ custom_black: '1.2.3.4' }) } });
  };
  assert.equal(await syncCdnMirrors(cfg, new Set(['1.2.3.4', '5.6.7.8']), fetchImpl), true);
});

test('syncCdnMirrors: one failing mirror -> false', async () => {
  const cfg = {
    ...CFG,
    cdnfly: null,
    goedge: { baseUrl: 'http://edge.example', username: 'u', password: 'p', v4ListId: '4', v6ListId: '5' },
  };
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ code: 500 }) });
  assert.equal(await syncCdnMirrors(cfg, new Set(['1.2.3.4']), fetchImpl), false);
});

// main() end to end with stubbed network: feeds on feeds.example, Cloudflare on api.cloudflare.com.
function mainFetch({ v6Status = 200 } = {}) {
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/v4.txt')) return textResponse('1.1.1.1\n2.2.2.2\n');
    if (url.endsWith('/v6.txt')) return textResponse('2001:db8::1\n', { ok: v6Status === 200, status: v6Status });
    if (url.includes('/bulk_operations/')) return OP_COMPLETED();
    if (opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return fakeResponse({ success: true, result: { operation_id: 'op' } });
    }
    return fakeResponse({ success: true, result: [{ ip: '1.1.1.1' }], result_info: {} });
  };
  return { fetchImpl, posts };
}
const MAIN_CFG = { ...CFG, feedUrls: ['https://feeds.example/v4.txt', 'https://feeds.example/v6.txt'], cdnfly: null, goedge: null };

async function quiet(fn) {
  const logs = [];
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (msg) => logs.push(String(msg));
  try {
    return { code: await fn(), logs };
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
}

test('main: all feeds and Cloudflare ok, CDNs disabled -> 0, DONE names only Cloudflare', async () => {
  const { fetchImpl, posts } = mainFetch();
  const { code, logs } = await quiet(() => main(MAIN_CFG, fetchImpl));
  assert.equal(code, 0);
  assert.deepEqual(posts, [[{ ip: '2.2.2.2' }, { ip: '2001:db8::1' }]]);
  assert.ok(logs.includes('[DONE] sync done: Cloudflare list in sync'));
});

test('main: one feed failing -> fetched entries still synced, but exit 1', async () => {
  const { fetchImpl, posts } = mainFetch({ v6Status: 503 });
  const { code, logs } = await quiet(() => main(MAIN_CFG, fetchImpl));
  assert.equal(code, 1);
  assert.deepEqual(posts, [[{ ip: '2.2.2.2' }]]);
  assert.ok(logs.some((l) => l.startsWith('[WARN] 1 of 2 feeds failed')));
  assert.ok(!logs.some((l) => l.startsWith('[DONE]')));
  assert.ok(logs.some((l) => l.startsWith('[ERROR] sync incomplete')));
});

test('parseEntry: numeric shorthand, hex and octal are garbage, not IPs', () => {
  for (const raw of ['404', '2024', '1.2.3', '0x7f.0.0.1', '0300.0250.0.1', '3232235777', '01.2.3.4', '1.2.3/24']) {
    assert.equal(parseEntry(raw), null, raw);
  }
});

test('parseEntry: zone IDs and prefixes outside the Cloudflare limits are rejected', () => {
  for (const raw of ['fe80::1%eth0', 'fe80::1%eth0/64', '0.0.0.0/0', '1.0.0.0/7', '::/0', '2000::/11', '1.2.3.4/33', '::/129', '1.2.3.4/x']) {
    assert.equal(parseEntry(raw), null, raw);
  }
  assert.equal(parseEntry('1.0.0.0/8'), '1.0.0.0/8');
  assert.equal(parseEntry('2000::/12'), '2000::/12');
});

test('parseEntry: notation variants collapse to one canonical form', () => {
  assert.equal(parseEntry('1.2.3.4/24'), '1.2.3.0/24');
  assert.equal(parseEntry('2001:db8::1/64'), '2001:db8::/64');
  assert.equal(parseEntry('1.2.3.4/32'), '1.2.3.4');
  assert.equal(parseEntry('2001:db8::1/128'), '2001:db8::1');
  assert.equal(parseEntry('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(parseEntry('::ffff:1.2.3.4/120'), '1.2.3.0/24'); // mapped CIDR == the IPv4 range
  assert.equal(parseEntry('::ffff:1.2.3.4/128'), '1.2.3.4');
  assert.equal(parseEntry('::ffff:0:0/95'), null); // spans non-mapped space
});

test('loadConfig: strips only a matched pair of quotes', () => {
  const dir = join(tmpdir(), `cf-quotes-${process.pid}.env`);
  writeFileSync(dir, 'CF_AUTH_TOKEN="tok"\nCF_ACCOUNT_ID=acc"\nCF_LIST_ID=\'lst"\nURL_IPV4=\'https://a/4\'\nURL_IPV6=https://a/6\n');
  try {
    const cfg = loadConfig(dir, {});
    assert.equal(cfg.cfAuthToken, 'tok');
    assert.equal(cfg.cfAccountId, 'acc"');
    assert.equal(cfg.cfListId, '\'lst"');
    assert.deepEqual(cfg.feedUrls, ['https://a/4', 'https://a/6']);
  } finally {
    rmSync(dir);
  }
});

/** Replays status replies; every POST queues one operation. */
function opFetch(statuses, order = []) {
  const queue = [...statuses];
  return async (url, opts = {}) => {
    if (url.includes('/bulk_operations/')) {
      order.push('poll');
      const next = queue.shift();
      return next instanceof Error ? Promise.reject(next) : fakeResponse({ success: true, result: { status: next, error: 'list full' } });
    }
    order.push('post');
    return fakeResponse({ success: true, result: { operation_id: 'op' } });
  };
}

test('addItemsToCf: the next batch waits until the previous operation completed', async () => {
  const items = Array.from({ length: 501 }, (_, i) => `10.0.${Math.floor(i / 256)}.${(i % 256) + 1}`);
  const order = [];
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const ok = await addItemsToCf(CFG, items, opFetch(['pending', 'running', 'completed', 'completed'], order), sleep);
  assert.equal(ok, true);
  assert.deepEqual(order, ['post', 'poll', 'poll', 'poll', 'post', 'poll']);
  assert.deepEqual(slept, [1000, 1000]);
});

test('addItemsToCf: a failed operation -> false, later batches not sent', async () => {
  const items = Array.from({ length: 501 }, (_, i) => `10.0.${Math.floor(i / 256)}.${(i % 256) + 1}`);
  const order = [];
  const { code, logs } = await quiet(async () => addItemsToCf(CFG, items, opFetch(['failed'], order), async () => {}));
  assert.equal(code, false);
  assert.deepEqual(order, ['post', 'poll']);
  assert.ok(logs.some((l) => l.includes('list full')));
});

test('addItemsToCf: an operation that never finishes -> false after the poll limit', async () => {
  const fetchImpl = opFetch(Array(500).fill('pending'));
  let sleeps = 0;
  const { code } = await quiet(() => addItemsToCf(CFG, ['1.1.1.1'], fetchImpl, async () => { sleeps += 1; }));
  assert.equal(code, false);
  assert.equal(sleeps, 119);
});

test('addItemsToCf: a status read that throws -> false, no escape', async () => {
  const { code } = await quiet(() => addItemsToCf(CFG, ['1.1.1.1'], opFetch([new Error('reset')]), async () => {}));
  assert.equal(code, false);
});

test('syncCdnMirrors: raw or out-of-range Cloudflare items never reach a WAF', async () => {
  let putValue;
  const fetchImpl = async (_url, opts = {}) => {
    if (opts.method === 'PUT') {
      putValue = JSON.parse(JSON.parse(opts.body).value);
      return fakeResponse({ code: 0 });
    }
    return fakeResponse({ code: 0, data: { value: JSON.stringify({ custom_black: '' }) } });
  };
  const cfg = { ...CFG, cdnfly: { baseUrl: 'http://cdn.example', apiKey: 'k', apiSecret: 's', wafConfigId: 'w' }, goedge: null };
  const { code, logs } = await quiet(() => syncCdnMirrors(cfg, new Set(['1.1.1.1', '0.0.0.0/0', 'garbage']), fetchImpl));
  assert.equal(code, true);
  assert.equal(putValue.custom_black, '1.1.1.1');
  assert.ok(logs.some((l) => l.startsWith('[WARN] 2 Cloudflare items')));
});

test('syncCdnMirrors: a slow panel does not hold up the other, and both results count', { timeout: 5000 }, async () => { // fails fast on a sequencing regression instead of hanging
  let releaseCdnfly;
  const cdnflyBlocked = new Promise((resolve) => { releaseCdnfly = resolve; });
  const fetchImpl = async (url) => {
    if (url.startsWith('http://cdn.example')) {
      await cdnflyBlocked;
      return fakeResponse({ code: 1 });
    }
    releaseCdnfly(); // reached only if GoEdge starts while cdnfly is still waiting
    return fakeResponse({ code: 500 });
  };
  const cfg = {
    ...CFG,
    cdnfly: { baseUrl: 'http://cdn.example', apiKey: 'k', apiSecret: 's', wafConfigId: 'w' },
    goedge: { baseUrl: 'http://edge.example', username: 'u', password: 'p', v4ListId: '4', v6ListId: '5' },
  };
  const { code } = await quiet(() => syncCdnMirrors(cfg, new Set(['1.1.1.1']), fetchImpl));
  assert.equal(code, false);
});

test('isPrivateOrLocal: private/local ranges true, public and documentation false', () => {
  for (const e of ['10.0.0.1', '10.0.0.0/8', '192.168.1.0/24', '172.16.5.5', '127.0.0.1', '169.254.0.0/16', '100.64.0.1', '0.0.0.0']) assert.equal(isPrivateOrLocal(e), true, e);
  assert.equal(isPrivateOrLocal('fd12:3456:789a::1'), true);
  assert.equal(isPrivateOrLocal('fe80::1'), true);
  for (const e of ['8.8.8.8', '1.2.3.0/24', '2001:db8::1', '2001:db8::/64']) assert.equal(isPrivateOrLocal(e), false, e);
  assert.equal(isPrivateOrLocal('garbage-line'), false); // raw values are not the filter's business
});

test('main: private feed entries are dropped, never posted to Cloudflare', async () => {
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('/bulk_operations/')) return OP_COMPLETED();
    if (opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return fakeResponse({ success: true, result: { operation_id: 'op' } });
    }
    if (url.endsWith('/v4.txt')) return textResponse('8.8.4.4\n10.99.99.99\n192.168.0.0/16\n');
    if (url.endsWith('/v6.txt')) return textResponse('2600::1\n');
    return fakeResponse({ success: true, result: [], result_info: {} });
  };
  const { code, logs } = await quiet(() => main(MAIN_CFG, fetchImpl));
  assert.equal(code, 0);
  assert.deepEqual(posts, [[{ ip: '2600::1' }, { ip: '8.8.4.4' }]]); // computeToAdd sorts
  assert.ok(logs.some((l) => l.startsWith('[WARN] dropped 2 private/local feed entries')));
});

test('syncCdnMirrors: private entries in the Cloudflare list are not mirrored', async () => {
  let putValue;
  const fetchImpl = async (_url, opts = {}) => {
    if (opts.method === 'PUT') {
      putValue = JSON.parse(JSON.parse(opts.body).value);
      return fakeResponse({ code: 0 });
    }
    return fakeResponse({ code: 0, data: { value: JSON.stringify({ custom_black: '' }) } });
  };
  const cfg = { ...CFG, cdnfly: { baseUrl: 'http://cdn.example', apiKey: 'k', apiSecret: 's', wafConfigId: 'w' }, goedge: null };
  const { logs } = await quiet(() => syncCdnMirrors(cfg, new Set(['9.9.9.9', '10.0.0.0/8', '127.0.0.1']), fetchImpl));
  assert.equal(putValue.custom_black, '9.9.9.9');
  assert.ok(logs.some((l) => l.startsWith('[WARN] 2 Cloudflare items')));
});
