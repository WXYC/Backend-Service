/**
 * Unit tests for flowsheet ETL fetch-legacy parsing functions.
 *
 * Tests the tab-separated row parsing for entries and shows, including
 * the TIME_LAST_MODIFIED column used for update detection.
 */

jest.mock('@wxyc/database', () => ({
  MirrorSQL: {
    instance: jest.fn().mockReturnValue({
      send: jest.fn(),
      close: jest.fn(),
    }),
  },
}));

import { parseTabRow, toNullable, parseEntryRows, parseShowRows } from '../../../../jobs/flowsheet-etl/fetch-legacy';

describe('fetch-legacy parsing', () => {
  describe('parseTabRow', () => {
    it('returns columns when count matches', () => {
      expect(parseTabRow('a\tb\tc', 3)).toEqual(['a', 'b', 'c']);
    });

    it('returns null when count does not match', () => {
      expect(parseTabRow('a\tb', 3)).toBeNull();
    });
  });

  describe('toNullable', () => {
    it('returns trimmed string for non-empty values', () => {
      expect(toNullable(' Autechre ')).toBe('Autechre');
    });

    it('returns null for empty strings', () => {
      expect(toNullable('')).toBeNull();
      expect(toNullable('   ')).toBeNull();
    });

    it('returns null for NULL string', () => {
      expect(toNullable('NULL')).toBeNull();
    });
  });

  describe('parseEntryRows', () => {
    it('parses 11-column format (without SEGUE_FLAG)', () => {
      // Columns: ID, SHOW_ID, TYPE, ARTIST, ALBUM, TRACK, LABEL, REQ, SEQ, START, TLM
      const raw = '100\t200\t0\tAutechre\tConfield\tVI Scose Poise\tWarp\t0\t1\t1706799600000\t1706799700000';
      const rows = parseEntryRows(raw, 11);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: 100,
        showId: 200,
        entryTypeCode: 0,
        artistName: 'Autechre',
        albumTitle: 'Confield',
        trackTitle: 'VI Scose Poise',
        label: 'Warp',
        requestFlag: 0,
        playOrder: 1,
        startTime: 1706799600000,
        timeLastModified: 1706799700000,
        segueFlag: 0,
      });
    });

    it('parses 12-column format (with SEGUE_FLAG)', () => {
      const raw = '100\t200\t0\tAutechre\tConfield\tVI Scose Poise\tWarp\t1\t1\t1706799600000\t1706799700000\t1';
      const rows = parseEntryRows(raw, 12);

      expect(rows).toHaveLength(1);
      expect(rows[0].requestFlag).toBe(1);
      expect(rows[0].timeLastModified).toBe(1706799700000);
      expect(rows[0].segueFlag).toBe(1);
    });

    it('defaults segueFlag to 0 in 11-column format', () => {
      const raw = '100\t200\t0\tArtist\tAlbum\tTrack\tLabel\t0\t1\t1000\t2000';
      const rows = parseEntryRows(raw, 11);

      expect(rows[0].segueFlag).toBe(0);
    });

    it('handles NULL/empty text fields', () => {
      const raw = '100\t200\t7\tNULL\t\t\t\t0\t5\t1000\t2000';
      const rows = parseEntryRows(raw, 11);

      expect(rows[0].artistName).toBeNull();
      expect(rows[0].albumTitle).toBeNull();
      expect(rows[0].trackTitle).toBeNull();
      expect(rows[0].label).toBeNull();
    });

    it('skips malformed rows with wrong column count', () => {
      const raw = '100\t200\t0\tArtist';
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const rows = parseEntryRows(raw, 11);

      expect(rows).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('malformed'), expect.any(String));
      consoleSpy.mockRestore();
    });

    it('returns empty array for empty input', () => {
      expect(parseEntryRows('', 11)).toEqual([]);
      expect(parseEntryRows('   ', 11)).toEqual([]);
    });

    it('parses multiple rows', () => {
      const raw = [
        '1\t100\t0\tArtist1\tAlbum1\tTrack1\tLabel1\t0\t1\t1000\t2000',
        '2\t100\t0\tArtist2\tAlbum2\tTrack2\tLabel2\t1\t2\t3000\t4000',
      ].join('\n');
      const rows = parseEntryRows(raw, 11);

      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(1);
      expect(rows[1].id).toBe(2);
      expect(rows[1].timeLastModified).toBe(4000);
    });
  });

  describe('parseShowRows', () => {
    it('parses 5-column format with TIME_LAST_MODIFIED', () => {
      const raw = '1\t1706799600000\t1706803200000\tThe Morning Show\t1706799700000';
      const rows = parseShowRows(raw);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: 1,
        startTime: 1706799600000,
        endTime: 1706803200000,
        showName: 'The Morning Show',
        timeLastModified: 1706799700000,
      });
    });

    it('skips rows with invalid startTime', () => {
      const raw = '1\t0\t0\tBad Show\t0';
      const rows = parseShowRows(raw);

      expect(rows).toHaveLength(0);
    });

    it('handles null endTime and showName', () => {
      const raw = '1\t1706799600000\t0\tNULL\t0';
      const rows = parseShowRows(raw);

      expect(rows).toHaveLength(1);
      expect(rows[0].endTime).toBeNull();
      expect(rows[0].showName).toBeNull();
    });

    it('returns empty array for empty input', () => {
      expect(parseShowRows('')).toEqual([]);
    });
  });
});
