/**
 * Moved verbatim out of station-passcode.test.ts (BS#2537, parent epic #2534
 * decision 8) alongside the `canonicalizeStationSignupClientIp` /
 * `deriveStationSignupIpHash` pure move into `signup-ip-hash.ts`. No
 * assertions changed — this is a relocation, not a rewrite.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';

import {
  canonicalizeStationSignupClientIp,
  deriveStationSignupIpHash,
} from '../../../shared/authentication/src/signup-ip-hash';

describe('canonicalizeStationSignupClientIp', () => {
  it('trims and lowercases', () => {
    expect(canonicalizeStationSignupClientIp('  10.0.0.1  ')).toBe('10.0.0.1');
  });

  it('reduces an IPv4-mapped IPv6 address to its dotted quad', () => {
    expect(canonicalizeStationSignupClientIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });

  it('is case-insensitive on the IPv6 prefix and hex digits', () => {
    expect(canonicalizeStationSignupClientIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('returns null for an invalid address', () => {
    expect(canonicalizeStationSignupClientIp('not-an-ip')).toBeNull();
  });

  it('returns null for undefined/empty input', () => {
    expect(canonicalizeStationSignupClientIp(undefined)).toBeNull();
    expect(canonicalizeStationSignupClientIp('')).toBeNull();
  });
});

describe('deriveStationSignupIpHash', () => {
  const originalKey = process.env.STATION_SIGNUP_IP_HMAC_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.STATION_SIGNUP_IP_HMAC_KEY;
    else process.env.STATION_SIGNUP_IP_HMAC_KEY = originalKey;
  });

  it('derives a stable 16-hex-character hash for a valid IP and key', () => {
    process.env.STATION_SIGNUP_IP_HMAC_KEY = randomBytes(32).toString('hex');
    const first = deriveStationSignupIpHash('10.0.0.1');
    const second = deriveStationSignupIpHash('10.0.0.1');
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toBe(second);
  });

  it('produces equal hashes for equal IPs under different spellings', () => {
    process.env.STATION_SIGNUP_IP_HMAC_KEY = randomBytes(32).toString('hex');
    expect(deriveStationSignupIpHash('::ffff:10.0.0.1')).toBe(deriveStationSignupIpHash('10.0.0.1'));
  });

  it('returns null (never throws) when the key is missing', () => {
    delete process.env.STATION_SIGNUP_IP_HMAC_KEY;
    expect(() => deriveStationSignupIpHash('10.0.0.1')).not.toThrow();
    expect(deriveStationSignupIpHash('10.0.0.1')).toBeNull();
  });

  it('returns null (never throws) when the key is the wrong length', () => {
    process.env.STATION_SIGNUP_IP_HMAC_KEY = 'deadbeef';
    expect(deriveStationSignupIpHash('10.0.0.1')).toBeNull();
  });

  it('returns null (never throws) for a missing/invalid IP even with a good key', () => {
    process.env.STATION_SIGNUP_IP_HMAC_KEY = randomBytes(32).toString('hex');
    expect(deriveStationSignupIpHash(undefined)).toBeNull();
    expect(deriveStationSignupIpHash('not-an-ip')).toBeNull();
  });
});
