import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdnflyBlackSet, appendToCdnflyBlack, fetchCdnflyWafConfig, putCdnflyWafConfig, syncCdnfly } from './src/cdn_cdnfly.js';

// Fully expanded form of V6_COMPRESSED: exactly 8 groups. A 9-group "expanded"
// string is invalid IPv6 and parseEntry() rejects it.
const V6_EXPANDED = '2001:0db8:0000:0000:0000:0000:0000:0001';
const V6_COMPRESSED = '2001:db8::1';

const CFG = {
  baseUrl: 'http://cdn.example',
  apiKey: 'k',
  apiSecret: 's',
  wafConfigId: 'global-0-openresty_config-openresty-config',
};

function jsonOk(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function configPayload(valueObj) {
  return { code: 0, data: { value: JSON.stringify(valueObj) } };
}

test('cdnflyBlackSet: normalizes lines, skips blanks, collapses notation variants', () => {
  const s = cdnflyBlackSet(`1.2.3.4
10.0.0.0/8

${V6_EXPANDED}
${V6_COMPRESSED}
`);
  assert.deepEqual(s, new Set(['1.2.3.4', '10.0.0.0/8', V6_COMPRESSED]));
});

test('appendToCdnflyBlack: preserves original lines, appends new ones, trims trailing whitespace', () => {
  const value = { custom_black: '1.2.3.4\n5.6.7.8\n', other: 'x' };
  assert.equal(appendToCdnflyBlack(value, ['9.9.9.9']), 1);
  assert.equal(value.custom_black, '1.2.3.4\n5.6.7.8\n9.9.9.9');
  assert.equal(value.other, 'x');
});

test('appendToCdnflyBlack: empty toAdd leaves the field untouched', () => {
  const value = { custom_black: '1.2.3.4\n' };
  assert.equal(appendToCdnflyBlack(value, []), 0);
  assert.equal(value.custom_black, '1.2.3.4\n');
});

test('fetchCdnflyWafConfig: decodes the value string', async () => {
  const fetchImpl = async () => jsonOk(configPayload({ custom_black: '1.2.3.4', block_time: 3600 }));
  const value = await fetchCdnflyWafConfig(CFG, fetchImpl);
  assert.equal(value.custom_black, '1.2.3.4');
  assert.equal(value.block_time, 3600);
});

test('fetchCdnflyWafConfig: API error -> null', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ code: 1, msg: 'boom' }) });
  assert.equal(await fetchCdnflyWafConfig(CFG, fetchImpl), null);
});

test('putCdnflyWafConfig: PUTs the value as a JSON string; accepts {code:0}', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return jsonOk({ code: 0, msg: 'ok' });
  };
  assert.equal(await putCdnflyWafConfig(CFG, { custom_black: 'a\nb' }, fetchImpl), true);
  assert.equal(seen.url, `${CFG.baseUrl}/v1/configs/${CFG.wafConfigId}`);
  assert.equal(seen.opts.method, 'PUT');
  assert.equal(JSON.parse(seen.opts.body).value, JSON.stringify({ custom_black: 'a\nb' }));
  assert.equal(seen.opts.headers['api-key'], 'k');
  assert.equal(seen.opts.headers['api-secret'], 's');
});

test('putCdnflyWafConfig: rejected -> false', async () => {
  const fetchImpl = async () => jsonOk({ code: 1, msg: 'rejected' });
  assert.equal(await putCdnflyWafConfig(CFG, { custom_black: '' }, fetchImpl), false);
});

test('syncCdnfly: appends only the missing entries; everything else passes through', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (opts.method === 'PUT') return jsonOk({ code: 0, msg: 'ok' });
    return jsonOk(configPayload({
      custom_black: `1.2.3.4\n10.0.0.0/8\n${V6_EXPANDED}`,
      custom_white: '8.8.8.8',
      block_time: 3600,
    }));
  };
  // The existing CDN line is in expanded form while the reference set carries
  // the compressed form: normalized matching must recognize them as the same
  // entry, so only 5.6.7.8 is missing.
  const cfSet = new Set(['1.2.3.4', '5.6.7.8', '10.0.0.0/8', V6_COMPRESSED]);
  const result = await syncCdnfly(CFG, cfSet, fetchImpl);
  assert.deepEqual(result, { ok: true, added: 1, existing: 3 });
  const put = calls.find((c) => c.opts.method === 'PUT');
  const value = JSON.parse(JSON.parse(put.opts.body).value);
  // Original lines are preserved byte-for-byte; only missing entries are appended.
  assert.equal(value.custom_black, `1.2.3.4\n10.0.0.0/8\n${V6_EXPANDED}\n5.6.7.8`);
  assert.equal(value.custom_white, '8.8.8.8'); // untouched
  assert.equal(value.block_time, 3600); // untouched
});

test('syncCdnfly: no diff -> no write at all', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonOk(configPayload({ custom_black: '1.2.3.4', other: 'x' }));
  };
  const result = await syncCdnfly(CFG, new Set(['1.2.3.4']), fetchImpl);
  assert.deepEqual(result, { ok: true, added: 0, existing: 1 });
  assert.equal(calls, 1);
});

test('syncCdnfly: failed read -> {ok:false}, no write', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 502, json: async () => ({ code: 1 }) };
  };
  const result = await syncCdnfly(CFG, new Set(['1.2.3.4']), fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test('syncCdnfly: failed PUT -> {ok:false}', async () => {
  const fetchImpl = async (_url, opts) => {
    if (opts.method === 'PUT') return jsonOk({ code: 1, msg: 'rejected' });
    return jsonOk(configPayload({ custom_black: '' }));
  };
  const result = await syncCdnfly(CFG, new Set(['1.2.3.4']), fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.added, 0);
});

test('fetchCdnflyWafConfig: TimeoutError maps to "timeout" log line', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (msg) => errs.push(String(msg));
  try {
    const fetchImpl = async () => {
      const e = new Error('x');
      e.name = 'TimeoutError';
      throw e;
    };
    assert.equal(await fetchCdnflyWafConfig(CFG, fetchImpl), null);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\[ERROR\] cdnfly config read: timeout$/);
});
