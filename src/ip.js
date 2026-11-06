// IP entry normalization, shared by the feed parser and both CDN clients.
// It lives in its own module so the CDN clients depend on this, not on the
// orchestrator that imports them.

import ipaddr from 'ipaddr.js';

// Address ranges that must never land on a WAF blocklist: blocking them can
// cut off internal traffic. A feed line with one is dirty data.
const NON_PUBLIC_RANGES = new Set([
  'unspecified', 'loopback', 'private', 'linkLocal', 'uniqueLocal',
  'carrierGradeNat', 'multicast', 'broadcast',
]);

// Prefix bounds of a Cloudflare IP list. One out-of-range entry would make
// Cloudflare reject its whole batch, and a /0 in a feed would block everything.
const PREFIX_LIMITS = { ipv4: { min: 8, host: 32 }, ipv6: { min: 12, host: 128 } };

/**
 * Parse one address strictly. ipaddr.parse alone also accepts shorthand such as
 * '404' (0.0.1.148), hex and octal, so a garbage numeric line would become an IP.
 * IPv6 zone IDs are link-local only and have no meaning in a blocklist.
 * @param {string} text
 */
function parseStrictAddr(text) {
  if (!ipaddr.isValid(text)) return null;
  const addr = ipaddr.parse(text);
  if (addr instanceof ipaddr.IPv4) return ipaddr.IPv4.isValidFourPartDecimal(text) ? addr : null;
  return addr.zoneId ? null : addr;
}

/**
 * Normalize one feed line to a canonical IP or CIDR string, or null for
 * blank/comment/garbage lines. Notation variants (expanded vs compressed
 * IPv6, host bits in a CIDR, /32 or /128 on a host, IPv4-mapped IPv6) normalize to the same string, which is what makes set-based
 * deduplication exact.
 * @param {string} raw
 */
export function parseEntry(raw) {
  const stripped = raw.trim();
  if (!stripped || stripped.startsWith('#')) return null;
  const token = stripped.split(/\s+/)[0];
  const slashParts = token.split('/');
  if (slashParts.length > 2) return null;
  const addr = parseStrictAddr(slashParts[0]);
  if (addr === null) return null;
  const mapped = addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress();
  if (slashParts.length === 1) {
    return mapped ? addr.toIPv4Address().toString() : addr.toString();
  }
  try {
    const [, prefix] = ipaddr.parseCIDR(token); // throws on malformed
    if (mapped) {
      // An IPv4-mapped CIDR is an IPv4 range in disguise: ::ffff:1.2.3.0/120 == 1.2.3.0/24.
      if (prefix < 96) return null; // spans non-mapped space
      const v4 = addr.toIPv4Address();
      const v4prefix = prefix - 96;
      if (v4prefix === 32) return v4.toString();
      if (v4prefix < PREFIX_LIMITS.ipv4.min) return null;
      const net = ipaddr.IPv4.networkAddressFromCIDR(v4.toString() + '/' + v4prefix);
      return net.toString() + '/' + v4prefix;
    }
    const limits = PREFIX_LIMITS[addr.kind()];
    if (prefix < limits.min || prefix > limits.host) return null;
    if (prefix === limits.host) return addr.toString();
    const family = addr instanceof ipaddr.IPv4 ? ipaddr.IPv4 : ipaddr.IPv6;
    return `${family.networkAddressFromCIDR(token).toString()}/${prefix}`;
  } catch {
    return null;
  }
}

/**
 * Normalize a Cloudflare list item for comparison against feed entries.
 * Returns null for empty values; unparseable values keep their raw (trimmed)
 * form so they never collide with feed entries and are left in place.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeCfItem(raw) {
  const stripped = (raw ?? '').trim();
  if (!stripped) return null;
  return parseEntry(stripped) ?? stripped;
}

// Blocked ranges by family, as [first, last] BigInt pairs. A CIDR is blocked
// when it OVERLAPS any of them — 172.0.0.0/8 contains 172.16.0.0/12 — so a
// spanning range cannot smuggle internal space onto the WAFs.
const BLOCKED_CIDRS = {
  ipv4: ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4'],
  ipv6: ['::/128', '::1/128', 'fe80::/10', 'fc00::/7', 'ff00::/8'],
};

/**
 * @param {import('ipaddr.js').IPv4 | import('ipaddr.js').IPv6} addr
 * @returns {bigint}
 */
function addrToBigInt(addr) {
  let n = 0n;
  for (const b of addr.toByteArray()) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * [first, last] addresses covered by a canonical CIDR.
 * @param {string} cidr
 * @returns {[bigint, bigint]}
 */
function cidrRange(cidr) {
  const [addr, prefix] = ipaddr.parseCIDR(cidr);
  const bits = addr.kind() === 'ipv4' ? 32 : 128;
  const hostBits = BigInt(bits - prefix);
  const first = (addrToBigInt(addr) >> hostBits) << hostBits;
  return [first, first | ((1n << hostBits) - 1n)];
}

const BLOCKED_RANGES = {
  ipv4: BLOCKED_CIDRS.ipv4.map(cidrRange),
  ipv6: BLOCKED_CIDRS.ipv6.map(cidrRange),
};

/**
 * True for a canonical IP or CIDR that is private or local, or overlaps one.
 * Bare addresses are judged by their range; CIDRs by overlap (a public /8
 * containing 172.16.0.0/12 is blocked). Documentation ranges (2001:db8::/32,
 * 240.0.0.0/4) are left alone: they never reach a real origin, and rejecting
 * them would churn every test fixture.
 * @param {string} entry
 * @returns {boolean}
 */
export function isPrivateOrLocal(entry) {
  const parsed = parseEntry(entry);
  if (parsed === null) return false;
  if (!parsed.includes('/')) return NON_PUBLIC_RANGES.has(ipaddr.parse(parsed).range());
  const kind = ipaddr.parse(parsed.split('/')[0]).kind();
  const [first, last] = cidrRange(parsed);
  return BLOCKED_RANGES[kind].some(([bFirst, bLast]) => first <= bLast && bFirst <= last);
}
