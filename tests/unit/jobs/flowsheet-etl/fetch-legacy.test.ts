/**
 * Unit tests for flowsheet ETL fetch-legacy parsing functions.
 *
 * Tests the tab-separated row parsing for entries and shows, including
 * the TIME_CREATED and TIME_LAST_MODIFIED columns used for timestamp
 * resolution and update detection.
 */

jest.mock('@wxyc/database', () => ({
  MirrorSQL: {
    instance: jest.fn().mockReturnValue({
      send: jest.fn(),
      close: jest.fn(),
    }),
  },
  parseTabRow: (line: string, columnCount: number) => {
    const columns = line.split('\t');
    return columns.length === columnCount ? columns : null;
  },
  toNullable: (value: string) => {
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed === 'NULL' ? null : trimmed;
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
    // Columns: 0-12 base (ID, SHOW_ID, TYPE, ARTIST, ALBUM, TRACK, LABEL, REQ,
    // SEQ, START, TIME_CREATED, TLM, LIBRARY_RELEASE_ID), 13: RADIO_HOUR
    // [, 14: SEGUE_FLAG]. RADIO_HOUR (BS#1449) is a stable column; SEGUE_FLAG
    // stays the optional trailing column behind the fetchLegacyEntries try/catch.

    it('parses 14-column format (without SEGUE_FLAG)', () => {
      // RADIO_HOUR=0 on a track row → radioHour null (tracks carry no top-of-hour).
      const raw =
        '100\t200\t0\tAutechre\tConfield\tVI Scose Poise\tWarp\t0\t1\t1706799600000\t1706799650000\t1706799700000\t101\t0';
      const rows = parseEntryRows(raw, 14);

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
        timeCreated: 1706799650000,
        timeLastModified: 1706799700000,
        legacyReleaseId: 101,
        radioHour: null,
        segueFlag: 0,
      });
    });

    it('parses a populated RADIO_HOUR (breakpoint) as epoch ms at index 13', () => {
      // entryTypeCode 8 = HOURLY_BREAK; RADIO_HOUR is the authoritative top-of-hour.
      const raw = '100\t200\t8\t--- 12:00 PM ---\t\t\t\t0\t1\t1718726280000\t0\t0\t0\t1718726400000';
      const rows = parseEntryRows(raw, 14);

      expect(rows[0].radioHour).toBe(1718726400000);
    });

    it('parses 15-column format (with SEGUE_FLAG) — segue read from the shifted index 14', () => {
      // RADIO_HOUR=0 at index 13, SEGUE_FLAG=1 at index 14. Guards against a
      // segue-index regression from inserting RADIO_HOUR ahead of SEGUE_FLAG.
      const raw =
        '100\t200\t0\tAutechre\tConfield\tVI Scose Poise\tWarp\t1\t1\t1706799600000\t1706799650000\t1706799700000\t101\t0\t1';
      const rows = parseEntryRows(raw, 15);

      expect(rows).toHaveLength(1);
      expect(rows[0].requestFlag).toBe(1);
      expect(rows[0].timeCreated).toBe(1706799650000);
      expect(rows[0].timeLastModified).toBe(1706799700000);
      expect(rows[0].legacyReleaseId).toBe(101);
      expect(rows[0].radioHour).toBeNull();
      expect(rows[0].segueFlag).toBe(1);
    });

    it('defaults segueFlag to 0 in 14-column format', () => {
      const raw = '100\t200\t0\tArtist\tAlbum\tTrack\tLabel\t0\t1\t1000\t1500\t2000\t42\t0';
      const rows = parseEntryRows(raw, 14);

      expect(rows[0].segueFlag).toBe(0);
    });

    it('sets radioHour to null when RADIO_HOUR is 0', () => {
      const raw = '100\t200\t8\t--- breakpoint ---\t\t\t\t0\t1\t1718726280000\t0\t0\t0\t0';
      const rows = parseEntryRows(raw, 14);

      expect(rows[0].radioHour).toBeNull();
    });

    it('sets legacyReleaseId to null when value is 0', () => {
      const raw = '100\t200\t7\tTALKSET\t\t\t\t0\t5\t1000\t1500\t2000\t0\t0';
      const rows = parseEntryRows(raw, 14);

      expect(rows[0].legacyReleaseId).toBeNull();
    });

    it('handles NULL/empty text fields', () => {
      const raw = '100\t200\t7\tNULL\t\t\t\t0\t5\t1000\t1500\t2000\t0\t0';
      const rows = parseEntryRows(raw, 14);

      expect(rows[0].artistName).toBeNull();
      expect(rows[0].albumTitle).toBeNull();
      expect(rows[0].trackTitle).toBeNull();
      expect(rows[0].label).toBeNull();
    });

    it('skips malformed rows with wrong column count', () => {
      const raw = '100\t200\t0\tArtist';
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const rows = parseEntryRows(raw, 14);

      expect(rows).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('malformed'), expect.any(String));
      consoleSpy.mockRestore();
    });

    it('returns empty array for empty input', () => {
      expect(parseEntryRows('', 14)).toEqual([]);
      expect(parseEntryRows('   ', 14)).toEqual([]);
    });

    it('parses multiple rows', () => {
      const raw = [
        '1\t100\t0\tArtist1\tAlbum1\tTrack1\tLabel1\t0\t1\t1000\t1500\t2000\t101\t0',
        '2\t100\t0\tArtist2\tAlbum2\tTrack2\tLabel2\t1\t2\t3000\t3500\t4000\t102\t0',
      ].join('\n');
      const rows = parseEntryRows(raw, 14);

      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(1);
      expect(rows[0].legacyReleaseId).toBe(101);
      expect(rows[1].id).toBe(2);
      expect(rows[1].legacyReleaseId).toBe(102);
      expect(rows[1].timeCreated).toBe(3500);
      expect(rows[1].timeLastModified).toBe(4000);
    });

    it('preserves timeCreated when START_TIME is 0', () => {
      const raw =
        '100\t200\t0\tAutechre\tConfield\tVI Scose Poise\tWarp\t0\t1\t0\t1706799650000\t1706799700000\t101\t0';
      const rows = parseEntryRows(raw, 14);

      expect(rows).toHaveLength(1);
      expect(rows[0].startTime).toBe(0);
      expect(rows[0].timeCreated).toBe(1706799650000);
    });
  });

  describe('parseShowRows', () => {
    // Columns: ID, SIGNON_TIME, SIGNOFF_TIME, SHOW_NAME, TLM, DJ_HANDLE, DJ_ID
    // (column 5 is DJ_HANDLE, the on-air alias — NOT DJ_NAME, the user's full
    // real name. Pulling DJ_NAME into shows.legacy_dj_name leaked PII onto the
    // v2 marker dj_name wire via the COALESCE fallback. The query string in
    // fetchLegacyShows is asserted separately below.)

    it('parses 7-column format with DJ fields', () => {
      const raw = '1\t1706799600000\t1706803200000\tThe Morning Show\t1706799700000\tDJ Bluejay\t42';
      const rows = parseShowRows(raw);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: 1,
        startTime: 1706799600000,
        endTime: 1706803200000,
        showName: 'The Morning Show',
        timeLastModified: 1706799700000,
        djHandle: 'DJ Bluejay',
        djId: 42,
      });
    });

    it('skips rows with invalid startTime', () => {
      const raw = '1\t0\t0\tBad Show\t0\tDJ Test\t0';
      const rows = parseShowRows(raw);

      expect(rows).toHaveLength(0);
    });

    it('handles null endTime and showName', () => {
      const raw = '1\t1706799600000\t0\tNULL\t0\tDJ Test\t5';
      const rows = parseShowRows(raw);

      expect(rows).toHaveLength(1);
      expect(rows[0].endTime).toBeNull();
      expect(rows[0].showName).toBeNull();
    });

    it('sets djHandle to null for empty/NULL values', () => {
      const raw = '1\t1706799600000\t0\tShow\t0\tNULL\t0';
      const rows = parseShowRows(raw);

      expect(rows[0].djHandle).toBeNull();
    });

    it('sets djId to null for 0 or invalid values', () => {
      const raw = '1\t1706799600000\t0\tShow\t0\tDJ Test\t0';
      const rows = parseShowRows(raw);

      expect(rows[0].djId).toBeNull();
    });

    it('parses valid DJ name and ID', () => {
      const raw = '1\t1706799600000\t1706803200000\tThe Nest\t1706799700000\tDJ Bluejay\t42';
      const rows = parseShowRows(raw);

      expect(rows[0].djHandle).toBe('DJ Bluejay');
      expect(rows[0].djId).toBe(42);
    });

    it('returns empty array for empty input', () => {
      expect(parseShowRows('')).toEqual([]);
    });
  });

  describe('fetchLegacyShows query — DJ_HANDLE source (PII regression)', () => {
    // BS#1371 surfaced shows.legacy_dj_name on the public v2 marker dj_name
    // wire. The ETL must read DJ_HANDLE (on-air alias), not DJ_NAME (the
    // user's full real name forwarded by the BS legacy mirror as
    // `realName || name`). If the column ever flips back, this test fires.
    it('SELECTs DJ_HANDLE — never DJ_NAME — for shows.legacy_dj_name', async () => {
      const { MirrorSQL } = jest.requireMock('@wxyc/database');
      const sendMock: jest.Mock = MirrorSQL.instance().send;
      sendMock.mockReset().mockResolvedValue('');

      const { fetchLegacyShows } = await import('../../../../jobs/flowsheet-etl/fetch-legacy');
      await fetchLegacyShows(null);

      expect(sendMock).toHaveBeenCalledTimes(1);
      const query: string = sendMock.mock.calls[0][0];
      expect(query).toMatch(/\brs\.DJ_HANDLE\b/);
      expect(query).not.toMatch(/\brs\.DJ_NAME\b/);
    });
  });
});
