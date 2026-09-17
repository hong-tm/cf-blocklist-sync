import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5hex, parseXViewData, goedgeLogin, goedgeExportList, syncGoedge, oneYearExpiry } from './src/cdn_goedge.js';

const BASE = 'http://edge.example';
const CFG = {
  baseUrl: BASE,
  username: 'admin',
  password: 'secret-pw',
  v4ListId: '4',
  v6ListId: '5',
};

const NOW = Date.UTC(2026, 8, 13, 0, 0, 0);
const EXPIRY = oneYearExpiry(NOW);

const LOGIN_PAGE = `<!doctype html>
<html>
<script>window.X_VIEW_DATA = {"version":"1.1.5","token":"PT1234567890abcde"};</script>
</html>`;

function jsonOk(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function htmlOk(html) {
  return { ok: true, status: 200, text: async () => html };
}

function loginOk(cookie) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'set-cookie' ? cookie : null) },
    json: async () => ({ code: 200, data: { ip: '1.2.3.4', localSid: 'sid', requireOTP: false } }),
  };
}

test('md5hex: known vector', () => {
  assert.equal(md5hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
});

test('oneYearExpiry: one calendar year later, in unix seconds', () => {
  assert.equal(oneYearExpiry(Date.UTC(2026, 8, 13, 0, 0, 0)), Date.UTC(2027, 8, 13, 0, 0, 0) / 1000);
  assert.equal(oneYearExpiry(Date.UTC(2028, 1, 29, 12, 0, 0)), Date.UTC(2029, 2, 1, 12, 0, 0) / 1000);
});

test('parseXViewData: extracts the login token object', () => {
  const v = parseXViewData(LOGIN_PAGE);
  assert.equal(v.token, 'PT1234567890abcde');
  assert.equal(v.version, '1.1.5');
});

test('parseXViewData: no marker -> null', () => {
  assert.equal(parseXViewData('<html></html>'), null);
  assert.equal(parseXViewData(''), null);
});

test('goedgeLogin: success -> session cookie; POSTs md5 password + csrf + page token', async () => {
  const postBodies = [];
  const fetchImpl = async (url, opts) => {
    if (url === `${BASE}/csrf/token`) return jsonOk({ code: 200, data: { token: 'CT1' } });
    if (url === `${BASE}/` && opts?.method === 'POST') {
      postBodies.push(opts.body.toString());
      return loginOk('mysid=abc123; Path=/; Max-Age=1209600; HttpOnly');
    }
    if (url === `${BASE}/`) return htmlOk(LOGIN_PAGE);
    throw new Error('unexpected: ' + url);
  };
  const session = await goedgeLogin(CFG, fetchImpl);
  assert.equal(session.cookie, 'mysid=abc123');
  const form = new URLSearchParams(postBodies[0]);
  assert.equal(form.get('token'), 'PT1234567890abcde');
  assert.equal(form.get('username'), 'admin');
  assert.equal(form.get('password'), md5hex('secret-pw'));
  assert.equal(form.get('csrfToken'), 'CT1');
  assert.equal(form.get('otp_code'), '');
});

test('goedgeLogin: failed login -> null', async () => {
  const fetchImpl = async (url, opts) => {
    if (url === `${BASE}/csrf/token`) return jsonOk({ code: 200, data: { token: 'CT1' } });
    if (url === `${BASE}/` && opts?.method !== 'POST') return htmlOk(LOGIN_PAGE);
    return jsonOk({ code: 400, message: 'Login failure' });
  };
  assert.equal(await goedgeLogin(CFG, fetchImpl), null);
});

test('goedgeExportList: parses the txt export into normalized entries', async () => {
  const body = '116.129.250.44,1820582109,ipv4,critical,\n240e:361:aa00:3300::/64,1820052307,ipv6,critical,\n';
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => body });
  const s = await goedgeExportList(CFG, { cookie: 'c' }, 4, fetchImpl);
  assert.deepEqual(s, new Set(['116.129.250.44', '240e:361:aa00:3300::/64']));
});

test('goedgeExportList: failure -> null', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'err' });
  assert.equal(await goedgeExportList(CFG, { cookie: 'c' }, 4, fetchImpl), null);
});

function mockGoedgeServer({ v4Export, v6Export, importResults }) {
  const imports = [];
  const csrfTokens = [];
  let csrfN = 0;
  const fetchImpl = async (url, opts) => {
    if (url === `${BASE}/csrf/token`) {
      const t = `CT${csrfN++}`;
      csrfTokens.push(t);
      return jsonOk({ code: 200, data: { token: t } });
    }
    if (url === `${BASE}/`) {
      if (opts?.method === 'POST') return loginOk('mysid=xyz; Path=/');
      return htmlOk(LOGIN_PAGE);
    }
    if (url.includes('exportData?listId=4')) return { ok: true, status: 200, text: async () => v4Export() };
    if (url.includes('exportData?listId=5')) return { ok: true, status: 200, text: async () => v6Export() };
    if (url === `${BASE}/servers/iplists/import`) {
      const listId = opts.body.get('listId');
      const file = opts.body.get('file');
      const lines = (await file.text()).trim().split('\n').filter(Boolean);
      const entry = { listId, csrfToken: opts.body.get('csrfToken'), lines };
      imports.push(entry);
      const r = importResults(entry);
      if (r.ok === false) return { ok: false, status: 500, json: async () => ({ code: 500, message: 'boom' }) };
      return jsonOk({ code: 200, data: { count: lines.length, countIgnore: r.ignore ?? 0 } });
    }
    throw new Error('unexpected: ' + url);
  };
  return { fetchImpl, imports, csrfTokens };
}

test('syncGoedge: routes by family, imports only the diff, one fresh CSRF per import', async () => {
  const { fetchImpl, imports, csrfTokens } = mockGoedgeServer({
    v4Export: () => '1.1.1.1,0,ipv4,critical,\n',
    v6Export: () => '240e::/64,0,ipv6,critical,\n',
    importResults: () => ({ ok: true }),
  });
  const cfSet = new Set(['1.1.1.1', '1.2.3.4', '10.0.0.0/8', '240e::/64', '240e:db8::5']);
  const result = await syncGoedge(CFG, cfSet, fetchImpl, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.added, 3);
  const byList = {};
  for (const i of imports) (byList[i.listId] ??= []).push(...i.lines);
  assert.deepEqual(byList['4'].sort(), [`1.2.3.4,${EXPIRY}`, `10.0.0.0/8,${EXPIRY}`]);
  assert.deepEqual(byList['5'].sort(), [`240e:db8::5,${EXPIRY}`]);
  assert.equal(imports.length, 2);
  // CSRF tokens are single-use: every import must use a token that was
  // actually issued, and no token may be reused across imports.
  const tokens = imports.map((i) => i.csrfToken);
  for (const t of tokens) assert.ok(csrfTokens.includes(t));
  assert.equal(new Set(tokens).size, tokens.length);
});

test('syncGoedge: nothing to add on either list -> no imports', async () => {
  const { fetchImpl, imports } = mockGoedgeServer({
    v4Export: () => '1.1.1.1,0,ipv4,critical,\n',
    v6Export: () => '',
    importResults: () => ({ ok: true }),
  });
  const result = await syncGoedge(CFG, new Set(['1.1.1.1']), fetchImpl, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.added, 0);
  assert.equal(imports.length, 0);
});

test('syncGoedge: failed import with partial landing -> re-exports, retries the remainder only', async () => {
  let firstImport = true;
  const state = { v4: '1.1.1.1,0,ipv4,critical,\n' };
  const { fetchImpl, imports } = mockGoedgeServer({
    v4Export: () => state.v4,
    v6Export: () => '',
    importResults: (entry) => {
      if (firstImport) {
        firstImport = false;
        // The panel applied only the first entry before erroring.
        state.v4 += '2.2.2.2,0,ipv4,critical,\n';
        return { ok: false };
      }
      state.v4 += entry.lines.map((l) => `${l},ipv4,critical,\n`).join('');
      return { ok: true };
    },
  });
  const cfSet = new Set(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  const result = await syncGoedge(CFG, cfSet, fetchImpl, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.added, 2); // 2.2.2.2 landed in the failed batch, 3.3.3.3 in the retry
  assert.deepEqual(imports[0].lines, [`2.2.2.2,${EXPIRY}`, `3.3.3.3,${EXPIRY}`]);
  assert.deepEqual(imports[1].lines, [`3.3.3.3,${EXPIRY}`]); // the landed entry is not re-sent
});

test('syncGoedge: failed import with no landing -> same batch retried once, then failure', async () => {
  let n = 0;
  const { fetchImpl, imports } = mockGoedgeServer({
    v4Export: () => '',
    v6Export: () => '',
    importResults: () => {
      n += 1;
      return { ok: n < 2 ? false : true };
    },
  });
  const result = await syncGoedge(CFG, new Set(['1.1.1.1', '2.2.2.2']), fetchImpl, NOW);
  assert.equal(result.ok, true);
  assert.equal(imports.length, 2); // original batch + one retry
  assert.deepEqual(imports[0].lines, imports[1].lines);
  assert.equal(result.added, 2);
});

test('syncGoedge: failed login -> {ok:false} before any import', async () => {
  const fetchImpl = async (url, opts) => {
    if (url === `${BASE}/csrf/token`) return jsonOk({ code: 200, data: { token: 'CT1' } });
    if (url === `${BASE}/` && opts?.method !== 'POST') return htmlOk(LOGIN_PAGE);
    return jsonOk({ code: 400, message: 'bad credentials' });
  };
  const result = await syncGoedge(CFG, new Set(['1.1.1.1']), fetchImpl);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('login'));
});

test('syncGoedge: timeout -> {ok:false} instead of throwing', async () => {
  const fetchImpl = async () => {
    const e = new Error('x');
    e.name = 'TimeoutError';
    throw e;
  };
  const result = await syncGoedge(CFG, new Set(['1.1.1.1']), fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.added, 0);
});

test('syncGoedge: mid-run timeout after login degrades that list, keeps going', async () => {
  let exportCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (url === `${BASE}/csrf/token`) return jsonOk({ code: 200, data: { token: 'CT1' } });
    if (url === `${BASE}/`) {
      if (opts?.method === 'POST') return loginOk('mysid=xyz; Path=/');
      return htmlOk(LOGIN_PAGE);
    }
    if (url.includes('exportData')) {
      exportCalls += 1;
      if (exportCalls === 1) {
        const e = new Error('x');
        e.name = 'TimeoutError';
        throw e;
      }
      return { ok: true, status: 200, text: async () => '' };
    }
    throw new Error('unexpected: ' + url);
  };
  const result = await syncGoedge(CFG, new Set(['1.1.1.1']), fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(exportCalls, 2); // the second list was still attempted
});

test('goedge requests carry per-request AbortSignal timeouts', async () => {
  const signals = [];
  const fetchImpl = async (url, opts) => {
    if (opts?.signal) signals.push(opts.signal);
    if (url === `${BASE}/csrf/token`) return jsonOk({ code: 200, data: { token: 'CT1' } });
    if (url === `${BASE}/`) {
      if (opts?.method === 'POST') return loginOk('mysid=abc; Path=/');
      return htmlOk(LOGIN_PAGE);
    }
    throw new Error('unexpected: ' + url);
  };
  const session = await goedgeLogin(CFG, fetchImpl);
  assert.equal(session.cookie, 'mysid=abc');
  assert.equal(signals.length, 3); // csrf GET + login page GET + login POST (verified)
  assert.ok(signals.every((s) => s instanceof AbortSignal));
});
