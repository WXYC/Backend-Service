import { isValidDeviceId, tokenNeedsRefresh } from '@/services/anonymousDevice.service';

describe('anonymousDevice.service', () => {
  describe('isValidDeviceId', () => {
    it('returns true for valid UUID v4 format', () => {
      expect(isValidDeviceId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidDeviceId('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
      expect(isValidDeviceId('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    });

    it('returns true for uppercase UUIDs', () => {
      expect(isValidDeviceId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('returns true for mixed case UUIDs', () => {
      expect(isValidDeviceId('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
    });

    it('returns false for invalid UUID formats', () => {
      expect(isValidDeviceId('')).toBe(false);
      expect(isValidDeviceId('not-a-uuid')).toBe(false);
      expect(isValidDeviceId('550e8400e29b41d4a716446655440000')).toBe(false); // no dashes
      expect(isValidDeviceId('550e8400-e29b-41d4-a716')).toBe(false); // too short
      expect(isValidDeviceId('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false); // too long
      expect(isValidDeviceId('gggggggg-gggg-gggg-gggg-gggggggggggg')).toBe(false); // invalid hex
    });

    it('returns false for UUID-like strings with wrong segment lengths', () => {
      expect(isValidDeviceId('550e840-e29b-41d4-a716-446655440000')).toBe(false); // first segment too short
      expect(isValidDeviceId('550e8400-e29-41d4-a716-446655440000')).toBe(false); // second segment too short
    });
  });

  describe('tokenNeedsRefresh', () => {
    // Note: tokenNeedsRefresh uses REFRESH_THRESHOLD_DAYS from env (default 7)
    // It returns true if expiration date <= current date + threshold

    it('returns true when token expires within threshold', () => {
      const now = Date.now();
      const expiresInSixDays = Math.floor(now / 1000) + 6 * 24 * 60 * 60;
      expect(tokenNeedsRefresh(expiresInSixDays)).toBe(true);
    });

    it('returns true when token is already expired', () => {
      const now = Date.now();
      const expiredYesterday = Math.floor(now / 1000) - 24 * 60 * 60;
      expect(tokenNeedsRefresh(expiredYesterday)).toBe(true);
    });

    it('returns true when token expires exactly at threshold', () => {
      const now = Date.now();
      // Expires in exactly 7 days (default threshold)
      const expiresInSevenDays = Math.floor(now / 1000) + 7 * 24 * 60 * 60;
      expect(tokenNeedsRefresh(expiresInSevenDays)).toBe(true);
    });

    it('returns false when token expires well after threshold', () => {
      const now = Date.now();
      const expiresInThirtyDays = Math.floor(now / 1000) + 30 * 24 * 60 * 60;
      expect(tokenNeedsRefresh(expiresInThirtyDays)).toBe(false);
    });

    it('returns false when token expires just after threshold', () => {
      const now = Date.now();
      // Expires in 8 days (just past default 7-day threshold)
      const expiresInEightDays = Math.floor(now / 1000) + 8 * 24 * 60 * 60;
      expect(tokenNeedsRefresh(expiresInEightDays)).toBe(false);
    });
  });
});
