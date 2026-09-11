import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEntry, mergeFeeds, normalizeCfItem, computeToAdd, fetchCfItems, addItemsToCf, loadConfig } from './sync_blocklist.js';

const V6_EXPANDED = '2001:0db8:0000:0000:0000:0000:0000:0001';
const V6_COMPRESSED = '2001:db8::1';

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

// ─── Cloudflare list read ───

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

// ─── Add-only diff ───

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

// ─── Cursor-paginated list read (mocked fetch) ───

function fakeResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
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

test('fetchCfItems: API failure -> null (sync must abort, not re-add everything)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 9109, message: 'unauthorized' }] }) });
  assert.equal(await fetchCfItems(CFG, fetchImpl), null);
});

// ─── Batched append (mocked fetch) ───

test('addItemsToCf: batches items in bare-array POST bodies', async () => {
  const items = Array.from({ length: 1200 }, (_, i) => `10.0.${Math.floor(i / 256)}.${(i % 256) + 1}`);
  const calls = [];
  const fetchImpl = async (_url, opts) => {
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

// ─── loadConfig ───

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

test('loadConfig: unreadable env file throws', () => {
  assert.throws(() => loadConfig('/nonexistent/cf-sync.env', {}), /cannot read/);
});

// ─── Timeout/abort mapping (mocked fetch) ───

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
