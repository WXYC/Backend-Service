import {
  mapEntryType,
  mapProdEntryType,
  epochMsToDate,
  resolveEntryTimestamp,
  resolveRadioHour,
  parseMySQLDatetime,
  truncate,
  transformShow,
  transformEntry,
} from '../../../../jobs/flowsheet-etl/transform';

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

  describe('resolveRadioHour', () => {
    // tubafrenzy's RADIO_HOUR is the authoritative top-of-hour for a breakpoint;
    // it is only meaningful for breakpoint rows (BS#1449).
    it('maps a breakpoint RADIO_HOUR (epoch ms) to a Date', () => {
      const topOfHour = 1718722800000; // 2024-06-18T15:00:00Z
      expect(resolveRadioHour('breakpoint', topOfHour)).toEqual(new Date(topOfHour));
    });

    it('returns null for a non-breakpoint type even when RADIO_HOUR is present', () => {
      expect(resolveRadioHour('track', 1718722800000)).toBeNull();
    });

    it('returns null for a breakpoint with RADIO_HOUR=0 (absent)', () => {
      expect(resolveRadioHour('breakpoint', 0)).toBeNull();
    });

    it('returns null for a breakpoint with a null RADIO_HOUR', () => {
      expect(resolveRadioHour('breakpoint', null)).toBeNull();
    });
  });

  describe('mapProdEntryType', () => {
    it.each([
      [0, 'track'],
      [1, 'track'],
      [2, 'track'],
      [3, 'track'],
      [4, 'track'],
      [5, 'track'],
      [6, 'track'],
      [7, 'talkset'],
      [8, 'breakpoint'],
      [9, 'show_start'],
      [10, 'show_end'],
    ] as const)('maps FLOWSHEET_ENTRY_TYPE_CODE_ID %d to "%s"', (code, expected) => {
      expect(mapProdEntryType(code)).toBe(expected);
    });

    it.each([11, 99, -1])('maps unknown code %d to "message"', (code) => {
      expect(mapProdEntryType(code)).toBe('message');
    });
  });

  describe('epochMsToDate', () => {
    it('converts valid epoch ms to a Date', () => {
      // 1775322000000 = 2026-04-04T17:00:00.000Z
      const result = epochMsToDate(1775322000000);
      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe('2026-04-04T17:00:00.000Z');
    });

    it('returns null for 0', () => {
      expect(epochMsToDate(0)).toBeNull();
    });

    it('returns null for null', () => {
      expect(epochMsToDate(null)).toBeNull();
    });

    it('returns null for NaN', () => {
      expect(epochMsToDate(NaN)).toBeNull();
    });
  });

  describe('resolveEntryTimestamp', () => {
    const VALID_MS = 1099537681134; // 2004-11-04T02:08:01.134Z
    const CREATED_MS = 1099537727355;
    const MODIFIED_MS = 1099537978522;

    it('prefers START_TIME when available', () => {
      const result = resolveEntryTimestamp(VALID_MS, CREATED_MS, MODIFIED_MS);
      expect(result?.getTime()).toBe(VALID_MS);
    });

    it('falls back to TIME_CREATED when START_TIME is 0', () => {
      const result = resolveEntryTimestamp(0, CREATED_MS, MODIFIED_MS);
      expect(result?.getTime()).toBe(CREATED_MS);
    });

    it('falls back to TIME_CREATED when START_TIME is null', () => {
      const result = resolveEntryTimestamp(null, CREATED_MS, MODIFIED_MS);
      expect(result?.getTime()).toBe(CREATED_MS);
    });

    it('falls back to TIME_LAST_MODIFIED when both are 0', () => {
      const result = resolveEntryTimestamp(0, 0, MODIFIED_MS);
      expect(result?.getTime()).toBe(MODIFIED_MS);
    });

    it('returns null when all timestamps are 0', () => {
      expect(resolveEntryTimestamp(0, 0, 0)).toBeNull();
    });

    it('returns null when all timestamps are null', () => {
      expect(resolveEntryTimestamp(null, null, null)).toBeNull();
    });
  });

  describe('parseMySQLDatetime', () => {
    it('parses a standard MySQL datetime string', () => {
      const result = parseMySQLDatetime('2023-10-15 14:30:00');
      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toContain('2023-10-15');
    });

    it('applies EDT offset (-04:00) for summer dates', () => {
      // July 4 is always EDT (UTC-4)
      const result = parseMySQLDatetime('2023-07-04 12:00:00');
      expect(result).toBeInstanceOf(Date);
      // 12:00 EDT = 16:00 UTC
      expect(result?.toISOString()).toBe('2023-07-04T16:00:00.000Z');
    });

    it('applies EST offset (-05:00) for winter dates', () => {
      // January 15 is always EST (UTC-5)
      const result = parseMySQLDatetime('2023-01-15 12:00:00');
      expect(result).toBeInstanceOf(Date);
      // 12:00 EST = 17:00 UTC
      expect(result?.toISOString()).toBe('2023-01-15T17:00:00.000Z');
    });

    it('handles the spring-forward DST transition date', () => {
      // March 12, 2023: clocks spring forward at 2:00 AM ET
      // 1:00 AM is still EST (UTC-5)
      const beforeSpring = parseMySQLDatetime('2023-03-12 01:00:00');
      expect(beforeSpring?.toISOString()).toBe('2023-03-12T06:00:00.000Z');
      // 3:00 AM is EDT (UTC-4)
      const afterSpring = parseMySQLDatetime('2023-03-12 03:00:00');
      expect(afterSpring?.toISOString()).toBe('2023-03-12T07:00:00.000Z');
    });

    it('handles the fall-back DST transition date', () => {
      // November 5, 2023: clocks fall back at 2:00 AM ET
      // 12:00 PM is EST (UTC-5) after the transition
      const result = parseMySQLDatetime('2023-11-05 12:00:00');
      expect(result?.toISOString()).toBe('2023-11-05T17:00:00.000Z');
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
        100, // 0: id
        42, // 1: show_id
        0, // 2: entry_type (track)
        'Autechre', // 3: artist_name
        'Confield', // 4: album_title
        'VI Scose Poise', // 5: track_title
        'Warp', // 6: label
        null, // 7: message
        0, // 8: request_flag
        1, // 9: play_order
        '2023-10-15 20:05:00', // 10: time_played
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
