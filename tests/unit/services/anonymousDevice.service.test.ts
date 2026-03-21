// Mock Sentry
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

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

jest.mock('jose', () => {
  // Set env var before module loads (jest.mock factories are hoisted)
  process.env.ANON_DEVICE_JWT_SECRET = process.env.ANON_DEVICE_JWT_SECRET || 'test-secret-at-least-32-chars-long!!';
  return {
    SignJWT: jest.fn().mockImplementation(() => ({
      setProtectedHeader: jest.fn().mockReturnThis(),
      setIssuedAt: jest.fn().mockReturnThis(),
      setExpirationTime: jest.fn().mockReturnThis(),
      sign: jest.fn().mockResolvedValue('mock-token'),
    })),
    jwtVerify: jest.fn(),
  };
});

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
}));

import {
  isValidDeviceId,
  tokenNeedsRefresh,
  validateTokenAndDevice,
} from '../../../apps/backend/services/anonymousDevice.service';
import * as jose from 'jose';
import { db } from '@wxyc/database';
import { daysFromNow } from '../../utils/time';
import { VALID_UUIDS, INVALID_UUIDS, TEST_UUID_UPPERCASE } from '../../utils/constants';

const mockJwtVerify = jose.jwtVerify as jest.Mock;
const mockDb = db as jest.Mocked<typeof db>;

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

  describe('validateTokenAndDevice', () => {
    const testDeviceId = '550e8400-e29b-41d4-a716-446655440000';

    beforeEach(() => {
      jest.clearAllMocks();

      // Set up jose.jwtVerify to return a valid payload (token far from expiry)
      mockJwtVerify.mockResolvedValue({
        payload: { deviceId: testDeviceId, iat: Math.floor(Date.now() / 1000), exp: daysFromNow(30) },
      });

      // Set up db.select chain -> returns a device
      const selectChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ deviceId: testDeviceId, blocked: false }]),
      };
      (mockDb.select as jest.Mock).mockReturnValue(selectChain);
    });

    it('reports recordDeviceActivity failure to Sentry', async () => {
      const activityError = new Error('DB write failed');
      const updateChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockRejectedValue(activityError),
      };
      (mockDb.update as jest.Mock).mockReturnValue(updateChain);

      const result = await validateTokenAndDevice('mock-token');

      // Wait for fire-and-forget .catch() to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(result.valid).toBe(true);
      expect(mockCaptureException).toHaveBeenCalledWith(
        activityError,
        expect.objectContaining({
          tags: { subsystem: 'activity-tracking' },
          extra: { deviceId: testDeviceId },
        })
      );
    });
  });
});
