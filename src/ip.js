// IP entry normalization, shared by the feed parser and both CDN clients.
// It lives in its own module so the CDN clients depend on this, not on the
// orchestrator that imports them.

import ipaddr from 'ipaddr.js';

/**
 * True for dotted-quad tokens whose octets have leading zeros (ambiguous decimal/octal).
 * @param {string} token
 */
function hasLeadingZeroOctets(token) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(token)) return false;
  return token.split('.').some((p) => p.length > 1 && p.startsWith('0'));
}

/**
 * Normalize one feed line to a canonical IP or CIDR string, or null for
 * blank/comment/garbage lines. Notation variants (expanded vs compressed
 * IPv6) normalize to the same string, which is what makes set-based
 * deduplication exact.
 * @param {string} raw
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
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeCfItem(raw) {
  const stripped = (raw ?? '').trim();
  if (!stripped) return null;
  return parseEntry(stripped) ?? stripped;
}
