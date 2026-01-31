import { safeSql, safeSqlNum, toMs, expBackoffMs } from '../../../../apps/backend/middleware/legacy/utilities.mirror';

describe('utilities.mirror', () => {
  describe('safeSql', () => {
    it('returns NULL for undefined', () => {
      expect(safeSql(undefined)).toBe('NULL');
    });

    it('returns NULL for null', () => {
      expect(safeSql(null)).toBe('NULL');
    });

    it('wraps strings in single quotes', () => {
      expect(safeSql('hello')).toBe("'hello'");
    });

    it('escapes single quotes by doubling them', () => {
      expect(safeSql("it's")).toBe("'it''s'");
      expect(safeSql("don't stop")).toBe("'don''t stop'");
    });

    it('handles multiple single quotes', () => {
      expect(safeSql("it's a 'test'")).toBe("'it''s a ''test'''");
    });

    it('handles empty string', () => {
      expect(safeSql('')).toBe("''");
    });

    it('handles strings with special characters', () => {
      expect(safeSql('hello\nworld')).toBe("'hello\nworld'");
      expect(safeSql('tab\there')).toBe("'tab\there'");
    });
  });

  describe('safeSqlNum', () => {
    it('returns string representation of integers', () => {
      expect(safeSqlNum(42)).toBe('42');
      expect(safeSqlNum(0)).toBe('0');
      expect(safeSqlNum(-10)).toBe('-10');
    });

    it('floors floating point numbers', () => {
      expect(safeSqlNum(3.7)).toBe('3');
      expect(safeSqlNum(3.2)).toBe('3');
      expect(safeSqlNum(-3.7)).toBe('-4'); // Math.floor behavior
    });

    it('returns NULL for undefined', () => {
      expect(safeSqlNum(undefined)).toBe('NULL');
    });

    it('returns NULL for null', () => {
      expect(safeSqlNum(null)).toBe('NULL');
    });

    it('returns NULL for NaN', () => {
      expect(safeSqlNum(NaN)).toBe('NULL');
    });

    it('returns NULL for Infinity', () => {
      expect(safeSqlNum(Infinity)).toBe('NULL');
      expect(safeSqlNum(-Infinity)).toBe('NULL');
    });

    it('returns NULL for strings', () => {
      expect(safeSqlNum('42')).toBe('NULL');
    });

    it('handles large numbers', () => {
      expect(safeSqlNum(1706799600000)).toBe('1706799600000');
    });
  });

  describe('toMs', () => {
    it('returns number as-is if finite', () => {
      expect(toMs(1706799600000)).toBe(1706799600000);
    });

    it('floors floating point numbers', () => {
      expect(toMs(1706799600000.7)).toBe(1706799600000);
    });

    it('parses ISO date strings', () => {
      const result = toMs('2024-02-01T12:00:00.000Z');
      expect(result).toBe(Date.parse('2024-02-01T12:00:00.000Z'));
    });

    it('parses numeric strings', () => {
      expect(toMs('1706799600000')).toBe(1706799600000);
    });

    it('returns fallback for undefined', () => {
      const fallback = 1234567890;
      expect(toMs(undefined, fallback)).toBe(fallback);
    });

    it('returns fallback for null', () => {
      const fallback = 1234567890;
      expect(toMs(null, fallback)).toBe(fallback);
    });

    it('returns fallback for invalid string', () => {
      const fallback = 1234567890;
      expect(toMs('not-a-date', fallback)).toBe(fallback);
    });

    it('uses Date.now() as default fallback', () => {
      const before = Date.now();
      const result = toMs(undefined);
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });
  });

  describe('expBackoffMs', () => {
    it('returns base for first attempt', () => {
      const result = expBackoffMs(1, 1000, 60000, 0);
      expect(result).toBe(1000);
    });

    it('doubles for each subsequent attempt', () => {
      expect(expBackoffMs(2, 1000, 60000, 0)).toBe(2000);
      expect(expBackoffMs(3, 1000, 60000, 0)).toBe(4000);
      expect(expBackoffMs(4, 1000, 60000, 0)).toBe(8000);
    });

    it('caps at max value', () => {
      expect(expBackoffMs(10, 1000, 5000, 0)).toBe(5000);
    });

    it('adds jitter within range', () => {
      // With jitter, result should be within [base - jitter, base + jitter]
      const base = 1000;
      const jitterRatio = 0.1; // 10% jitter

      for (let i = 0; i < 100; i++) {
        const result = expBackoffMs(1, base, 60000, jitterRatio);
        expect(result).toBeGreaterThanOrEqual(base * (1 - jitterRatio));
        expect(result).toBeLessThanOrEqual(base * (1 + jitterRatio));
      }
    });

    it('never returns negative values', () => {
      // Even with high jitter, should not go negative
      for (let i = 0; i < 100; i++) {
        const result = expBackoffMs(1, 100, 60000, 1.5);
        expect(result).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
