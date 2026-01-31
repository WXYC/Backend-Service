// Mock dependencies before importing the service
jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
  },
  anonymous_devices: {},
}));

jest.mock('jose', () => ({
  SignJWT: jest.fn().mockImplementation(() => ({
    setProtectedHeader: jest.fn().mockReturnThis(),
    setIssuedAt: jest.fn().mockReturnThis(),
    setExpirationTime: jest.fn().mockReturnThis(),
    sign: jest.fn().mockResolvedValue('mock-token'),
  })),
  jwtVerify: jest.fn(),
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
}));

import { isValidDeviceId, tokenNeedsRefresh } from '../../../apps/backend/services/anonymousDevice.service';
import { daysFromNow } from '../../utils/time';
import {
  VALID_UUIDS,
  INVALID_UUIDS,
  TEST_UUID_UPPERCASE,
} from '../../utils/constants';

describe('anonymousDevice.service', () => {
  describe('isValidDeviceId', () => {
    it('returns true for valid UUID v4 format', () => {
      VALID_UUIDS.forEach((uuid) => {
        expect(isValidDeviceId(uuid)).toBe(true);
      });
    });

    it('returns true for uppercase UUIDs', () => {
      expect(isValidDeviceId(TEST_UUID_UPPERCASE)).toBe(true);
    });

    it('returns true for mixed case UUIDs', () => {
      expect(isValidDeviceId('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
    });

    it('returns false for invalid UUID formats', () => {
      INVALID_UUIDS.forEach((uuid) => {
        expect(isValidDeviceId(uuid)).toBe(false);
      });
    });
  });

  describe('tokenNeedsRefresh', () => {
    // Note: tokenNeedsRefresh uses REFRESH_THRESHOLD_DAYS from env (default 7)
    // It returns true if expiration date <= current date + threshold

    it('returns true when token expires within threshold', () => {
      expect(tokenNeedsRefresh(daysFromNow(6))).toBe(true);
    });

    it('returns true when token is already expired', () => {
      expect(tokenNeedsRefresh(daysFromNow(-1))).toBe(true);
    });

    it('returns true when token expires exactly at threshold', () => {
      expect(tokenNeedsRefresh(daysFromNow(7))).toBe(true);
    });

    it('returns false when token expires well after threshold', () => {
      expect(tokenNeedsRefresh(daysFromNow(30))).toBe(false);
    });

    it('returns false when token expires just after threshold', () => {
      expect(tokenNeedsRefresh(daysFromNow(8))).toBe(false);
    });
  });
});
