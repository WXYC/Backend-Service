import { jest, describe, it, expect } from '@jest/globals';
import { randomBytes } from 'crypto';

import {
  encryptStationPasscodeValue,
  decryptStationPasscodeValue,
  generatePasscodeCode,
  constantTimeStringsEqual,
  findActivePasscodeMatch,
  canonicalizeStationSignupClientIp,
  deriveStationSignupIpHash,
  computeSignupCooldownState,
  resolveCooldownLookbackStart,
  isStationPasscodeActive,
  isStationPasscodeRecentlyInactive,
  SIGNUP_COOLDOWN_WINDOW_MS,
  SIGNUP_COOLDOWN_HOLD_MS,
  SIGNUP_COOLDOWN_THRESHOLD,
} from '../../../shared/authentication/src/station-passcode';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

describe('encryptStationPasscodeValue / decryptStationPasscodeValue', () => {
  it('round-trips a plaintext code through the same key', () => {
    const ciphertext = encryptStationPasscodeValue('WXYC2026', KEY_A);
    expect(decryptStationPasscodeValue(ciphertext, KEY_A)).toBe('WXYC2026');
  });

  it('stores iv:tag:ciphertext as three base64 segments', () => {
    const ciphertext = encryptStationPasscodeValue('ABCD2345', KEY_A);
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(3);
    parts.forEach((part) => expect(() => Buffer.from(part, 'base64')).not.toThrow());
  });

  it('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
    const first = encryptStationPasscodeValue('SAMECODE', KEY_A);
    const second = encryptStationPasscodeValue('SAMECODE', KEY_A);
    expect(first).not.toBe(second);
  });

  it('fails closed (throws) when decrypting with the wrong key', () => {
    const ciphertext = encryptStationPasscodeValue('WXYC2026', KEY_A);
    expect(() => decryptStationPasscodeValue(ciphertext, KEY_B)).toThrow();
  });

  it('throws on malformed ciphertext (wrong segment count)', () => {
    expect(() => decryptStationPasscodeValue('not:enough', KEY_A)).toThrow();
  });
});

describe('generatePasscodeCode', () => {
  const UNAMBIGUOUS_ALPHABET = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/;

  it('generates an 8-character code by default', () => {
    expect(generatePasscodeCode()).toHaveLength(8);
  });

  it('respects a custom length', () => {
    expect(generatePasscodeCode(12)).toHaveLength(12);
  });

  it('never contains ambiguous characters (0, O, 1, I) or lowercase', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePasscodeCode();
      expect(code).toMatch(UNAMBIGUOUS_ALPHABET);
      expect(code).not.toMatch(/[01OIl]/);
    }
  });
});

describe('constantTimeStringsEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeStringsEqual('WXYC2026', 'WXYC2026')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(constantTimeStringsEqual('WXYC2026', 'WXYC2027')).toBe(false);
  });

  it('returns false (and does not throw) for strings of different length', () => {
    expect(() => constantTimeStringsEqual('short', 'a-much-longer-string')).not.toThrow();
    expect(constantTimeStringsEqual('short', 'a-much-longer-string')).toBe(false);
  });
});

describe('findActivePasscodeMatch (no-early-exit combination)', () => {
  it('compares every row regardless of where the match falls', () => {
    const rows = [
      { id: 'row-1', decryptedCode: 'AAAAAAAA' },
      { id: 'row-2', decryptedCode: 'BBBBBBBB' },
    ];
    const compare = jest.fn((a: string, b: string) => a === b);

    // Match is the FIRST row — a naive early-return implementation would
    // still compare both, but a naive early-return-on-match would stop here.
    findActivePasscodeMatch(rows, 'AAAAAAAA', compare);
    expect(compare).toHaveBeenCalledTimes(rows.length);

    compare.mockClear();
    // Match is the LAST row.
    findActivePasscodeMatch(rows, 'BBBBBBBB', compare);
    expect(compare).toHaveBeenCalledTimes(rows.length);

    compare.mockClear();
    // No match at all.
    findActivePasscodeMatch(rows, 'CCCCCCCC', compare);
    expect(compare).toHaveBeenCalledTimes(rows.length);
  });

  it('returns the id of the matching row', () => {
    const rows = [
      { id: 'row-1', decryptedCode: 'AAAAAAAA' },
      { id: 'row-2', decryptedCode: 'BBBBBBBB' },
    ];
    expect(findActivePasscodeMatch(rows, 'BBBBBBBB')).toBe('row-2');
  });

  it('returns null when nothing matches', () => {
    const rows = [{ id: 'row-1', decryptedCode: 'AAAAAAAA' }];
    expect(findActivePasscodeMatch(rows, 'ZZZZZZZZ')).toBeNull();
  });

  it('returns null against an empty active-row set', () => {
    expect(findActivePasscodeMatch([], 'AAAAAAAA')).toBeNull();
  });
});

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

describe('isStationPasscodeActive / isStationPasscodeRecentlyInactive', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  it('active: not revoked and not yet expired', () => {
    expect(isStationPasscodeActive({ revokedAt: null, expiresAt: new Date('2026-09-10T00:00:00Z') }, now)).toBe(true);
  });

  it('inactive: revoked, regardless of expiry', () => {
    expect(
      isStationPasscodeActive(
        { revokedAt: new Date('2026-09-01T00:00:00Z'), expiresAt: new Date('2026-09-10T00:00:00Z') },
        now
      )
    ).toBe(false);
  });

  it('inactive: past expiry, even if never revoked', () => {
    expect(isStationPasscodeActive({ revokedAt: null, expiresAt: new Date('2026-09-01T00:00:00Z') }, now)).toBe(false);
  });

  it('recently inactive: expired within the horizon', () => {
    const since = new Date('2026-08-06T12:00:00Z');
    const row = { revokedAt: null, expiresAt: new Date('2026-09-01T00:00:00Z') };
    expect(isStationPasscodeRecentlyInactive(row, now, since)).toBe(true);
  });

  it('not recently inactive: expired before the horizon', () => {
    const since = new Date('2026-08-06T12:00:00Z');
    const row = { revokedAt: null, expiresAt: new Date('2026-07-01T00:00:00Z') };
    expect(isStationPasscodeRecentlyInactive(row, now, since)).toBe(false);
  });

  it('not recently inactive when the row is still active', () => {
    const since = new Date('2026-08-06T12:00:00Z');
    const row = { revokedAt: null, expiresAt: new Date('2026-09-10T00:00:00Z') };
    expect(isStationPasscodeRecentlyInactive(row, now, since)).toBe(false);
  });
});

describe('resolveCooldownLookbackStart (clear-as-window-floor)', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const fixedLookback = new Date(now.getTime() - (SIGNUP_COOLDOWN_WINDOW_MS + SIGNUP_COOLDOWN_HOLD_MS));

  it('uses the fixed lookback when there has never been a clear', () => {
    expect(resolveCooldownLookbackStart(now, null)).toEqual(fixedLookback);
  });

  it('uses the fixed lookback when the clear predates it', () => {
    const oldClear = new Date(fixedLookback.getTime() - 60 * 60 * 1000);
    expect(resolveCooldownLookbackStart(now, oldClear)).toEqual(fixedLookback);
  });

  it('uses the clear timestamp as a floor when it is more recent than the lookback', () => {
    const recentClear = new Date(now.getTime() - 5 * 60 * 1000);
    expect(resolveCooldownLookbackStart(now, recentClear)).toEqual(recentClear);
  });
});

describe('computeSignupCooldownState (cooldown arithmetic)', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  function failuresEndingAt(
    count: number,
    endTime: Date,
    spacingMs = 1000
  ): Array<{ outcome: string; attemptedAt: Date }> {
    return Array.from({ length: count }, (_, i) => ({
      outcome: 'passcode_fail',
      attemptedAt: new Date(endTime.getTime() - (count - 1 - i) * spacingMs),
    }));
  }

  it('is not in cooldown with no attempts', () => {
    const result = computeSignupCooldownState([], now);
    expect(result).toEqual({ inCooldown: false, noMatchFailureCount: 0, allFailureCount: 0 });
  });

  it('is not in cooldown at exactly the threshold (more than 20 required)', () => {
    const rows = failuresEndingAt(SIGNUP_COOLDOWN_THRESHOLD, now);
    const result = computeSignupCooldownState(rows, now);
    expect(result.noMatchFailureCount).toBe(SIGNUP_COOLDOWN_THRESHOLD);
    expect(result.inCooldown).toBe(false);
  });

  it('enters cooldown at threshold + 1 failures inside the window', () => {
    const rows = failuresEndingAt(SIGNUP_COOLDOWN_THRESHOLD + 1, now);
    const result = computeSignupCooldownState(rows, now);
    expect(result.noMatchFailureCount).toBe(SIGNUP_COOLDOWN_THRESHOLD + 1);
    expect(result.inCooldown).toBe(true);
  });

  it('does not trigger when the failures are spread across more than the window', () => {
    // 21 failures, but spaced so the first and last are outside a single
    // 10-minute window from each other — no 10-minute slice contains > 20.
    const spacingMs = (SIGNUP_COOLDOWN_WINDOW_MS / (SIGNUP_COOLDOWN_THRESHOLD + 1)) * 2;
    const rows = failuresEndingAt(SIGNUP_COOLDOWN_THRESHOLD + 1, now, spacingMs);
    const result = computeSignupCooldownState(rows, now);
    expect(result.inCooldown).toBe(false);
  });

  it('self-heals: holds for SIGNUP_COOLDOWN_HOLD_MS after the last qualifying failure, then lifts', () => {
    const triggerTime = new Date(now.getTime() - (SIGNUP_COOLDOWN_HOLD_MS - 60 * 1000));
    const rows = failuresEndingAt(SIGNUP_COOLDOWN_THRESHOLD + 1, triggerTime);

    // Still within the hold window.
    expect(computeSignupCooldownState(rows, now).inCooldown).toBe(true);

    // Now past the hold window relative to the trigger.
    const later = new Date(triggerTime.getTime() + SIGNUP_COOLDOWN_HOLD_MS + 1000);
    expect(computeSignupCooldownState(rows, later).inCooldown).toBe(false);
  });

  it('counts all failure outcomes for allFailureCount but only passcode_fail for noMatchFailureCount', () => {
    const rows = [
      { outcome: 'passcode_fail', attemptedAt: now },
      { outcome: 'passcode_expired', attemptedAt: now },
      { outcome: 'passcode_revoked', attemptedAt: now },
      { outcome: 'passcode_exhausted', attemptedAt: now },
    ];
    const result = computeSignupCooldownState(rows, now);
    expect(result.noMatchFailureCount).toBe(1);
    expect(result.allFailureCount).toBe(4);
  });

  it('a burst of non-no-match failures alone never triggers cooldown', () => {
    const rows = Array.from({ length: 50 }, () => ({ outcome: 'passcode_expired', attemptedAt: now }));
    const result = computeSignupCooldownState(rows, now);
    expect(result.inCooldown).toBe(false);
    expect(result.allFailureCount).toBe(50);
    expect(result.noMatchFailureCount).toBe(0);
  });
});
