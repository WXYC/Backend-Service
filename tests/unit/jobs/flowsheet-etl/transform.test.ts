/**
 * Unit tests for flowsheet-etl transform functions.
 *
 * Tests the pure data transformation functions used by both bulk and incremental modes.
 */

jest.mock('@wxyc/database', () => ({}));

import { mapEntryType, transformShow, transformEntry, truncate } from '../../../../jobs/flowsheet-etl/transform';

describe('flowsheet-etl transform', () => {
  describe('mapEntryType', () => {
    it.each([
      [1, 'track'],
      [2, 'track'],
      [3, 'track'],
      [4, 'track'],
      [6, 'track'],
    ] as const)('maps rotation/library code %d to "track"', (code, expected) => {
      expect(mapEntryType(code)).toBe(expected);
    });

    it('maps code 7 to "talkset"', () => {
      expect(mapEntryType(7)).toBe('talkset');
    });

    it('maps code 8 to "breakpoint"', () => {
      expect(mapEntryType(8)).toBe('breakpoint');
    });

    it('maps code 9 to "show_start"', () => {
      expect(mapEntryType(9)).toBe('show_start');
    });

    it('maps code 10 to "show_end"', () => {
      expect(mapEntryType(10)).toBe('show_end');
    });

    it('maps code 0 to "track" (default)', () => {
      expect(mapEntryType(0)).toBe('track');
    });

    it('maps unmapped code 5 to "track" (default)', () => {
      expect(mapEntryType(5)).toBe('track');
    });

    it('maps unmapped code 99 to "track" (default)', () => {
      expect(mapEntryType(99)).toBe('track');
    });
  });

  describe('transformShow', () => {
    it('transforms an active show (signoff_time = 0)', () => {
      const raw = {
        id: 42,
        signon_time: 1700000000000,
        signoff_time: 0,
        show_name: 'Late Night Jazz',
      };

      const result = transformShow(raw);

      expect(result.legacy_show_id).toBe(42);
      expect(result.start_time).toEqual(new Date(1700000000000));
      expect(result.end_time).toBeNull();
      expect(result.show_name).toBe('Late Night Jazz');
      expect(result.primary_dj_id).toBeNull();
      expect(result.specialty_id).toBeNull();
    });

    it('transforms a completed show (signoff_time > 0)', () => {
      const raw = {
        id: 100,
        signon_time: 1700000000000,
        signoff_time: 1700010000000,
        show_name: 'Morning Mix',
      };

      const result = transformShow(raw);

      expect(result.legacy_show_id).toBe(100);
      expect(result.start_time).toEqual(new Date(1700000000000));
      expect(result.end_time).toEqual(new Date(1700010000000));
      expect(result.show_name).toBe('Morning Mix');
    });

    it('treats empty show_name as null', () => {
      const raw = {
        id: 1,
        signon_time: 1700000000000,
        signoff_time: 0,
        show_name: '',
      };

      expect(transformShow(raw).show_name).toBeNull();
    });

    it('treats whitespace-only show_name as null', () => {
      const raw = {
        id: 1,
        signon_time: 1700000000000,
        signoff_time: 0,
        show_name: '   ',
      };

      expect(transformShow(raw).show_name).toBeNull();
    });
  });

  describe('transformEntry', () => {
    const legacyReleaseMap = new Map<number, number>([
      [5001, 101],
      [5002, 102],
    ]);

    it('transforms a track entry with library link', () => {
      const raw = {
        id: 1000,
        radio_show_id: 42,
        entry_type_code: 6,
        artist_name: 'Autechre',
        song_title: 'VI Scose Poise',
        release_title: 'Confield',
        label_name: 'Warp',
        library_release_id: 5001,
        request_flag: 0,
        time_created: 1700000000000,
      };

      const result = transformEntry(raw, legacyReleaseMap);

      expect(result.legacy_entry_id).toBe(1000);
      expect(result.entry_type).toBe('track');
      expect(result.artist_name).toBe('Autechre');
      expect(result.track_title).toBe('VI Scose Poise');
      expect(result.album_title).toBe('Confield');
      expect(result.record_label).toBe('Warp');
      expect(result.album_id).toBe(101); // resolved via legacyReleaseMap
      expect(result.request_flag).toBe(false);
      expect(result.add_time).toEqual(new Date(1700000000000));
      expect(result.message).toBeNull();
    });

    it('transforms a track entry without library link', () => {
      const raw = {
        id: 1001,
        radio_show_id: 42,
        entry_type_code: 0,
        artist_name: 'Unknown Band',
        song_title: 'Some Song',
        release_title: 'Some Album',
        label_name: 'Indie Label',
        library_release_id: 0,
        request_flag: 1,
        time_created: 1700001000000,
      };

      const result = transformEntry(raw, legacyReleaseMap);

      expect(result.album_id).toBeNull();
      expect(result.request_flag).toBe(true);
      expect(result.entry_type).toBe('track');
    });

    it('transforms a track with unmatched library release ID', () => {
      const raw = {
        id: 1002,
        radio_show_id: 42,
        entry_type_code: 2,
        artist_name: 'Artist',
        song_title: 'Track',
        release_title: 'Album',
        label_name: '',
        library_release_id: 9999, // not in map
        request_flag: 0,
        time_created: 1700002000000,
      };

      const result = transformEntry(raw, legacyReleaseMap);

      expect(result.album_id).toBeNull();
    });

    it('transforms a talkset entry', () => {
      const raw = {
        id: 2000,
        radio_show_id: 42,
        entry_type_code: 7,
        artist_name: '------ talkset -------',
        song_title: '',
        release_title: '',
        label_name: '',
        library_release_id: 0,
        request_flag: 0,
        time_created: 1700003000000,
      };

      const result = transformEntry(raw, legacyReleaseMap);

      expect(result.entry_type).toBe('talkset');
      expect(result.message).toBe('------ talkset -------');
      expect(result.artist_name).toBeNull();
      expect(result.track_title).toBeNull();
      expect(result.album_title).toBeNull();
    });

    it('transforms a breakpoint entry', () => {
      const raw = {
        id: 2001,
        radio_show_id: 42,
        entry_type_code: 8,
        artist_name: 'BREAKPOINT',
        song_title: '',
        release_title: '',
        label_name: '',
        library_release_id: 0,
        request_flag: 0,
        time_created: 1700004000000,
      };

      const result = transformEntry(raw, legacyReleaseMap);

      expect(result.entry_type).toBe('breakpoint');
      expect(result.message).toBe('BREAKPOINT');
    });

    it('transforms a show_start entry', () => {
      const raw = {
        id: 3000,
        radio_show_id: 42,
        entry_type_code: 9,
        artist_name: 'DJ Freeform signed on',
        song_title: '',
        release_title: '',
        label_name: '',
        library_release_id: 0,
        request_flag: 0,
        time_created: 1700005000000,
      };

      const result = transformEntry(raw, legacyReleaseMap);

      expect(result.entry_type).toBe('show_start');
      expect(result.message).toBe('DJ Freeform signed on');
    });

    it('transforms a show_end entry', () => {
      const raw = {
        id: 3001,
        radio_show_id: 42,
        entry_type_code: 10,
        artist_name: 'DJ Freeform signed off',
        song_title: '',
        release_title: '',
        label_name: '',
        library_release_id: 0,
        request_flag: 0,
        time_created: 1700006000000,
      };

      const result = transformEntry(raw, legacyReleaseMap);

      expect(result.entry_type).toBe('show_end');
      expect(result.message).toBe('DJ Freeform signed off');
    });

    it('sets legacy_entry_id from raw ID', () => {
      const raw = {
        id: 12345,
        radio_show_id: 1,
        entry_type_code: 6,
        artist_name: 'Test',
        song_title: 'Test',
        release_title: 'Test',
        label_name: '',
        library_release_id: 0,
        request_flag: 0,
        time_created: 1700000000000,
      };

      expect(transformEntry(raw, new Map()).legacy_entry_id).toBe(12345);
    });
  });

  describe('truncate', () => {
    it('returns string unchanged when within limit', () => {
      expect(truncate('hello', 128)).toBe('hello');
    });

    it('returns string unchanged when at limit', () => {
      const str = 'a'.repeat(128);
      expect(truncate(str, 128)).toBe(str);
    });

    it('truncates string over limit', () => {
      const str = 'a'.repeat(200);
      expect(truncate(str, 128)).toBe('a'.repeat(128));
    });

    it('returns null for null input', () => {
      expect(truncate(null, 128)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(truncate('', 128)).toBeNull();
    });
  });
});
