// Mock dependencies before importing the service
jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
  },
  library: {},
  artists: {},
  genres: {},
  format: {},
  rotation: {},
  library_artist_view: {},
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
  desc: jest.fn((col) => ({ desc: col })),
}));

import { isISODate } from '../../../apps/backend/services/library.service';

describe('library.service', () => {
  describe('isISODate', () => {
    it('returns true for valid ISO date format YYYY-MM-DD', () => {
      expect(isISODate('2024-01-15')).toBe(true);
      expect(isISODate('2000-12-31')).toBe(true);
      expect(isISODate('1999-06-01')).toBe(true);
    });

    it('returns false for invalid formats', () => {
      expect(isISODate('01-15-2024')).toBe(false); // MM-DD-YYYY
      expect(isISODate('15/01/2024')).toBe(false); // DD/MM/YYYY
      expect(isISODate('2024/01/15')).toBe(false); // YYYY/MM/DD
      expect(isISODate('January 15, 2024')).toBe(false);
      expect(isISODate('2024-1-15')).toBe(false); // single digit month
      expect(isISODate('2024-01-5')).toBe(false); // single digit day
    });

    it('returns false for empty or invalid strings', () => {
      expect(isISODate('')).toBe(false);
      expect(isISODate('not-a-date')).toBe(false);
      expect(isISODate('2024')).toBe(false);
      expect(isISODate('2024-01')).toBe(false);
    });

    it('returns true for edge case dates (format only, not validity)', () => {
      // Note: isISODate only checks format, not calendar validity
      expect(isISODate('2024-02-29')).toBe(true); // leap year
      expect(isISODate('2024-02-30')).toBe(true); // invalid day but correct format
      expect(isISODate('2024-13-01')).toBe(true); // invalid month but correct format
    });
  });
});
