import dns from 'dns/promises';
import { isIP } from 'net';

// Private, loopback, and link-local ranges to block (SSRF prevention)
const BLOCKED_RANGES = [
  /^127\./,                            // loopback
  /^10\./,                             // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,       // RFC 1918
  /^192\.168\./,                       // RFC 1918
  /^169\.254\./,                       // link-local / cloud metadata (169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC 6598 CGNAT 100.64.0.0/10
  /^0\./,                              // "this" network
  /^::1$/,                             // IPv6 loopback
  /^fc00:/i,                           // IPv6 unique local
  /^fe80:/i,                           // IPv6 link-local
  /^::ffff:127\./i,                    // IPv4-mapped loopback
  /^::ffff:10\./i,                     // IPv4-mapped RFC 1918
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i, // IPv4-mapped RFC 1918
  /^::ffff:192\.168\./i,               // IPv4-mapped RFC 1918
  /^::ffff:169\.254\./i,               // IPv4-mapped link-local
];

function isBlockedIp(ip) {
  return BLOCKED_RANGES.some((re) => re.test(ip));
}

/**
 * Validates that a hostname does not resolve to a private/internal IP.
 * Throws if the host is blocked. Returns silently if safe.
 */
async function validateHost(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    throw new Error('INVALID_HOST');
  }

  // If it's a raw IP, check it directly
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('SSRF_BLOCKED');
    }
    return;
  }

  // Resolve DNS and check all returned addresses
  const [ipv4, ipv6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const addresses = [
    ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
    ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
  ];

  // If DNS failed entirely, fail closed — we cannot verify the destination is safe
  if (addresses.length === 0) throw new Error('SSRF_BLOCKED');

  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new Error('SSRF_BLOCKED');
    }
  }
}

export default validateHost;
