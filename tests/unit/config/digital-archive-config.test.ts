/**
 * Unit tests for the digital-archive playback config (BS#2320).
 *
 *   1. `enabled` is strict `=== 'true'` — an `=1`/`TRUE`/`yes` override must
 *      not light up presigned playback.
 *   2. `signTTLSeconds` defaults to 4 hours, clamps at the 7-day ceiling, and
 *      falls back to the default on a non-positive/non-integer/unparseable
 *      override rather than throwing.
 */
import {
  getConfig,
  loadConfig,
  resetConfig,
  DEFAULT_SIGN_TTL_SECONDS,
  MAX_SIGN_TTL_SECONDS,
} from '../../../apps/backend/config/digitalArchive';

describe('digitalArchive config', () => {
  const originalEnabled = process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED;
  const originalTTL = process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED;
    delete process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS;
    resetConfig();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    if (originalEnabled === undefined) delete process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED;
    else process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED = originalEnabled;
    if (originalTTL === undefined) delete process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS;
    else process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS = originalTTL;
    resetConfig();
  });

  describe('enabled', () => {
    it('defaults to false when unset', () => {
      expect(loadConfig().enabled).toBe(false);
    });

    it('is true only for the literal string "true"', () => {
      process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED = 'true';
      expect(loadConfig().enabled).toBe(true);
    });

    it.each(['1', 'TRUE', 'yes', 'True'])('treats %s as false (strict gate)', (value) => {
      process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED = value;
      expect(loadConfig().enabled).toBe(false);
    });
  });

  describe('signTTLSeconds', () => {
    it('defaults to 14400 (4 hours) when unset', () => {
      expect(loadConfig().signTTLSeconds).toBe(DEFAULT_SIGN_TTL_SECONDS);
      expect(DEFAULT_SIGN_TTL_SECONDS).toBe(14400);
    });

    it('honors a valid positive-integer override', () => {
      process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS = '3600';
      expect(loadConfig().signTTLSeconds).toBe(3600);
    });

    it('clamps at the 7-day ceiling', () => {
      process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS = String(MAX_SIGN_TTL_SECONDS + 1000);
      expect(loadConfig().signTTLSeconds).toBe(MAX_SIGN_TTL_SECONDS);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('accepts exactly the ceiling without clamping-warning', () => {
      process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS = String(MAX_SIGN_TTL_SECONDS);
      expect(loadConfig().signTTLSeconds).toBe(MAX_SIGN_TTL_SECONDS);
    });

    it.each(['0', '-100', 'abc', '', '3.5'])('falls back to the default on %p', (value) => {
      process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS = value;
      expect(loadConfig().signTTLSeconds).toBe(DEFAULT_SIGN_TTL_SECONDS);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('getConfig / resetConfig memoization', () => {
    it('memoizes until resetConfig() is called', () => {
      process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED = 'true';
      expect(getConfig().enabled).toBe(true);
      process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED = 'false';
      expect(getConfig().enabled).toBe(true);
      resetConfig();
      expect(getConfig().enabled).toBe(false);
    });
  });
});
