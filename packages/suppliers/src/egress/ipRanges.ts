/**
 * IP address range validators for SSRF protection.
 *
 * Blocks: RFC1918 private, loopback, link-local (including 169.254.169.254
 * instance metadata endpoint), unique-local IPv6, and the unspecified address.
 *
 * POLICY: if ANY resolved address for a hostname falls into a blocked range,
 * the request is denied — even if other addresses are public. This prevents
 * multi-record exploitation (edge case where one A record is public, one
 * private).
 *
 * This module is free of I/O and Node.js imports so it is unit-testable as
 * pure functions.
 */

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-decimal IPv4 string to an unsigned 32-bit integer.
 * Returns null when the string is not a valid IPv4 address.
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    result = ((result << 8) | n) >>> 0;
  }
  return result;
}

function cidrMatchIPv4(ip: number, networkStr: string, prefix: number): boolean {
  const network = parseIPv4(networkStr);
  if (network === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ip & mask) === (network & mask);
}

/**
 * Returns true if `ip` falls within a blocked IPv4 range:
 *   - 10.0.0.0/8     (RFC1918 private)
 *   - 172.16.0.0/12  (RFC1918 private)
 *   - 192.168.0.0/16 (RFC1918 private)
 *   - 127.0.0.0/8    (loopback)
 *   - 169.254.0.0/16 (link-local — includes metadata endpoint 169.254.169.254)
 *   - 0.0.0.0/8      (unspecified / "this" network)
 *   - 100.64.0.0/10  (shared address space — CGNAT)
 */
export function isBlockedIPv4(ip: string): boolean {
  const n = parseIPv4(ip);
  if (n === null) return false;

  return (
    cidrMatchIPv4(n, '10.0.0.0', 8) ||
    cidrMatchIPv4(n, '172.16.0.0', 12) ||
    cidrMatchIPv4(n, '192.168.0.0', 16) ||
    cidrMatchIPv4(n, '127.0.0.0', 8) ||
    cidrMatchIPv4(n, '169.254.0.0', 16) ||
    cidrMatchIPv4(n, '0.0.0.0', 8) ||
    cidrMatchIPv4(n, '100.64.0.0', 10)
  );
}

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `ip` falls within a blocked IPv6 range:
 *   - ::1              (loopback)
 *   - fc00::/7         (unique-local — includes fd00::/8)
 *   - fe80::/10        (link-local)
 *   - ::ffff:0:0/96    (IPv4-mapped, validated against IPv4 blocked ranges)
 *   - 64:ff9b::/96     (NAT64 well-known prefix — may map to private IPv4)
 */
export function isBlockedIPv6(ip: string): boolean {
  // Normalise: remove brackets, lowercase
  const addr = ip.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

  // Loopback
  if (addr === '::1') return true;

  // Unique-local: fc00::/7 — first byte fc or fd
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;

  // Link-local: fe80::/10 — first 10 bits = 1111111010
  // fe80 through febf are all link-local
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;

  // IPv4-mapped: ::ffff:<ipv4>
  const v4MappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (v4MappedMatch !== null) {
    const v4 = v4MappedMatch[1];
    if (v4 !== undefined && isBlockedIPv4(v4)) return true;
  }

  // NAT64 well-known prefix 64:ff9b::/96 maps to IPv4 space
  if (addr.startsWith('64:ff9b::')) return true;

  // Unspecified address
  if (addr === '::') return true;

  return false;
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Returns true if the resolved address is in any blocked range.
 * `family` must be 4 (IPv4) or 6 (IPv6).
 */
export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return isBlockedIPv4(address);
  return isBlockedIPv6(address);
}
