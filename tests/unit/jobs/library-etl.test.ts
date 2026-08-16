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
    library_delete_denylist: { legacy_release_id: 'legacy_release_id' },
    cronjob_runs: {},
    genre_artist_crossreference: {},
    artist_crossreference: {},
    artist_library_crossreference: {},
    compilation_track_artist: {},
    closeDatabaseConnection: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('drizzle-orm', () => {
  const sqlFn: jest.Mock & { raw?: jest.Mock; join?: jest.Mock } = jest.fn();
  sqlFn.raw = jest.fn((fragment: string) => ({ raw: fragment }));
  sqlFn.join = jest.fn((clauses: unknown[], separator: unknown) => ({ join: clauses, separator }));
  return {
    eq: jest.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    and: jest.fn((...args: unknown[]) => ({ and: args })),
    isNull: jest.fn((col: unknown) => ({ isNull: col })),
    inArray: jest.fn((col: unknown, values: unknown) => ({ inArray: [col, values] })),
    sql: sqlFn,
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { sql } from 'drizzle-orm';
import {
  parseTabRow,
  toNullableString,
  toNullableNumber,
  isDbOnlyGenre,
  normalizeArtistName,
  toAlphabeticalName,
  normalizeCodeLetters,
  parseFormatAndDiscs,
  toDateOrUndefined,
  toDateOnlyString,
  parseLegacyGenreRows,
  parseLegacyFormatRows,
  parseLegacyCompilationTrackRows,
  parseReleaseRows,
  buildArtistCacheKey,
  buildLegacySourcedSetMap,
  buildLegacySourcedSetWhere,
  buildAlbumCacheKey,
  ensureArtist,
  findArtistId,
  loadDeleteDenylist,
  isDeniedAtWriteTime,
  reconcileDenylistedInserts,
  reportStrandedResurrections,
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

    it('does match "various"', () => {
      const r = normalizeArtistName('various');
      expect(r.name).toBe('Various Artists');
      expect(r.isVarious).toBe(true);
    });

    it('does match "various artists"', () => {
      const r = normalizeArtistName('various artists');
      expect(r.name).toBe('Various Artists');
      expect(r.isVarious).toBe(true);
    });

    it('does match "various artists - rock - a"', () => {
      const r = normalizeArtistName('various artists - rock - a');
      expect(r.name).toBe('various artists - rock - a');
      expect(r.isVarious).toBe(false);
    });
  });

  describe('toAlphabeticalName', () => {
    it('uses legacy value when provided and non-empty', () => {
      expect(toAlphabeticalName('The Beatles', 'Beatles, The')).toBe('Beatles, The');
      expect(toAlphabeticalName('Some Artist', 'Artist, Some')).toBe('Artist, Some');
    });

    it('derives "The X" as "X, The" when no legacy', () => {
      expect(toAlphabeticalName('The Beatles', null)).toBe('Beatles, The');
      expect(toAlphabeticalName('The Beatles', '')).toBe('Beatles, The');
      expect(toAlphabeticalName('  The Rolling Stones  ', undefined)).toBe('Rolling Stones, The');
    });

    it('returns trimmed artist name when no "The" prefix and no legacy', () => {
      expect(toAlphabeticalName('Built to Spill', null)).toBe('Built to Spill');
      expect(toAlphabeticalName('  FKA twigs  ', '')).toBe('FKA twigs');
    });
  });

  describe('normalizeCodeLetters', () => {
    it('return chars uppercased', () => {
      expect(normalizeCodeLetters('ab')).toBe('AB');
      expect(normalizeCodeLetters('xyz')).toBe('XYZ');
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

  describe('parseLegacyGenreRows', () => {
    it('parses tab-delimited genre rows into names', () => {
      const raw = '1\tRock\n2\tJazz\n3\tElectronic';
      expect(parseLegacyGenreRows(raw)).toEqual(['Rock', 'Jazz', 'Electronic']);
    });

    it('filters out db_only (case insensitive)', () => {
      const raw = '1\tRock\n2\tdb_only\n3\tDB_ONLY\n4\tJazz';
      expect(parseLegacyGenreRows(raw)).toEqual(['Rock', 'Jazz']);
    });

    it('skips malformed rows', () => {
      const raw = '1\tRock\nmalformed\n3\tJazz';
      expect(parseLegacyGenreRows(raw)).toEqual(['Rock', 'Jazz']);
    });

    it('returns empty array for empty input', () => {
      expect(parseLegacyGenreRows('')).toEqual([]);
    });

    it('trims whitespace from genre names', () => {
      const raw = '1\t  Rock  \n2\t Jazz ';
      expect(parseLegacyGenreRows(raw)).toEqual(['Rock', 'Jazz']);
    });

    it('skips rows with empty genre name', () => {
      const raw = '1\tRock\n2\t\n3\t   \n4\tJazz';
      expect(parseLegacyGenreRows(raw)).toEqual(['Rock', 'Jazz']);
    });
  });

  describe('parseLegacyFormatRows', () => {
    it('normalizes raw format names to canonical set', () => {
      const raw = '1\tCD\n2\tVinyl 12"\n3\tCDR';
      expect(parseLegacyFormatRows(raw)).toEqual(expect.arrayContaining(['cd', 'vinyl 12"', 'cdr']));
    });

    it('deduplicates canonical names', () => {
      const raw = '1\tCD\n2\tCD x 2\n3\tCD box';
      const result = parseLegacyFormatRows(raw);
      expect(result.filter((f) => f === 'cd')).toHaveLength(1);
    });

    it('skips unsupported formats', () => {
      const raw = '1\tCD\n2\tcassette\n3\tdigital';
      expect(parseLegacyFormatRows(raw)).toEqual(['cd']);
    });

    it('returns empty array for empty input', () => {
      expect(parseLegacyFormatRows('')).toEqual([]);
    });

    it('skips malformed rows', () => {
      const raw = '1\tCD\nmalformed\n3\tVinyl';
      expect(parseLegacyFormatRows(raw)).toEqual(expect.arrayContaining(['cd', 'vinyl']));
    });
  });

  describe('buildArtistCacheKey', () => {
    it('normalizes to lowercase and trims', () => {
      expect(buildArtistCacheKey('  Autechre  ', ' AE ')).toBe('autechre|ae');
    });

    it('produces consistent keys for identical input', () => {
      const a = buildArtistCacheKey('Cat Power', 'CP');
      const b = buildArtistCacheKey('Cat Power', 'CP');
      expect(a).toBe(b);
    });

    it('produces different keys for different artists', () => {
      const a = buildArtistCacheKey('Stereolab', 'ST');
      const b = buildArtistCacheKey('Sessa', 'SE');
      expect(a).not.toBe(b);
    });
  });

  describe('buildAlbumCacheKey', () => {
    it('includes all components', () => {
      const key = buildAlbumCacheKey(42, 3, 'Moon Pix', 1);
      expect(key).toBe('42|3|moon pix|1');
    });

    it('normalizes title to lowercase and trims', () => {
      expect(buildAlbumCacheKey(1, 1, '  Confield  ', 5)).toBe('1|1|confield|5');
    });

    it('produces different keys for different code numbers', () => {
      const a = buildAlbumCacheKey(1, 1, 'Album', 1);
      const b = buildAlbumCacheKey(1, 1, 'Album', 2);
      expect(a).not.toBe(b);
    });
  });

  describe('parseLegacyCompilationTrackRows', () => {
    it('parses 4-column tab-delimited rows', () => {
      const raw = '100\tKoo Nimo\tAsonkoa\tA1\n100\tObo Addy\tWawshishijay\tA2';
      const result = parseLegacyCompilationTrackRows(raw);
      expect(result).toEqual([
        { libraryReleaseId: 100, artistName: 'Koo Nimo', trackTitle: 'Asonkoa', trackPosition: 'A1' },
        { libraryReleaseId: 100, artistName: 'Obo Addy', trackTitle: 'Wawshishijay', trackPosition: 'A2' },
      ]);
    });

    it('handles empty track title and position (multi-row)', () => {
      // When empty columns are at end of a non-final line, they're preserved by split('\n')
      const raw = '200\tAutechre\t\t\n200\tStereolab\tMetronomic Underground\tA1';
      const result = parseLegacyCompilationTrackRows(raw);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        libraryReleaseId: 200,
        artistName: 'Autechre',
        trackTitle: null,
        trackPosition: null,
      });
      expect(result[1]).toEqual({
        libraryReleaseId: 200,
        artistName: 'Stereolab',
        trackTitle: 'Metronomic Underground',
        trackPosition: 'A1',
      });
    });

    it('skips rows with empty artist name', () => {
      const raw = '100\t\tTrack\tA1\n100\tArtist\tTrack\tA2';
      const result = parseLegacyCompilationTrackRows(raw);
      expect(result).toHaveLength(1);
      expect(result[0].artistName).toBe('Artist');
    });

    it('skips malformed rows', () => {
      const raw = '100\tArtist\tTrack\tA1\nmalformed\n200\tArtist2\tTrack2\tB1';
      const result = parseLegacyCompilationTrackRows(raw);
      expect(result).toHaveLength(2);
    });

    it('returns empty array for empty input', () => {
      expect(parseLegacyCompilationTrackRows('')).toEqual([]);
    });
  });

  describe('parseReleaseRows', () => {
    // Base 13 columns shared across all row widths
    const base13 = [
      '1001', // ID
      'Confield', // TITLE
      '1700000000', // TIME_LAST_MODIFIED
      '1600000000', // TIME_CREATED
      '42', // CALL_NUMBERS
      'AE', // CALL_LETTERS
      '', // ALTERNATE_ARTIST_NAME
      'Autechre', // PRESENTATION_NAME
      'Autechre', // ALPHABETICAL_NAME
      'AE', // artist CALL_LETTERS
      '1', // artist CALL_NUMBERS
      'Electronic', // GENRE REFERENCE_NAME
      'CD', // FORMAT REFERENCE_NAME
    ];

    it('parses a 17-column row with on_streaming=true', () => {
      const row = [...base13, '0', '0', 'Autechre', '1'].join('\t');
      const result = parseReleaseRows(row, 17);
      expect(result).toHaveLength(1);
      expect(result[0].release_on_streaming).toBe(true);
      expect(result[0].release_album_artist).toBe('Autechre');
    });

    it('parses a 17-column row with on_streaming=false', () => {
      const row = [...base13, '0', '0', '', '0'].join('\t');
      const result = parseReleaseRows(row, 17);
      expect(result).toHaveLength(1);
      expect(result[0].release_on_streaming).toBe(false);
    });

    it('parses a 17-column row with on_streaming=null for MySQL NULL literal', () => {
      const row = [...base13, '0', '0', 'Autechre', 'NULL'].join('\t');
      const result = parseReleaseRows(row, 17);
      expect(result).toHaveLength(1);
      expect(result[0].release_on_streaming).toBeNull();
    });

    it('parses a 17-column row with on_streaming=null for empty value', () => {
      // Use two rows so raw.trim() does not strip trailing tabs from the first row
      const row1 = [...base13, '0', '0', '', ''].join('\t');
      const row2 = [...base13, '0', '0', 'Autechre', '1'].join('\t');
      const result = parseReleaseRows([row1, row2].join('\n'), 17);
      expect(result).toHaveLength(2);
      expect(result[0].release_on_streaming).toBeNull();
    });

    it('parses a 16-column row with release_on_streaming=null (backward compat)', () => {
      const row = [...base13, '0', '0', 'Autechre'].join('\t');
      const result = parseReleaseRows(row, 16);
      expect(result).toHaveLength(1);
      expect(result[0].release_on_streaming).toBeNull();
      expect(result[0].release_album_artist).toBe('Autechre');
    });

    it('parses a 15-column row with release_on_streaming=null', () => {
      const row = [...base13, '0', '0'].join('\t');
      const result = parseReleaseRows(row, 15);
      expect(result).toHaveLength(1);
      expect(result[0].release_on_streaming).toBeNull();
      expect(result[0].release_album_artist).toBeNull();
    });

    it('parses a 13-column row with release_on_streaming=null', () => {
      const row = base13.join('\t');
      const result = parseReleaseRows(row, 13);
      expect(result).toHaveLength(1);
      expect(result[0].release_on_streaming).toBeNull();
      expect(result[0].release_album_artist).toBeNull();
      expect(result[0].date_lost).toBeNull();
      expect(result[0].date_found).toBeNull();
    });

    it('parses multiple 17-column rows with mixed on_streaming values', () => {
      // Empty-column row is not last to avoid raw.trim() stripping trailing tabs
      const rows = [
        [...base13, '0', '0', 'Autechre', '1'].join('\t'),
        [...base13, '0', '0', '', ''].join('\t'),
        [...base13, '0', '0', '', '0'].join('\t'),
      ].join('\n');
      const result = parseReleaseRows(rows, 17);
      expect(result).toHaveLength(3);
      expect(result[0].release_on_streaming).toBe(true);
      expect(result[1].release_on_streaming).toBeNull();
      expect(result[2].release_on_streaming).toBe(false);
    });

    it('returns empty array for empty input', () => {
      expect(parseReleaseRows('', 17)).toEqual([]);
    });
  });

  // The SET map keys are the contract for what the legacy_release_id ON CONFLICT
  // path is allowed to overwrite. Pinning the keys prevents accidental drift —
  // e.g. somebody adds artwork_url or canonical_entity_id to the upsert and
  // clobbers LML-resolved data on every legacy edit. Acceptance criterion from
  // #752: "the SET list updates only the columns the ETL is the source of
  // truth for (don't clobber human-curated fields)."
  describe('buildLegacySourcedSetMap', () => {
    const expectedKeys = [
      'artist_id',
      'artist_name',
      'genre_id',
      'format_id',
      'alternate_artist_name',
      'album_artist',
      'album_title',
      'code_number',
      'code_volume_letters',
      'disc_quantity',
      'add_date',
      'last_modified',
      'date_lost',
      'date_found',
      'on_streaming',
    ].sort();

    it('includes every legacy-sourced library column', () => {
      const map = buildLegacySourcedSetMap();
      expect(Object.keys(map).sort()).toEqual(expectedKeys);
    });

    it('excludes the conflict key itself and all PG-only / LML-resolved columns', () => {
      const map = buildLegacySourcedSetMap();
      // legacy_release_id is the conflict key — there's no point updating it
      // to itself, and including it would shadow the partial-index uniqueness
      // semantics in confusing ways.
      expect(map).not.toHaveProperty('legacy_release_id');
      // DB-managed surrogate / counters.
      expect(map).not.toHaveProperty('id');
      expect(map).not.toHaveProperty('plays');
      // Human-curated / staff-assigned (label resolution is a separate path).
      expect(map).not.toHaveProperty('label');
      expect(map).not.toHaveProperty('label_id');
      // LML-resolved (Epic B). The library-etl run must not stomp these on a
      // legacy edit, since LML's resolution is independent of the legacy tuple.
      expect(map).not.toHaveProperty('artwork_url');
      expect(map).not.toHaveProperty('canonical_entity_id');
      expect(map).not.toHaveProperty('canonical_entity_confidence');
      expect(map).not.toHaveProperty('canonical_entity_resolved_at');
      // Generated column.
      expect(map).not.toHaveProperty('search_doc');
    });

    it('produces excluded.<column> SQL fragments for each key', () => {
      const map = buildLegacySourcedSetMap();
      // The mocked sql.raw returns { raw: <fragment> }, so we can read the
      // fragment back out and assert it references the matching excluded
      // column. This guards against e.g. all keys mapping to the same fragment
      // by mistake (a refactor accidentally reusing one variable).
      for (const key of expectedKeys) {
        const fragment = (map as Record<string, { raw?: string }>)[key];
        expect(fragment.raw).toBe(`excluded."${key}"`);
      }
    });
  });

  describe('buildLegacySourcedSetWhere', () => {
    const expectedKeys = [
      'artist_id',
      'artist_name',
      'genre_id',
      'format_id',
      'alternate_artist_name',
      'album_artist',
      'album_title',
      'code_number',
      'code_volume_letters',
      'disc_quantity',
      'add_date',
      'last_modified',
      'date_lost',
      'date_found',
      'on_streaming',
    ];

    it('emits one IS DISTINCT FROM clause per legacy-sourced column joined by OR', () => {
      // Mocked sql.join returns { join: clauses, separator: { raw: ' OR ' } }
      // so we can read the per-column fragments back out and assert each one
      // references the matching column on both sides.
      const where = buildLegacySourcedSetWhere() as unknown as {
        join: Array<{ raw: string }>;
        separator: { raw: string };
      };
      expect(where.separator.raw).toBe(' OR ');
      expect(where.join).toHaveLength(expectedKeys.length);
      const fragments = where.join.map((c) => c.raw);
      for (const key of expectedKeys) {
        expect(fragments).toContain(`"library"."${key}" IS DISTINCT FROM excluded."${key}"`);
      }
    });

    it('matches the SET map keys exactly (no SET-vs-WHERE drift)', () => {
      const setKeys = Object.keys(buildLegacySourcedSetMap()).sort();
      const where = buildLegacySourcedSetWhere() as unknown as { join: Array<{ raw: string }> };
      const whereKeys = where.join
        .map((c) => c.raw.match(/^"library"\."([^"]+)"/)?.[1])
        .filter((k): k is string => Boolean(k))
        .sort();
      expect(whereKeys).toEqual(setKeys);
    });
  });

  // BS#1095: `ensureArtist` + `findArtistId` matched existing `artists` rows
  // via `lower(artist_name) = lower($name)`, which is collation-aware but not
  // Unicode-form aware — 'Nilüfer Yanya' in NFC ('ü' = U+00FC) vs NFD ('u' +
  // U+0308) is byte-distinct and misses, so the ETL inserted a duplicate row
  // per composition form. The fix swaps both predicates to
  // `fold_artist_name(artist_name) = fold_artist_name($name)` (migration
  // 0134), mirroring the BS#1897 runtime-path fix in
  // `apps/backend/services/library.service.ts` `artistIdFromName`. These are
  // structural regression guards over the fully-mocked `sql` tag (the actual
  // NFC/NFD collapse behavior is PG-side and is pinned by an integration spec
  // against real Postgres — the mocked DB here can't execute `fold_artist_name`
  // itself).
  describe('ensureArtist / findArtistId Unicode-form fold match (BS#1095)', () => {
    // 'ü' precomposed (U+00FC) vs decomposed ('u' + combining diaeresis
    // U+0308) — same visual name, byte-distinct strings, mixed case so a
    // regression to `.toLowerCase()` pre-processing would also be caught.
    const NILUFER_NFC = 'Nilüfer Yanya'.normalize('NFC');
    const NILUFER_NFD = NILUFER_NFC.normalize('NFD');

    const sqlMock = sql as unknown as jest.Mock;

    /**
     * Find `sql` tagged-template calls shaped like
     * `sql\`${FOLD_FN}(${artists.artist_name}) = ${FOLD_FN}(${name})\`` —
     * i.e. the 2nd and 4th interpolated values are equal (the same
     * schema-qualified `fold_artist_name` SQL-function reference used on both
     * sides) and the 4th is the exact, untouched `name` argument.
     */
    const findFoldNameCalls = (name: string) =>
      sqlMock.mock.calls.filter(
        (args) =>
          args[4] === name &&
          args[1] != null &&
          typeof args[1] === 'object' &&
          'raw' in (args[1] as object) &&
          args[1] === args[3]
      );

    const makeSelectOnlyDbClient = (existingRows: Array<{ id: number; artist_name: string }>) => {
      const limitMock = jest.fn().mockResolvedValue(existingRows);
      const whereMock = jest.fn(() => ({ limit: limitMock }));
      const innerJoinMock = jest.fn(() => ({ where: whereMock }));
      const fromMock = jest.fn(() => ({ where: whereMock, innerJoin: innerJoinMock }));
      const selectMock = jest.fn(() => ({ from: fromMock }));
      return { select: selectMock } as any;
    };

    it('ensureArtist (various-artist branch) compares fold_artist_name(column) = fold_artist_name(name), not a pre-lowered value, for both NFC and NFD spellings', async () => {
      const dbClientNfc = makeSelectOnlyDbClient([{ id: 42, artist_name: NILUFER_NFC }]);
      const resultNfc = await ensureArtist(dbClientNfc, NILUFER_NFC, NILUFER_NFC, true, 1, 'NY', 0, new Map());
      expect(resultNfc.id).toBe(42);

      const dbClientNfd = makeSelectOnlyDbClient([{ id: 42, artist_name: NILUFER_NFC }]);
      const resultNfd = await ensureArtist(dbClientNfd, NILUFER_NFD, NILUFER_NFD, true, 1, 'NY', 0, new Map());
      expect(resultNfd.id).toBe(42);

      const nfcCalls = findFoldNameCalls(NILUFER_NFC);
      const nfdCalls = findFoldNameCalls(NILUFER_NFD);
      expect(nfcCalls.length).toBeGreaterThan(0);
      expect(nfdCalls.length).toBeGreaterThan(0);
      expect((nfcCalls[0][1] as { raw: string }).raw).toContain('fold_artist_name');
      // Same fold-function reference used for both the NFC and NFD lookups —
      // the DB-side function is what collapses the two forms, not app code.
      expect(nfcCalls[0][1]).toBe(nfdCalls[0][1]);
    });

    it('ensureArtist (genre-scoped branch) compares fold_artist_name(column) = fold_artist_name(name)', async () => {
      const dbClient = makeSelectOnlyDbClient([{ id: 7, artist_name: NILUFER_NFC }]);
      const result = await ensureArtist(dbClient, NILUFER_NFD, NILUFER_NFD, false, 11, 'NY', 3, new Map());
      expect(result.id).toBe(7);

      const calls = findFoldNameCalls(NILUFER_NFD);
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0][1] as { raw: string }).raw).toContain('fold_artist_name');
    });

    it('findArtistId compares fold_artist_name(column) = fold_artist_name(name) for both NFC and NFD spellings', async () => {
      const dbClientNfc = makeSelectOnlyDbClient([{ id: 99 }]);
      const idNfc = await findArtistId(dbClientNfc, NILUFER_NFC, 'NY', new Map());
      expect(idNfc).toBe(99);

      const dbClientNfd = makeSelectOnlyDbClient([{ id: 99 }]);
      const idNfd = await findArtistId(dbClientNfd, NILUFER_NFD, 'NY', new Map());
      expect(idNfd).toBe(99);

      const nfcCalls = findFoldNameCalls(NILUFER_NFC);
      const nfdCalls = findFoldNameCalls(NILUFER_NFD);
      expect(nfcCalls.length).toBeGreaterThan(0);
      expect(nfdCalls.length).toBeGreaterThan(0);
      expect((nfcCalls[0][1] as { raw: string }).raw).toContain('fold_artist_name');
      expect(nfcCalls[0][1]).toBe(nfdCalls[0][1]);
    });

    it('leaves the code_letters comparison on lower() (not folded)', async () => {
      const dbClient = makeSelectOnlyDbClient([{ id: 5 }]);
      await findArtistId(dbClient, NILUFER_NFC, 'NY', new Map());

      // The code_letters predicate is a plain `sql` call carrying a bare
      // lowercased string value, not a { raw } fold-function reference.
      const codeLettersCalls = sqlMock.mock.calls.filter((args) => args.includes('ny'));
      expect(codeLettersCalls.length).toBeGreaterThan(0);
    });
  });
});

/**
 * Delete-denylist consumption (BS#2112).
 *
 * A Backend-side `DELETE /library/:id` does not reach tubafrenzy, so the
 * upstream `LIBRARY_RELEASE` row survives. This job is still cron-registered
 * every 30 minutes, so without the denylist its delta pass re-selects that
 * row, finds no `library` row carrying its `legacy_release_id`, and takes the
 * INSERT branch of `ON CONFLICT (legacy_release_id) DO UPDATE` — resurrecting
 * the release under a new `library.id` stripped of every cascade-destroyed
 * dependent. This job is the denylist's only consumer.
 */
describe('library-etl delete denylist (BS#2112)', () => {
  const makeDenylistTx = (rows: { legacy_release_id: number }[]) => {
    const where = jest.fn();
    const from = jest.fn().mockReturnValue({
      where,
      then: (resolve: (value: unknown) => void) => resolve(rows),
    });
    const select = jest.fn().mockReturnValue({ from });
    return { tx: { select } as never, select, from, where };
  };

  it('returns every denylisted legacy_release_id as a set', async () => {
    const { tx } = makeDenylistTx([{ legacy_release_id: 101 }, { legacy_release_id: 202 }]);

    const denylist = await loadDeleteDenylist(tx);

    expect(denylist).toBeInstanceOf(Set);
    expect(denylist.has(101)).toBe(true);
    expect(denylist.has(202)).toBe(true);
    expect(denylist.has(303)).toBe(false);
    expect(denylist.size).toBe(2);
  });

  it('returns an empty set when nothing has been deleted', async () => {
    const { tx } = makeDenylistTx([]);

    expect((await loadDeleteDenylist(tx)).size).toBe(0);
  });

  /**
   * The load must stay UNFILTERED. The documented full-re-sync recipe
   * (`DELETE FROM cronjob_runs WHERE job_name = 'library-etl'`) drops this
   * job's own `TIME_LAST_MODIFIED >` delta filter and re-selects the entire
   * upstream catalog in one pass — so a denylist that were itself windowed by
   * `last_run`, or by a recency bound on `deleted_at`, would let that single
   * run resurrect every release ever deleted.
   */
  it('applies no predicate, so the denylist still holds on a full re-sync', async () => {
    const { tx, where } = makeDenylistTx([{ legacy_release_id: 101 }]);

    await loadDeleteDenylist(tx);

    expect(where).not.toHaveBeenCalled();
  });

  /**
   * Ordering matters as much as the check itself: `findExistingRelease` can
   * back-stamp a deleted release's `legacy_release_id` onto a different
   * `library` row via the canonical-tuple match, so the denylist has to be
   * consulted before it, not merely before the INSERT.
   */
  it('consults the denylist before any other per-release work', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const jobSource = fs.readFileSync(path.resolve(__dirname, '../../../jobs/library-etl/job.ts'), 'utf-8');

    const loopStart = jobSource.indexOf('for (const release of legacyReleases)');
    expect(loopStart).toBeGreaterThan(-1);

    const denylistCheck = jobSource.indexOf('deleteDenylist.has(release.release_id)', loopStart);
    const existingLookup = jobSource.indexOf('findExistingRelease(', loopStart);
    const upsert = jobSource.indexOf('onConflictDoUpdate', loopStart);

    expect(denylistCheck).toBeGreaterThan(loopStart);
    expect(denylistCheck).toBeLessThan(existingLookup);
    expect(denylistCheck).toBeLessThan(upsert);
  });
});

/**
 * The denylist TOCTOU (BS#2112 review finding 2), and the two checks that
 * close it.
 *
 * `loadDeleteDenylist` snapshots the whole table ONCE at the top of a
 * transaction that then runs for the length of the import. `db.transaction()`
 * is READ COMMITTED, so that Set is frozen at its statement's snapshot while
 * every later statement takes a fresh one: a delete committing after the load
 * but before the loop reaches that release is invisible to the Set,
 * `findExistingRelease` then sees the deleted row gone, and the INSERT branch
 * resurrects the release under a new `library.id` stripped of its cascaded
 * dependents.
 *
 * What made that terminal rather than transient is that it hides itself —
 * every LATER run consults the denylist, finds the id, and `continue`s, so the
 * resurrected row is never updated and never removed while the log cheerfully
 * reports "skipped as deleted".
 */
describe('library-etl denylist race (BS#2112 review finding 2)', () => {
  /** Tx double whose denylist reads can CHANGE between statements, which is the whole point. */
  const makeRaceTx = () => {
    const denylisted = new Set<number>();
    const deletedIds: number[][] = [];
    let libraryJoinRows: Array<{ id: number; legacy_release_id: number }> = [];

    const tx = {
      select: () => {
        const chain: Record<string, unknown> = {};
        let scope: 'denylist' | 'join' = 'denylist';
        let filterId: number | null = null;
        chain.from = () => chain;
        chain.innerJoin = () => {
          scope = 'join';
          return chain;
        };
        // The @wxyc/database test double renders drizzle conditions as plain
        // objects: `eq(col, v)` becomes `{ eq: [col, v] }`.
        chain.where = (predicate: unknown) => {
          filterId = (predicate as { eq?: [string, number] } | null)?.eq?.[1] ?? null;
          return chain;
        };
        chain.limit = () => chain;
        chain.then = (resolve: (value: unknown) => void) => {
          if (scope === 'join') {
            resolve(libraryJoinRows.filter((row) => denylisted.has(row.legacy_release_id)));
            return;
          }
          const rows = [...denylisted].map((legacy_release_id) => ({ legacy_release_id }));
          resolve(filterId == null ? rows : rows.filter((row) => row.legacy_release_id === filterId));
        };
        return chain;
      },
      delete: () => ({
        // `inArray(col, ids)` renders as `{ inArray: [col, ids] }`.
        where: (predicate: unknown) => {
          deletedIds.push((predicate as { inArray?: [string, number[]] } | null)?.inArray?.[1] ?? []);
          return Promise.resolve([]);
        },
      }),
    };

    return {
      tx: tx as never,
      denylisted,
      deletedIds,
      setLibraryJoinRows: (rows: Array<{ id: number; legacy_release_id: number }>) => {
        libraryJoinRows = rows;
      },
    };
  };

  describe('isDeniedAtWriteTime', () => {
    it('sees a delete that committed AFTER the run-start snapshot was taken', async () => {
      const { tx, denylisted } = makeRaceTx();

      // Run start: the release is importable, so the in-memory pre-filter
      // built here will let it straight through for the rest of the run.
      const runStartSnapshot = await loadDeleteDenylist(tx);
      expect(runStartSnapshot.has(4242)).toBe(false);

      // Mid-run: a librarian hard-deletes it. The Set above cannot know.
      denylisted.add(4242);
      expect(runStartSnapshot.has(4242)).toBe(false);

      // The write-time re-check takes a fresh snapshot and does.
      await expect(isDeniedAtWriteTime(tx, 4242)).resolves.toBe(true);
    });

    it('lets a release that was never deleted through', async () => {
      const { tx, denylisted } = makeRaceTx();
      denylisted.add(999);

      await expect(isDeniedAtWriteTime(tx, 4242)).resolves.toBe(false);
    });
  });

  /**
   * The re-check narrows the window to a single statement but does not erase
   * it — a delete can still commit between the re-check and the upsert. The
   * reconcile pass is what makes the run's outcome correct regardless.
   */
  describe('reconcileDenylistedInserts', () => {
    it('undoes a resurrection this run inserted', async () => {
      const { tx, denylisted, deletedIds, setLibraryJoinRows } = makeRaceTx();
      denylisted.add(4242);
      setLibraryJoinRows([{ id: 77, legacy_release_id: 4242 }]);

      const result = await reconcileDenylistedInserts(tx, new Set([4242]));

      expect(result.removed).toEqual([77]);
      expect(result.stranded).toEqual([]);
      expect(deletedIds).toEqual([[77]]);
    });

    /**
     * A row that predates this run may have accrued dependents (enrichment
     * writes `album_metadata`; an MD may have binned it), and an ETL silently
     * deleting catalog rows it did not create is a worse failure than the one
     * it is reporting. Report, never repair.
     */
    it('reports but does NOT delete a resurrection it did not create', async () => {
      const { tx, denylisted, deletedIds, setLibraryJoinRows } = makeRaceTx();
      denylisted.add(4242);
      setLibraryJoinRows([{ id: 77, legacy_release_id: 4242 }]);

      const result = await reconcileDenylistedInserts(tx, new Set<number>());

      expect(result.removed).toEqual([]);
      expect(result.stranded).toEqual([{ id: 77, legacy_release_id: 4242 }]);
      expect(deletedIds).toEqual([]);
    });

    it('is a no-op when no denylisted release is present in the catalog', async () => {
      const { tx, denylisted, deletedIds, setLibraryJoinRows } = makeRaceTx();
      denylisted.add(4242);
      setLibraryJoinRows([]);

      const result = await reconcileDenylistedInserts(tx, new Set([4242]));

      expect(result).toEqual({ removed: [], stranded: [] });
      expect(deletedIds).toEqual([]);
    });
  });

  describe('reportStrandedResurrections', () => {
    afterEach(() => {
      process.exitCode = undefined;
    });

    it('fails the run so the state cannot conceal itself', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      reportStrandedResurrections([{ id: 77, legacy_release_id: 4242 }]);

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('legacy_release_id=4242'));
      error.mockRestore();
    });

    it('says nothing and leaves the exit code alone when there is nothing to report', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      reportStrandedResurrections([]);

      expect(process.exitCode).toBeUndefined();
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });

  /**
   * Ordering: the write-time re-check must precede `findExistingRelease`, not
   * merely the INSERT. That call's canonical-tuple match can back-stamp a
   * deleted release's `legacy_release_id` onto a DIFFERENT library row — a
   * resurrection by a second door.
   */
  it('re-checks at write time ahead of findExistingRelease, and reconciles after the loop', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const jobSource = fs.readFileSync(path.resolve(__dirname, '../../../jobs/library-etl/job.ts'), 'utf-8');

    const loopStart = jobSource.indexOf('for (const release of legacyReleases)');
    const writeTimeCheck = jobSource.indexOf('isDeniedAtWriteTime(tx, release.release_id)', loopStart);
    const existingLookup = jobSource.indexOf('findExistingRelease(', loopStart);
    const reconcile = jobSource.indexOf('reconcileDenylistedInserts(tx, insertedLegacyIds)', loopStart);
    const crossrefImport = jobSource.indexOf('importArtistCrossRefs(', loopStart);

    expect(writeTimeCheck).toBeGreaterThan(loopStart);
    expect(writeTimeCheck).toBeLessThan(existingLookup);
    // After the loop that can create a resurrection, and before anything can
    // reference the row it undoes.
    expect(reconcile).toBeGreaterThan(existingLookup);
    expect(reconcile).toBeLessThan(crossrefImport);
  });

  /**
   * An idle delta pass is the COMMON case, so a sweep that only ran when there
   * was work would leave detection dependent on the next run that happened to
   * have some — for a state whose defining property is that it hides.
   */
  it('sweeps on idle runs too', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const jobSource = fs.readFileSync(path.resolve(__dirname, '../../../jobs/library-etl/job.ts'), 'utf-8');

    const idleBranch = jobSource.indexOf('No new legacy releases found');
    const returnAfter = jobSource.indexOf('return;', idleBranch);
    const idleSweep = jobSource.indexOf('reconcileDenylistedInserts', idleBranch);

    expect(idleSweep).toBeGreaterThan(idleBranch);
    expect(idleSweep).toBeLessThan(returnAfter);
  });
});
