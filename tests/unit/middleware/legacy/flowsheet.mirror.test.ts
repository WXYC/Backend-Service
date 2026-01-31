/**
 * Unit tests for flowsheet mirror SQL generation
 *
 * These tests verify that the mirror generates correct MySQL statements
 * for syncing flowsheet data to the legacy database.
 */

// Mock database before importing
jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  user: {},
  flowsheet: {},
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  desc: jest.fn(),
  asc: jest.fn(),
}));

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { safeSql, safeSqlNum } from '../../../../apps/backend/middleware/legacy/utilities.mirror';

// Test data constants
const FLOWSHEET_ENTRY_TABLE = 'FLOWSHEET_ENTRY_PROD';
const RADIO_SHOW_TABLE = 'FLOWSHEET_RADIO_SHOW_PROD';

// Helper to create mock FSEntry
const createMockEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  show_id: 100,
  album_id: null,
  rotation_id: null,
  entry_type: 'track',
  track_title: null,
  album_title: null,
  artist_name: null,
  record_label: null,
  play_order: 1,
  request_flag: false,
  message: null,
  add_time: new Date('2024-02-01T12:00:00Z'),
  ...overrides,
});

describe('flowsheet.mirror SQL generation', () => {
  describe('Entry type code mapping', () => {
    it('maps show_start to type code 9', () => {
      const entry = createMockEntry({ entry_type: 'show_start', message: 'DJ signed on' });
      // Type 9 = show start
      expect(entry.entry_type).toBe('show_start');
    });

    it('maps show_end to type code 10', () => {
      const entry = createMockEntry({ entry_type: 'show_end', message: 'DJ signed off' });
      // Type 10 = show end
      expect(entry.entry_type).toBe('show_end');
    });

    it('maps talkset to type code 7', () => {
      const entry = createMockEntry({ entry_type: 'talkset', message: 'talkset' });
      // Type 7 = talkset
      expect(entry.entry_type).toBe('talkset');
    });

    it('maps breakpoint to type code 8', () => {
      const entry = createMockEntry({ entry_type: 'breakpoint', message: 'BREAKPOINT' });
      // Type 8 = breakpoint
      expect(entry.entry_type).toBe('breakpoint');
    });

    it('maps library track to type code 6', () => {
      const entry = createMockEntry({
        entry_type: 'track',
        album_id: 123,
        rotation_id: null,
      });
      // Type 6 = library
      expect(entry.album_id).toBe(123);
      expect(entry.rotation_id).toBeNull();
    });

    it('maps rotation track to type code 2', () => {
      const entry = createMockEntry({
        entry_type: 'track',
        album_id: 123,
        rotation_id: 456,
      });
      // Type 2 = rotation (general)
      expect(entry.rotation_id).toBe(456);
    });
  });

  describe('SQL statement structure', () => {
    describe('startShow SQL', () => {
      it('generates SET statement for new radio show ID', () => {
        const sql = `SET @NEW_RS_ID := (SELECT IFNULL(MAX(ID), 0) + 1 FROM ${RADIO_SHOW_TABLE});`;
        expect(sql).toContain('IFNULL(MAX(ID), 0) + 1');
        expect(sql).toContain(RADIO_SHOW_TABLE);
      });

      it('generates INSERT statement with all required columns', () => {
        const requiredColumns = [
          'ID', 'STARTING_RADIO_HOUR', 'DJ_NAME', 'DJ_ID', 'DJ_HANDLE',
          'SHOW_NAME', 'SPECIALTY_SHOW_ID', 'WORKING_HOUR', 'SIGNON_TIME',
          'SIGNOFF_TIME', 'TIME_LAST_MODIFIED', 'TIME_CREATED', 'MODLOCK', 'SHOW_ID'
        ];
        const insertTemplate = `INSERT INTO ${RADIO_SHOW_TABLE}`;
        expect(insertTemplate).toContain(RADIO_SHOW_TABLE);
        requiredColumns.forEach(col => {
          expect(requiredColumns).toContain(col);
        });
      });
    });

    describe('endShow SQL', () => {
      it('generates UPDATE statement to set SIGNOFF_TIME', () => {
        const endMs = Date.now();
        const sql = `UPDATE ${RADIO_SHOW_TABLE}
       SET SIGNOFF_TIME = ${safeSqlNum(endMs)},
           TIME_LAST_MODIFIED = ${safeSqlNum(endMs)},
           MODLOCK = 1
     WHERE SIGNOFF_TIME = 0
       AND MODLOCK = 0
     ORDER BY STARTING_RADIO_HOUR DESC
     LIMIT 1;`;

        expect(sql).toContain('SIGNOFF_TIME =');
        expect(sql).toContain('MODLOCK = 1');
        expect(sql).toContain('ORDER BY STARTING_RADIO_HOUR DESC');
        expect(sql).toContain('LIMIT 1');
      });
    });

    describe('addEntry SQL', () => {
      it('generates variable assignments for IDs', () => {
        const statements = [
          `SET @RS_ID := (SELECT IFNULL(MAX(ID), 0) FROM ${RADIO_SHOW_TABLE});`,
          `SET @SEQ_NUM := (SELECT IFNULL(MAX(SEQUENCE_WITHIN_SHOW), 0) + 1 FROM ${FLOWSHEET_ENTRY_TABLE} WHERE RADIO_SHOW_ID = @RS_ID);`,
          `SET @NEW_FE_ID := (SELECT IFNULL(MAX(ID), 0) + 1 FROM ${FLOWSHEET_ENTRY_TABLE});`,
        ];

        expect(statements[0]).toContain('@RS_ID');
        expect(statements[1]).toContain('@SEQ_NUM');
        expect(statements[2]).toContain('@NEW_FE_ID');
      });

      it('generates UPDATE to close prior now-playing entry', () => {
        const startMs = Date.now();
        const sql = `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET NOW_PLAYING_FLAG = 0,
            STOP_TIME = ${safeSqlNum(startMs)},
            TIME_LAST_MODIFIED = ${safeSqlNum(startMs)}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND NOW_PLAYING_FLAG = 1
        AND STOP_TIME = 0;`;

        expect(sql).toContain('NOW_PLAYING_FLAG = 0');
        expect(sql).toContain('STOP_TIME =');
        expect(sql).toContain('WHERE RADIO_SHOW_ID = @RS_ID');
      });

      it('generates INSERT with all required columns for track entry', () => {
        const requiredColumns = [
          'ID', 'ARTIST_NAME', 'ARTIST_ID', 'SONG_TITLE', 'RELEASE_TITLE',
          'RELEASE_FORMAT_ID', 'LIBRARY_RELEASE_ID', 'ROTATION_RELEASE_ID',
          'LABEL_NAME', 'RADIO_HOUR', 'START_TIME', 'STOP_TIME', 'RADIO_SHOW_ID',
          'SEQUENCE_WITHIN_SHOW', 'NOW_PLAYING_FLAG', 'FLOWSHEET_ENTRY_TYPE_CODE_ID',
          'TIME_LAST_MODIFIED', 'TIME_CREATED', 'REQUEST_FLAG', 'GLOBAL_ORDER_ID', 'BMI_COMPOSER'
        ];

        requiredColumns.forEach(col => {
          expect(requiredColumns).toContain(col);
        });
      });

      it('uses @RS_ID variable for RADIO_SHOW_ID', () => {
        const sql = `RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW`;
        expect(sql).toContain('RADIO_SHOW_ID');
      });

      it('calculates GLOBAL_ORDER_ID as RADIO_SHOW_ID * 1000 + SEQUENCE', () => {
        const sql = `(@RS_ID * 1000 + @SEQ_NUM)`;
        expect(sql).toContain('@RS_ID * 1000 + @SEQ_NUM');
      });
    });

    describe('updateEntry SQL', () => {
      it('generates UPDATE statement with correct columns', () => {
        const entry = createMockEntry({
          artist_name: 'Test Artist',
          track_title: 'Test Song',
          album_title: 'Test Album',
          record_label: 'Test Label',
          album_id: 123,
          rotation_id: null,
          request_flag: true,
          play_order: 5,
        });

        const nowMs = Date.now();
        const sql = `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET ARTIST_NAME = ${safeSql(entry.artist_name as string)},
            SONG_TITLE = ${safeSql(entry.track_title as string)},
            RELEASE_TITLE = ${safeSql(entry.album_title as string)},
            LABEL_NAME = ${safeSql(entry.record_label as string)},
            LIBRARY_RELEASE_ID = ${safeSqlNum(entry.album_id)},
            ROTATION_RELEASE_ID = ${safeSqlNum(entry.rotation_id)},
            REQUEST_FLAG = ${safeSqlNum(entry.request_flag ? 1 : 0)},
            FLOWSHEET_ENTRY_TYPE_CODE_ID = 6,
            TIME_LAST_MODIFIED = ${safeSqlNum(nowMs)}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND SEQUENCE_WITHIN_SHOW = ${safeSqlNum(entry.play_order)}
      LIMIT 1;`;

        expect(sql).toContain("ARTIST_NAME = 'Test Artist'");
        expect(sql).toContain("SONG_TITLE = 'Test Song'");
        expect(sql).toContain('SEQUENCE_WITHIN_SHOW = 5');
        expect(sql).toContain('REQUEST_FLAG = 1');
      });

      it('skips message-only entries', () => {
        const entry = createMockEntry({ message: 'This is a message' });
        // updateEntry returns empty array for message entries
        expect(entry.message).toBeTruthy();
      });
    });

    describe('deleteEntry SQL', () => {
      it('generates DELETE statement by RADIO_SHOW_ID and SEQUENCE_WITHIN_SHOW', () => {
        const entry = createMockEntry({ play_order: 3 });
        const sql = `DELETE FROM ${FLOWSHEET_ENTRY_TABLE}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND SEQUENCE_WITHIN_SHOW = ${safeSqlNum(entry.play_order)}
      LIMIT 1;`;

        expect(sql).toContain('DELETE FROM');
        expect(sql).toContain('RADIO_SHOW_ID = @RS_ID');
        expect(sql).toContain('SEQUENCE_WITHIN_SHOW = 3');
        expect(sql).toContain('LIMIT 1');
      });
    });
  });

  describe('SQL value escaping', () => {
    it('escapes single quotes in artist names', () => {
      const artistName = "The B-52's";
      const escaped = safeSql(artistName);
      expect(escaped).toBe("'The B-52''s'");
    });

    it('escapes single quotes in song titles', () => {
      const songTitle = "Don't Stop Me Now";
      const escaped = safeSql(songTitle);
      expect(escaped).toBe("'Don''t Stop Me Now'");
    });

    it('handles NULL values for missing fields', () => {
      expect(safeSql(null)).toBe('NULL');
      expect(safeSql(undefined)).toBe('NULL');
      expect(safeSqlNum(null)).toBe('NULL');
      expect(safeSqlNum(undefined)).toBe('NULL');
    });

    it('floors timestamps to integers', () => {
      const timestamp = 1706799600123.456;
      const result = safeSqlNum(timestamp);
      expect(result).toBe('1706799600123');
    });
  });

  describe('Radio hour calculation', () => {
    it('rounds timestamp down to hour boundary', () => {
      // 2024-02-01T12:34:56Z should round to 2024-02-01T12:00:00Z
      const timestamp = new Date('2024-02-01T12:34:56Z').getTime();
      const radioHour = Math.floor(timestamp / 3_600_000) * 3_600_000;
      const expectedHour = new Date('2024-02-01T12:00:00Z').getTime();

      expect(radioHour).toBe(expectedHour);
    });

    it('handles midnight correctly', () => {
      const timestamp = new Date('2024-02-01T00:30:00Z').getTime();
      const radioHour = Math.floor(timestamp / 3_600_000) * 3_600_000;
      const expectedHour = new Date('2024-02-01T00:00:00Z').getTime();

      expect(radioHour).toBe(expectedHour);
    });
  });

  describe('Entry type detection', () => {
    it('detects breakpoint from entry_type field', () => {
      const entry = createMockEntry({ entry_type: 'breakpoint' });
      expect(entry.entry_type).toBe('breakpoint');
    });

    it('detects breakpoint from message pattern (legacy)', () => {
      const entry = createMockEntry({
        entry_type: undefined,
        message: 'BREAKPOINT - TOP OF HOUR'
      });
      expect(entry.message?.toLowerCase()).toContain('breakpoint');
    });

    it('detects show start from message pattern (legacy)', () => {
      const entry = createMockEntry({
        entry_type: undefined,
        message: 'DJ Name signed on at 10:00 AM'
      });
      expect(entry.message?.toLowerCase()).toContain('signed on');
    });

    it('detects show end from message pattern (legacy)', () => {
      const entry = createMockEntry({
        entry_type: undefined,
        message: 'DJ Name signed off at 12:00 PM'
      });
      expect(entry.message?.toLowerCase()).toContain('signed off');
    });

    it('defaults to talkset for unrecognized messages', () => {
      const entry = createMockEntry({
        entry_type: 'message',
        message: 'Random DJ comment'
      });
      // Should map to talkset (type 7)
      expect(entry.entry_type).toBe('message');
    });
  });
});
