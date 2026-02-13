/**
 * Unit tests for library-etl job helpers
 *
 * Tests the pure parsing and normalization functions used by the ETL.
 * Database and legacy MirrorSQL are mocked so the job module can load.
 */

const mockSend = jest.fn().mockResolvedValue('');
const mockClose = jest.fn();

jest.mock('@wxyc/database', () => {
  const chainResolve = (value: unknown = []) => ({
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(value),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
    returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  });
  const dbChain = chainResolve([]);
  return {
    db: {
      ...dbChain,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: jest.fn().mockReturnValue({ from: jest.fn().mockResolvedValue([]) }),
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({
              onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
              returning: jest.fn().mockResolvedValue([{ id: 1 }]),
            }),
          }),
        };
        return cb(tx);
      }),
    },
    MirrorSQL: {
      instance: () => ({ send: mockSend, close: mockClose }),
    },
    artists: {},
    genres: {},
    format: {},
    library: {},
    cronjob_runs: {},
    genre_artist_crossreference: {},
    closeDatabaseConnection: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: jest.fn((...args: unknown[]) => ({ and: args })),
  isNull: jest.fn((col: unknown) => ({ isNull: col })),
}));

import {
  parseTabRow,
  toNullableString,
  toNullableNumber,
  isDbOnlyGenre,
  normalizeArtistName,
  normalizeCodeLetters,
  parseFormatAndDiscs,
  toDateOrUndefined,
  toDateOnlyString,
} from '../../../jobs/library-etl/job';

describe('library-etl job helpers', () => {
  describe('parseTabRow', () => {
    it('returns array when column count matches', () => {
      expect(parseTabRow('a\tb\tc', 3)).toEqual(['a', 'b', 'c']);
      expect(parseTabRow('one', 1)).toEqual(['one']);
    });

    it('returns null when column count does not match', () => {
      expect(parseTabRow('a\tb', 3)).toBeNull();
      expect(parseTabRow('a\tb\tc', 2)).toBeNull();
      expect(parseTabRow('', 2)).toBeNull(); // '' split gives [''], length 1
    });
  });

  describe('toNullableString', () => {
    it('returns trimmed non-empty string', () => {
      expect(toNullableString('  hello  ')).toBe('hello');
      expect(toNullableString('x')).toBe('x');
    });

    it('returns null for empty or whitespace', () => {
      expect(toNullableString('')).toBeNull();
      expect(toNullableString('   ')).toBeNull();
      expect(toNullableString('\t')).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(toNullableString(undefined)).toBeNull();
    });
  });

  describe('toNullableNumber', () => {
    it('parses valid numeric strings', () => {
      expect(toNullableNumber('42')).toBe(42);
      expect(toNullableNumber('0')).toBe(0);
      expect(toNullableNumber('  -5  ')).toBe(-5);
    });

    it('returns null for empty or invalid', () => {
      expect(toNullableNumber('')).toBeNull();
      expect(toNullableNumber('   ')).toBeNull();
      expect(toNullableNumber('abc')).toBeNull();
      expect(toNullableNumber(undefined)).toBeNull();
    });

    it('returns null for non-finite parse result', () => {
      expect(toNullableNumber('NaN')).toBeNull();
      expect(toNullableNumber('Infinity')).toBeNull();
    });
  });

  describe('isDbOnlyGenre', () => {
    it('returns true for db_only (case insensitive)', () => {
      expect(isDbOnlyGenre('db_only')).toBe(true);
      expect(isDbOnlyGenre('DB_ONLY')).toBe(true);
      expect(isDbOnlyGenre('  Db_Only  ')).toBe(true);
    });

    it('returns false for other values', () => {
      expect(isDbOnlyGenre('rock')).toBe(false);
      expect(isDbOnlyGenre('')).toBe(false);
      expect(isDbOnlyGenre(null)).toBe(false);
      expect(isDbOnlyGenre(undefined)).toBe(false);
    });
  });

  describe('normalizeArtistName', () => {
    it('normalizes "Various Artists - ..." to Various Artists', () => {
      const r = normalizeArtistName('Various Artists - latin');
      expect(r.name).toBe('Various Artists');
      expect(r.isVarious).toBe(true);
    });

    it('is case insensitive for various artists prefix', () => {
      const r = normalizeArtistName('  VARIOUS ARTISTS - Something  ');
      expect(r.name).toBe('Various Artists');
      expect(r.isVarious).toBe(true);
    });

    it('returns trimmed name and isVarious false for regular artists', () => {
      const r = normalizeArtistName('  FKA twigs  ');
      expect(r.name).toBe('FKA twigs');
      expect(r.isVarious).toBe(false);
    });

    it('does not match without hyphen after "Various Artists"', () => {
      const r = normalizeArtistName('Various Artists');
      expect(r.name).toBe('Various Artists');
      expect(r.isVarious).toBe(false);
    });
  });

  describe('normalizeCodeLetters', () => {
    it('returns first two chars uppercased', () => {
      expect(normalizeCodeLetters('ab')).toBe('AB');
      expect(normalizeCodeLetters('xyz')).toBe('XY');
    });

    it('returns null for empty or null', () => {
      expect(normalizeCodeLetters(null)).toBeNull();
      expect(normalizeCodeLetters('')).toBeNull();
      expect(normalizeCodeLetters('   ')).toBeNull();
    });

    it('trims then takes first two', () => {
      expect(normalizeCodeLetters('  xy  ')).toBe('XY');
    });
  });

  describe('parseFormatAndDiscs', () => {
    describe('CD', () => {
      it('parses "cd" as cd, 1 disc', () => {
        expect(parseFormatAndDiscs('cd')).toEqual({ formatName: 'cd', discQuantity: 1 });
        expect(parseFormatAndDiscs('CD')).toEqual({ formatName: 'cd', discQuantity: 1 });
      });

      it('parses "cd x 2" as cd, 2 discs', () => {
        expect(parseFormatAndDiscs('cd x 2')).toEqual({ formatName: 'cd', discQuantity: 2 });
      });

      it('parses "cd box" as cd, 1 disc', () => {
        expect(parseFormatAndDiscs('cd box')).toEqual({ formatName: 'cd', discQuantity: 1 });
      });
    });

    describe('CD-R', () => {
      it('parses "cdr" as cdr, 1 disc', () => {
        expect(parseFormatAndDiscs('cdr')).toEqual({ formatName: 'cdr', discQuantity: 1 });
      });
    });

    describe('vinyl', () => {
      it('parses "vinyl" as vinyl (no size), 1 disc', () => {
        expect(parseFormatAndDiscs('vinyl')).toEqual({ formatName: 'vinyl', discQuantity: 1 });
      });

      it('parses 7" as vinyl 7"', () => {
        expect(parseFormatAndDiscs('vinyl 7"')).toEqual({ formatName: 'vinyl 7"', discQuantity: 1 });
      });

      it('parses 10" as vinyl 10"', () => {
        expect(parseFormatAndDiscs('vinyl 10"')).toEqual({ formatName: 'vinyl 10"', discQuantity: 1 });
      });

      it('parses 12" or lp as vinyl 12"', () => {
        expect(parseFormatAndDiscs('vinyl 12"')).toEqual({ formatName: 'vinyl 12"', discQuantity: 1 });
        expect(parseFormatAndDiscs('vinyl lp')).toEqual({ formatName: 'vinyl 12"', discQuantity: 1 });
      });

      it('parses vinyl x 2 as 2 discs', () => {
        expect(parseFormatAndDiscs('vinyl x 2')).toEqual({ formatName: 'vinyl', discQuantity: 2 });
      });

      it('parses vinyl 12" x 2 as 2 discs', () => {
        expect(parseFormatAndDiscs('vinyl 12" x 2')).toEqual({ formatName: 'vinyl 12"', discQuantity: 2 });
      });
    });

    it('returns null for unsupported format', () => {
      expect(parseFormatAndDiscs('cassette')).toBeNull();
      expect(parseFormatAndDiscs('digital')).toBeNull();
      expect(parseFormatAndDiscs('')).toBeNull();
    });
  });

  describe('toDateOrUndefined', () => {
    it('returns Date for valid timestamp', () => {
      const ts = new Date('2024-02-01').getTime();
      const d = toDateOrUndefined(ts);
      expect(d).toBeInstanceOf(Date);
      expect(d?.getTime()).toBe(ts);
    });

    it('returns undefined for null', () => {
      expect(toDateOrUndefined(null)).toBeUndefined();
    });

    it('returns undefined for invalid timestamp', () => {
      expect(toDateOrUndefined(Number.NaN)).toBeUndefined();
    });
  });

  describe('toDateOnlyString', () => {
    it('returns YYYY-MM-DD for valid timestamp', () => {
      const ts = new Date('2024-02-01T15:30:00Z').getTime();
      expect(toDateOnlyString(ts)).toBe('2024-02-01');
    });

    it('returns undefined for null', () => {
      expect(toDateOnlyString(null)).toBeUndefined();
    });

    it('returns undefined for invalid timestamp', () => {
      expect(toDateOnlyString(Number.NaN)).toBeUndefined();
    });
  });
});
