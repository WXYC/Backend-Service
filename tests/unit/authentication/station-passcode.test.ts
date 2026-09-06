import { jest, describe, it, expect } from '@jest/globals';
import { createHash, randomBytes } from 'crypto';

import {
  encryptStationPasscodeValue,
  decryptStationPasscodeValue,
  stationPasscodeKeyId,
  resolveStationPasscodeKeyRing,
  classifyInactivePasscodeRows,
  generatePasscodeCode,
  constantTimeStringsEqual,
  findActivePasscodeMatch,
  canonicalizeStationSignupClientIp,
  deriveStationSignupIpHash,
  computeSignupCooldownState,
  isSignupCooldownTriggered,
  resolveCooldownLookbackStart,
  resolveCooldownCountStart,
  isStationPasscodeActive,
  isStationPasscodeRecentlyInactive,
  classifyStationPasscodeState,
  StationPasscodeDecryptionError,
  STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON,
  SIGNUP_COOLDOWN_WINDOW_MS,
  SIGNUP_COOLDOWN_HOLD_MS,
  SIGNUP_COOLDOWN_THRESHOLD,
} from '../../../shared/authentication/src/station-passcode';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const KEY_C = randomBytes(32);

describe('encryptStationPasscodeValue / decryptStationPasscodeValue', () => {
  it('round-trips a plaintext code through the same key', () => {
    const ciphertext = encryptStationPasscodeValue('WXYC2026', KEY_A);
    expect(decryptStationPasscodeValue(ciphertext, KEY_A)).toBe('WXYC2026');
  });

  it('stores keyid:iv:tag:ciphertext as four segments', () => {
    const ciphertext = encryptStationPasscodeValue('ABCD2345', KEY_A);
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(4);
    parts.slice(1).forEach((part) => expect(() => Buffer.from(part, 'base64')).not.toThrow());
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

  it('rejects the legacy 3-segment iv:tag:ciphertext format as malformed', () => {
    // The pre-fingerprint format. A deliberate clean break, taken while
    // station_passcode was empty in production: accepting it would mean
    // guessing which key wrote the row, which is the ambiguity the
    // fingerprint exists to remove.
    const legacy = encryptStationPasscodeValue('WXYC2026', KEY_A).split(':').slice(1).join(':');
    expect(legacy.split(':')).toHaveLength(3);
    expect(() => decryptStationPasscodeValue(legacy, KEY_A)).toThrow(StationPasscodeDecryptionError);
    try {
      decryptStationPasscodeValue(legacy, KEY_A);
    } catch (error) {
      expect((error as StationPasscodeDecryptionError).reason).toBe('malformed');
    }
  });
});

describe('key fingerprint (segment 0)', () => {
  it('is the first 8 hex characters of SHA-256 over the raw key bytes', () => {
    const expected = createHash('sha256').update(KEY_A).digest('hex').slice(0, 8);
    expect(stationPasscodeKeyId(KEY_A)).toBe(expected);
    expect(stationPasscodeKeyId(KEY_A)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable across calls and distinct between keys', () => {
    expect(stationPasscodeKeyId(KEY_A)).toBe(stationPasscodeKeyId(Buffer.from(KEY_A)));
    expect(stationPasscodeKeyId(KEY_A)).not.toBe(stationPasscodeKeyId(KEY_B));
  });

  it('is written as segment 0 of every ciphertext, naming the encrypting key', () => {
    expect(encryptStationPasscodeValue('WXYC2026', KEY_A).split(':')[0]).toBe(stationPasscodeKeyId(KEY_A));
    expect(encryptStationPasscodeValue('WXYC2026', KEY_B).split(':')[0]).toBe(stationPasscodeKeyId(KEY_B));
  });

  it('classifies an unheld key as unknown_key, not as corruption', () => {
    // The ROTATION shape: recoverable by setting STATION_PASSCODE_KEY_PREVIOUS,
    // and the shape rotateStationPasscode administratively revokes.
    const ciphertext = encryptStationPasscodeValue('WXYC2026', KEY_A);
    try {
      decryptStationPasscodeValue(ciphertext, [KEY_B, KEY_C]);
      throw new Error('expected a decryption failure');
    } catch (error) {
      expect(error).toBeInstanceOf(StationPasscodeDecryptionError);
      const failure = error as StationPasscodeDecryptionError;
      expect(failure.reason).toBe('unknown_key');
      expect(failure.keyId).toBe(stationPasscodeKeyId(KEY_A));
      expect(failure.knownKeyIds).toEqual([stationPasscodeKeyId(KEY_B), stationPasscodeKeyId(KEY_C)]);
    }
  });

  it('classifies damaged bytes under a HELD key as corrupt, not as a key problem', () => {
    // No key configuration fixes this one, so the operator must not be sent
    // chasing STATION_PASSCODE_KEY_PREVIOUS for it.
    const [keyId, iv, tag] = encryptStationPasscodeValue('WXYC2026', KEY_A).split(':');
    const damaged = [keyId, iv, tag, Buffer.from('garbage').toString('base64')].join(':');
    try {
      decryptStationPasscodeValue(damaged, KEY_A);
      throw new Error('expected a decryption failure');
    } catch (error) {
      expect((error as StationPasscodeDecryptionError).reason).toBe('corrupt');
      expect((error as StationPasscodeDecryptionError).keyId).toBe(keyId);
    }
  });
});

describe('dual-key decryption (current, previous, neither)', () => {
  it('decrypts a row written under the CURRENT key', () => {
    const ciphertext = encryptStationPasscodeValue('CURRENT1', KEY_A);
    expect(decryptStationPasscodeValue(ciphertext, [KEY_A, KEY_B])).toBe('CURRENT1');
  });

  it('decrypts a row written under the PREVIOUS key', () => {
    // The whole point: rows minted before a key rotation keep opening for the
    // 30-day classification horizon, so classification stays exact and the
    // refusal count keeps full fidelity against guessers.
    const ciphertext = encryptStationPasscodeValue('PREVIOUS', KEY_B);
    expect(decryptStationPasscodeValue(ciphertext, [KEY_A, KEY_B])).toBe('PREVIOUS');
  });

  it('fails closed only when NEITHER key opens the row', () => {
    const ciphertext = encryptStationPasscodeValue('NEITHER1', KEY_C);
    expect(() => decryptStationPasscodeValue(ciphertext, [KEY_A, KEY_B])).toThrow(StationPasscodeDecryptionError);
  });

  it('always ENCRYPTS under the key it is handed, never a previous one', () => {
    // Encryption is one-directional so the old key drains out of the table.
    expect(encryptStationPasscodeValue('WXYC2026', KEY_A).split(':')[0]).toBe(stationPasscodeKeyId(KEY_A));
  });
});

describe('resolveStationPasscodeKeyRing', () => {
  const originalCurrent = process.env.STATION_PASSCODE_KEY;
  const originalPrevious = process.env.STATION_PASSCODE_KEY_PREVIOUS;

  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  afterEach(() => {
    restore('STATION_PASSCODE_KEY', originalCurrent);
    restore('STATION_PASSCODE_KEY_PREVIOUS', originalPrevious);
  });

  it('holds only the current key when no previous key is set', () => {
    process.env.STATION_PASSCODE_KEY = KEY_A.toString('hex');
    delete process.env.STATION_PASSCODE_KEY_PREVIOUS;
    expect(resolveStationPasscodeKeyRing().map((entry) => entry.id)).toEqual([stationPasscodeKeyId(KEY_A)]);
  });

  it('holds current then previous, in that order, when both are set', () => {
    process.env.STATION_PASSCODE_KEY = KEY_A.toString('hex');
    process.env.STATION_PASSCODE_KEY_PREVIOUS = KEY_B.toString('hex');
    expect(resolveStationPasscodeKeyRing().map((entry) => entry.id)).toEqual([
      stationPasscodeKeyId(KEY_A),
      stationPasscodeKeyId(KEY_B),
    ]);
  });

  it('drops a previous key identical to the current one — the documented retire step', () => {
    // set-ec2-env-var.yml refuses an empty value, so "clear the previous key"
    // is performed by setting it equal to the current key. That has to be an
    // exact no-op or the runbook's step 4 is a lie.
    process.env.STATION_PASSCODE_KEY = KEY_A.toString('hex');
    process.env.STATION_PASSCODE_KEY_PREVIOUS = KEY_A.toString('hex');
    expect(resolveStationPasscodeKeyRing()).toHaveLength(1);
  });

  it('ignores (never throws on) a malformed previous key', () => {
    // Availability over secrecy: a typo in an OPTIONAL var must not take the
    // gate down. It degrades to single-key behavior, loudly, once.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.STATION_PASSCODE_KEY = KEY_A.toString('hex');
    process.env.STATION_PASSCODE_KEY_PREVIOUS = 'deadbeef';
    expect(() => resolveStationPasscodeKeyRing()).not.toThrow();
    expect(resolveStationPasscodeKeyRing().map((entry) => entry.id)).toEqual([stationPasscodeKeyId(KEY_A)]);
    consoleError.mockRestore();
  });

  it('still throws when the CURRENT key is missing — there is no degraded mode for it', () => {
    delete process.env.STATION_PASSCODE_KEY;
    expect(() => resolveStationPasscodeKeyRing()).toThrow(/STATION_PASSCODE_KEY is not set/);
  });
});

describe('classifyInactivePasscodeRows (the passcode_unverifiable fall-through)', () => {
  const inactiveRow = (id: string, code: string, revokedAt: Date | null = null) => ({
    id,
    revokedAt,
    codeEncrypted: encryptStationPasscodeValue(code, KEY_A),
  });
  const decryptWithA = (stored: string) => decryptStationPasscodeValue(stored, KEY_A);

  it('classifies a match against an expired row as passcode_expired, with its id', () => {
    const rows = [inactiveRow('row-1', 'STALE123')];
    expect(classifyInactivePasscodeRows(rows, 'STALE123', decryptWithA)).toEqual({
      outcome: 'passcode_expired',
      passcodeId: 'row-1',
      undecryptableRowIds: [],
    });
  });

  it('classifies a match against a revoked row as passcode_revoked, with its id', () => {
    const rows = [inactiveRow('row-1', 'STALE123', new Date('2026-09-01T00:00:00Z'))];
    expect(classifyInactivePasscodeRows(rows, 'STALE123', decryptWithA)).toEqual({
      outcome: 'passcode_revoked',
      passcodeId: 'row-1',
      undecryptableRowIds: [],
    });
  });

  it('classifies a clean no-match sweep as passcode_fail — the ONLY refusal-feeding token', () => {
    const rows = [inactiveRow('row-1', 'STALE123'), inactiveRow('row-2', 'STALE456')];
    expect(classifyInactivePasscodeRows(rows, 'ZZZZZZZZ', decryptWithA)).toEqual({
      outcome: 'passcode_fail',
      passcodeId: null,
      undecryptableRowIds: [],
    });
  });

  it('classifies a no-match sweep that SKIPPED an undecryptable row as passcode_unverifiable', () => {
    // The defect this closes: the skip used to `continue` straight into
    // `passcode_fail`, so undecryptable rows fed the station-global cooldown
    // and a key misconfiguration could push the station into cooldown on
    // legitimate traffic.
    const rows = [
      { id: 'row-1', revokedAt: null, codeEncrypted: encryptStationPasscodeValue('OTHERKEY', KEY_B) },
      inactiveRow('row-2', 'STALE456'),
    ];
    expect(classifyInactivePasscodeRows(rows, 'ZZZZZZZZ', decryptWithA)).toEqual({
      outcome: 'passcode_unverifiable',
      passcodeId: null,
      // The healing input: the caller marks exactly these rows so the next
      // sweep excludes them and stops relabelling passcode_fail.
      undecryptableRowIds: ['row-1'],
    });
  });

  it('still reports a real match found AFTER a skipped row', () => {
    // A skip must not poison a row that does decrypt and does match — the
    // stale-sticky-note alert is this mechanism's primary designed use case.
    const rows = [
      { id: 'row-1', revokedAt: null, codeEncrypted: encryptStationPasscodeValue('OTHERKEY', KEY_B) },
      inactiveRow('row-2', 'STALE456'),
    ];
    expect(classifyInactivePasscodeRows(rows, 'STALE456', decryptWithA)).toEqual({
      outcome: 'passcode_expired',
      passcodeId: 'row-2',
      // Reported even though the sweep ended in a match: a row that will not
      // open is equally dead either way, and equally worth excluding next time.
      undecryptableRowIds: ['row-1'],
    });
  });

  it('classifies an empty in-horizon set as passcode_fail, not unverifiable', () => {
    expect(classifyInactivePasscodeRows([], 'ZZZZZZZZ', decryptWithA)).toEqual({
      outcome: 'passcode_fail',
      passcodeId: null,
      undecryptableRowIds: [],
    });
  });

  it('reports EVERY undecryptable row it skipped, not just the first', () => {
    // The full mark list matters: the caller marks each one, and a row left
    // unmarked keeps blinding the cooldown for the rest of the 30-day
    // horizon (BS#2359 review 3, the mark-and-exclude finding).
    const rows = [
      { id: 'row-1', revokedAt: null, codeEncrypted: encryptStationPasscodeValue('OTHERKEY', KEY_B) },
      inactiveRow('row-2', 'STALE456'),
      { id: 'row-3', revokedAt: null, codeEncrypted: encryptStationPasscodeValue('THIRDKEY', KEY_C) },
    ];
    expect(classifyInactivePasscodeRows(rows, 'ZZZZZZZZ', decryptWithA)).toEqual({
      outcome: 'passcode_unverifiable',
      passcodeId: null,
      undecryptableRowIds: ['row-1', 'row-3'],
    });
  });

  it('decrypts through the real key ring by default (both keys tried)', () => {
    const rows = [{ id: 'row-1', revokedAt: null, codeEncrypted: encryptStationPasscodeValue('STALE123', KEY_B) }];
    process.env.STATION_PASSCODE_KEY = KEY_A.toString('hex');
    process.env.STATION_PASSCODE_KEY_PREVIOUS = KEY_B.toString('hex');
    try {
      expect(classifyInactivePasscodeRows(rows, 'STALE123')).toEqual({
        outcome: 'passcode_expired',
        passcodeId: 'row-1',
        undecryptableRowIds: [],
      });
    } finally {
      delete process.env.STATION_PASSCODE_KEY;
      delete process.env.STATION_PASSCODE_KEY_PREVIOUS;
    }
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

  it('EXCLUDES a row already marked undecryptable, however recently it went inactive', () => {
    // The "exclude" half of mark-and-exclude, mirrored from
    // recentlyInactivePasscodePredicate's third term. Without it, one
    // unreadable in-horizon row relabels every would-be passcode_fail as the
    // refusal-exempt passcode_unverifiable and the brute-force cooldown —
    // which counts only passcode_fail — never engages.
    const since = new Date('2026-08-06T12:00:00Z');
    const row = {
      revokedAt: new Date('2026-09-04T00:00:00Z'),
      expiresAt: new Date('2026-09-01T00:00:00Z'),
      revokedReason: STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON,
    };
    expect(isStationPasscodeRecentlyInactive(row, now, since)).toBe(false);
  });

  it('still includes an in-horizon row carrying some OTHER revoked_reason', () => {
    const since = new Date('2026-08-06T12:00:00Z');
    const row = {
      revokedAt: new Date('2026-09-04T00:00:00Z'),
      expiresAt: new Date('2026-09-10T00:00:00Z'),
      revokedReason: 'manager revoked it',
    };
    expect(isStationPasscodeRecentlyInactive(row, now, since)).toBe(true);
  });
});

describe('classifyStationPasscodeState (BS#2362 status)', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  it('active when neither revoked nor expired', () => {
    expect(classifyStationPasscodeState({ revokedAt: null, expiresAt: new Date('2026-09-10T00:00:00Z') }, now)).toBe(
      'active'
    );
  });

  it('expired once past expires_at, never revoked', () => {
    expect(classifyStationPasscodeState({ revokedAt: null, expiresAt: new Date('2026-09-01T00:00:00Z') }, now)).toBe(
      'expired'
    );
  });

  it('revoked when revoked_at is set and the row has not expired', () => {
    expect(
      classifyStationPasscodeState(
        { revokedAt: new Date('2026-09-02T00:00:00Z'), expiresAt: new Date('2026-09-10T00:00:00Z') },
        now
      )
    ).toBe('revoked');
  });

  it("reports 'revoked', not 'expired', for a row that is BOTH", () => {
    // Revocation is a deliberate operator action and the only one of the pair
    // carrying a revoked_reason worth reading, so it wins the label.
    expect(
      classifyStationPasscodeState(
        { revokedAt: new Date('2026-08-20T00:00:00Z'), expiresAt: new Date('2026-09-01T00:00:00Z') },
        now
      )
    ).toBe('revoked');
  });

  it('agrees with isStationPasscodeActive on which rows are active', () => {
    const rows = [
      { revokedAt: null, expiresAt: new Date('2026-09-10T00:00:00Z') },
      { revokedAt: null, expiresAt: new Date('2026-09-01T00:00:00Z') },
      { revokedAt: new Date('2026-09-02T00:00:00Z'), expiresAt: new Date('2026-09-10T00:00:00Z') },
    ];
    for (const row of rows) {
      expect(classifyStationPasscodeState(row, now) === 'active').toBe(isStationPasscodeActive(row, now));
    }
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

describe('resolveCooldownCountStart (the floor for the two SQL-side counts)', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const windowStart = new Date(now.getTime() - SIGNUP_COOLDOWN_WINDOW_MS);

  it('scopes the counts to the 10-minute window, not the full trigger lookback', () => {
    // The counts and the trigger check read different spans on purpose: the
    // counts answer "what is happening right now" for #2362's status
    // endpoint, the trigger has to see back through the hold.
    expect(resolveCooldownCountStart(now, null)).toEqual(windowStart);
    expect(resolveCooldownCountStart(now, null).getTime()).toBeGreaterThan(
      resolveCooldownLookbackStart(now, null).getTime()
    );
  });

  it('ignores a clear older than the window', () => {
    expect(resolveCooldownCountStart(now, new Date(windowStart.getTime() - 1000))).toEqual(windowStart);
  });

  it('uses a clear inside the window as the floor', () => {
    const recentClear = new Date(now.getTime() - 60 * 1000);
    expect(resolveCooldownCountStart(now, recentClear)).toEqual(recentClear);
  });
});

describe('isSignupCooldownTriggered (trigger math, passcode_fail rows only)', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const at = (msAgo: number) => ({ attemptedAt: new Date(now.getTime() - msAgo) });

  it('is order-independent — a DESC fetch answers the same as an ASC one', () => {
    // evaluateSignupCooldown fetches newest-first (so its LIMIT keeps the
    // rows that matter); computeSignupCooldownState is handed whatever the
    // caller has. Both must agree.
    const ascending = Array.from({ length: SIGNUP_COOLDOWN_THRESHOLD + 1 }, (_, i) => at(i * 1000));
    const descending = [...ascending].reverse();
    expect(isSignupCooldownTriggered(ascending, now)).toBe(true);
    expect(isSignupCooldownTriggered(descending, now)).toBe(true);
  });

  it('never triggers on the threshold exactly (strictly MORE than 20)', () => {
    expect(
      isSignupCooldownTriggered(
        Array.from({ length: SIGNUP_COOLDOWN_THRESHOLD }, (_, i) => at(i * 1000)),
        now
      )
    ).toBe(false);
  });

  it('ignores rows older than the hold, even when the burst was huge', () => {
    const longAgo = SIGNUP_COOLDOWN_HOLD_MS + 60 * 1000;
    expect(
      isSignupCooldownTriggered(
        Array.from({ length: 200 }, (_, i) => at(longAgo + i * 1000)),
        now
      )
    ).toBe(false);
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

  it('counts passcode_unverifiable toward the alert but never toward refusal', () => {
    // The ninth token is refusal-exempt by construction: an undecryptable row
    // is an operator problem, and counting it toward the station-global
    // cooldown would convert a key misconfiguration into the locked-out
    // control room #2365 forbids.
    const rows = [
      { outcome: 'passcode_fail', attemptedAt: now },
      { outcome: 'passcode_unverifiable', attemptedAt: now },
    ];
    const result = computeSignupCooldownState(rows, now);
    expect(result.noMatchFailureCount).toBe(1);
    expect(result.allFailureCount).toBe(2);
  });

  it('a flood of passcode_unverifiable rows alone never triggers cooldown', () => {
    const rows = Array.from({ length: 500 }, () => ({ outcome: 'passcode_unverifiable', attemptedAt: now }));
    const result = computeSignupCooldownState(rows, now);
    expect(result.inCooldown).toBe(false);
    expect(result.noMatchFailureCount).toBe(0);
    expect(result.allFailureCount).toBe(500);
  });
});
