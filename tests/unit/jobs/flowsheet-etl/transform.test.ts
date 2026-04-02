import { mapEntryType, parseMySQLDatetime, truncate, transformShow, transformEntry } from '../../../../jobs/flowsheet-etl/transform';

describe('flowsheet-etl transform', () => {
  describe('mapEntryType', () => {
    it.each([
      [0, 'track'],
      [1, 'show_start'],
      [2, 'show_end'],
      [3, 'breakpoint'],
      [4, 'talkset'],
      [5, 'dj_join'],
      [6, 'dj_leave'],
      [7, 'message'],
    ] as const)('maps legacy code %d to "%s"', (code, expected) => {
      expect(mapEntryType(code)).toBe(expected);
    });

    it.each([8, 9, 10, 99, -1])('maps unknown code %d to "message"', (code) => {
      expect(mapEntryType(code)).toBe('message');
    });
  });

  describe('parseMySQLDatetime', () => {
    it('parses a standard MySQL datetime string', () => {
      const result = parseMySQLDatetime('2023-10-15 14:30:00');
      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toContain('2023-10-15');
    });

    it('returns null for null input', () => {
      expect(parseMySQLDatetime(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseMySQLDatetime('')).toBeNull();
    });

    it('returns null for "NULL"', () => {
      expect(parseMySQLDatetime('NULL')).toBeNull();
    });

    it('returns null for unparseable string', () => {
      expect(parseMySQLDatetime('not-a-date')).toBeNull();
    });
  });

  describe('truncate', () => {
    it('returns the string unchanged if within limit', () => {
      expect(truncate('Autechre', 128)).toBe('Autechre');
    });

    it('truncates to max length', () => {
      const long = 'A'.repeat(200);
      expect(truncate(long, 128)).toHaveLength(128);
    });

    it('returns null for null input', () => {
      expect(truncate(null, 128)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(truncate('', 128)).toBeNull();
    });

    it('trims whitespace', () => {
      expect(truncate('  Stereolab  ', 128)).toBe('Stereolab');
    });
  });

  describe('transformShow', () => {
    it('transforms a completed show', () => {
      const result = transformShow([42, '2023-10-15 20:00:00', '2023-10-15 22:00:00']);
      expect(result).toEqual(
        expect.objectContaining({
          legacy_show_id: 42,
          start_time: expect.any(Date),
          end_time: expect.any(Date),
        })
      );
    });

    it('transforms an active show (null end_time)', () => {
      const result = transformShow([43, '2023-10-15 20:00:00', null]);
      expect(result).toEqual(
        expect.objectContaining({
          legacy_show_id: 43,
          end_time: null,
        })
      );
    });

    it('returns null for invalid start_time', () => {
      expect(transformShow([44, 'invalid', null])).toBeNull();
    });
  });

  describe('transformEntry', () => {
    const makeRow = (overrides: Partial<Record<number, string | number | null>> = {}) => {
      const base: (string | number | null)[] = [
        100,                         // 0: id
        42,                          // 1: show_id
        0,                           // 2: entry_type (track)
        'Autechre',                  // 3: artist_name
        'Confield',                  // 4: album_title
        'VI Scose Poise',            // 5: track_title
        'Warp',                      // 6: label
        null,                        // 7: message
        0,                           // 8: request_flag
        1,                           // 9: play_order
        '2023-10-15 20:05:00',       // 10: time_played
      ];
      for (const [idx, val] of Object.entries(overrides)) {
        base[Number(idx)] = val;
      }
      return base;
    };

    it('transforms a track entry', () => {
      const result = transformEntry(makeRow());
      expect(result).toEqual(
        expect.objectContaining({
          legacy_entry_id: 100,
          legacy_show_id: 42,
          entry_type: 'track',
          artist_name: 'Autechre',
          album_title: 'Confield',
          track_title: 'VI Scose Poise',
          record_label: 'Warp',
          request_flag: false,
          play_order: 1,
        })
      );
    });

    it('maps talkset entry type', () => {
      expect(transformEntry(makeRow({ 2: 4 }))).toEqual(expect.objectContaining({ entry_type: 'talkset' }));
    });

    it('maps breakpoint entry type', () => {
      expect(transformEntry(makeRow({ 2: 3 }))).toEqual(expect.objectContaining({ entry_type: 'breakpoint' }));
    });

    it('maps show_start entry type', () => {
      expect(transformEntry(makeRow({ 2: 1 }))).toEqual(expect.objectContaining({ entry_type: 'show_start' }));
    });

    it('maps show_end entry type', () => {
      expect(transformEntry(makeRow({ 2: 2 }))).toEqual(expect.objectContaining({ entry_type: 'show_end' }));
    });

    it('handles request_flag=1', () => {
      expect(transformEntry(makeRow({ 8: 1 }))).toEqual(expect.objectContaining({ request_flag: true }));
    });

    it('truncates long artist names', () => {
      const longName = 'A'.repeat(200);
      const result = transformEntry(makeRow({ 3: longName }));
      expect(result?.artist_name).toHaveLength(128);
    });

    it('truncates long messages', () => {
      const longMsg = 'M'.repeat(300);
      const result = transformEntry(makeRow({ 7: longMsg }));
      expect(result?.message).toHaveLength(250);
    });

    it('returns null for missing time_played', () => {
      expect(transformEntry(makeRow({ 10: null }))).toBeNull();
    });

    it('returns null for invalid entry id', () => {
      expect(transformEntry(makeRow({ 0: null }))).toBeNull();
    });
  });
});
