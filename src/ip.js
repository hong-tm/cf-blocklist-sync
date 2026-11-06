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
  if (mapped) return null;
  try {
    const [, prefix] = ipaddr.parseCIDR(token); // throws on malformed
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

/**
 * True for a canonical IP or CIDR whose network address is private, local or
 * otherwise non-routable. Documentation ranges (2001:db8::/32, 240.0.0.0/4)
 * are left alone: they never reach a real origin, and rejecting them would
 * churn every test fixture.
 * @param {string} entry
 * @returns {boolean}
 */
export function isPrivateOrLocal(entry) {
  const parsed = parseEntry(entry);
  if (parsed === null) return false;
  const addr = ipaddr.parse(parsed.split('/')[0]);
  return NON_PUBLIC_RANGES.has(addr.range());
}
