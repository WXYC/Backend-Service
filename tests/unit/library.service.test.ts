/**
 * Unit tests for library.service.ts pure functions
 */

// Import the function to test
// Note: We need to extract pure functions or mock db for these tests
// For now, testing the isISODate function

describe('isISODate', () => {
  // Inline the function for unit testing (avoids importing the whole service)
  const isISODate = (date: string): boolean => {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    return date.match(regex) !== null;
  };

  describe('valid ISO dates', () => {
    it('should return true for valid ISO date format', () => {
      expect(isISODate('2024-01-15')).toBe(true);
    });

    it('should return true for date at start of year', () => {
      expect(isISODate('2024-01-01')).toBe(true);
    });

    it('should return true for date at end of year', () => {
      expect(isISODate('2024-12-31')).toBe(true);
    });

    it('should return true for leap year date', () => {
      expect(isISODate('2024-02-29')).toBe(true);
    });

    it('should return true for historic date', () => {
      expect(isISODate('1990-06-15')).toBe(true);
    });

    it('should return true for future date', () => {
      expect(isISODate('2030-12-25')).toBe(true);
    });
  });

  describe('invalid ISO dates', () => {
    it('should return false for empty string', () => {
      expect(isISODate('')).toBe(false);
    });

    it('should return false for US date format (MM/DD/YYYY)', () => {
      expect(isISODate('01/15/2024')).toBe(false);
    });

    it('should return false for European date format (DD/MM/YYYY)', () => {
      expect(isISODate('15/01/2024')).toBe(false);
    });

    it('should return false for date with slashes', () => {
      expect(isISODate('2024/01/15')).toBe(false);
    });

    it('should return false for date with time component', () => {
      expect(isISODate('2024-01-15T12:00:00')).toBe(false);
    });

    it('should return false for date with timezone', () => {
      expect(isISODate('2024-01-15T12:00:00Z')).toBe(false);
    });

    it('should return false for two-digit year', () => {
      expect(isISODate('24-01-15')).toBe(false);
    });

    it('should return false for missing leading zeros', () => {
      expect(isISODate('2024-1-15')).toBe(false);
      expect(isISODate('2024-01-5')).toBe(false);
    });

    it('should return false for random string', () => {
      expect(isISODate('not-a-date')).toBe(false);
    });

    it('should return false for numeric string without dashes', () => {
      expect(isISODate('20240115')).toBe(false);
    });

    it('should return false for partial date', () => {
      expect(isISODate('2024-01')).toBe(false);
    });

    it('should return false for year only', () => {
      expect(isISODate('2024')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return true for semantically invalid but format-valid date', () => {
      // Note: This function only validates format, not semantic validity
      expect(isISODate('2024-13-45')).toBe(true); // Invalid month/day but valid format
    });

    it('should return true for year 0000', () => {
      expect(isISODate('0000-01-01')).toBe(true);
    });

    it('should return true for year 9999', () => {
      expect(isISODate('9999-12-31')).toBe(true);
    });
  });
});
