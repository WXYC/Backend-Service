import { db } from '../../mocks/database.mock';

beforeEach(() => {
  jest.clearAllMocks();
});

import {
  searchFlowsheet,
  shouldUseTsvector,
  parseCursor,
  encodeCursor,
} from '../../../apps/backend/services/search.service';
import { CHARSET_TORTURE_ENTRIES, charsetEntryId } from '../../charset-torture';

const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  play_date: new Date('2024-06-15T14:30:00Z'),
  // The data query selects this alongside play_date; it is what nextCursor is
  // built from. See CURSOR_TIME_EXPR in search.service.ts.
  cursor_time: '2024-06-15T14:30:00.000000Z',
  artist_name: 'Autechre',
  track_title: 'VI Scose Poise',
  album_title: 'Confield',
  record_label: 'Warp',
  show_id: 100,
  dj_name: 'DJ Test',
  rotation_bin: 'H',
  request_flag: false,
  on_streaming: true,
  ...overrides,
});

const mockDataAndCount = (rows: ReturnType<typeof makeRow>[], total: number) => {
  (db.execute as jest.Mock).mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total }]);
};

describe('searchFlowsheet', () => {
  it('issues two parallel queries: data and count', async () => {
    mockDataAndCount([makeRow()], 1);

    await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('returns paginated results for a simple query', async () => {
    const rows = [makeRow(), makeRow({ id: 2, artist_name: 'Autolux' })];
    mockDataAndCount(rows, 2);

    const result = await searchFlowsheet({ q: 'aut', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('uses the count query result for total, not the data row count', async () => {
    // Page 0 returns 50 rows but the underlying match set is 100
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ id: i + 1 }));
    mockDataAndCount(rows, 100);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results).toHaveLength(50);
    expect(result.total).toBe(100);
  });

  it('returns empty results and zero total when no matches', async () => {
    mockDataAndCount([], 0);

    const result = await searchFlowsheet({ q: 'nonexistent', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('reports total from the count query even when the data page is empty', async () => {
    // User paginated past the end — data query returns nothing but count is real
    mockDataAndCount([], 100);

    const result = await searchFlowsheet({ q: 'autechre', page: 99, limit: 10, sort: 'date', order: 'desc' });

    expect(result.results).toEqual([]);
    expect(result.total).toBe(100);
  });

  it('handles field-prefixed queries', async () => {
    mockDataAndCount([makeRow()], 1);

    const result = await searchFlowsheet({
      q: 'artist:autechre',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].artist_name).toBe('Autechre');
  });

  it('handles a dj-name filter without errors', async () => {
    mockDataAndCount([makeRow({ dj_name: 'jake' })], 1);

    const result = await searchFlowsheet({
      q: 'dj:jake',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].dj_name).toBe('jake');
  });

  it('handles a dj-name filter with exact match without errors', async () => {
    mockDataAndCount([makeRow({ dj_name: 'jake' })], 1);

    const result = await searchFlowsheet({
      q: 'dj:"jake"',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].dj_name).toBe('jake');
  });

  it('formats play_date as ISO string', async () => {
    const date = new Date('2024-06-15T14:30:00Z');
    mockDataAndCount([makeRow({ play_date: date })], 1);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].play_date).toBe(date.toISOString());
  });

  it('coerces null dj_name to empty string', async () => {
    mockDataAndCount([makeRow({ dj_name: null })], 1);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].dj_name).toBe('');
  });

  it('coerces null text fields to empty strings', async () => {
    mockDataAndCount(
      [
        makeRow({
          artist_name: null,
          track_title: null,
          album_title: null,
          record_label: null,
        }),
      ],
      1
    );

    const result = await searchFlowsheet({ q: 'test', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].artist_name).toBe('');
    expect(result.results[0].track_title).toBe('');
    expect(result.results[0].album_title).toBe('');
    expect(result.results[0].record_label).toBe('');
  });

  it('passes through rotation_bin, request_flag and on_streaming (BS#2699)', async () => {
    mockDataAndCount([makeRow({ rotation_bin: 'M', request_flag: true, on_streaming: false })], 1);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].rotation_bin).toBe('M');
    expect(result.results[0].request_flag).toBe(true);
    expect(result.results[0].on_streaming).toBe(false);
  });

  it('coerces a null rotation_bin to null, not an empty string (BS#2699)', async () => {
    mockDataAndCount([makeRow({ rotation_bin: null })], 1);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].rotation_bin).toBeNull();
  });

  it('preserves a null on_streaming rather than coercing to false (BS#2699)', async () => {
    // null means "no linked library row"; only an explicit false is a known
    // negative. Matches transformToV2 in flowsheet.service.ts.
    mockDataAndCount([makeRow({ on_streaming: null })], 1);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].on_streaming).toBeNull();
  });
});

describe('shouldUseTsvector', () => {
  describe('routes to tsvector for well-tokenized queries', () => {
    it.each([
      ['autechre'],
      ['the'],
      ['Sigur Rós'],
      ['Belle & Sebastian'],
      ['Godspeed You! Black Emperor'],
      ['M.A.N.D.Y.'],
      ['a&b'],
      ['123'],
      ['Mac DeMarco'],
      ['Jessica Pratt'],
    ])('uses tsvector for %j', (value) => {
      expect(shouldUseTsvector(value)).toBe(true);
    });
  });

  describe('falls back to trigram for unsuitable queries', () => {
    it.each([
      ['', 'empty'],
      ['a', 'single character'],
      ['au', 'two characters (under tsvector min)'],
      ['!!!', 'pure punctuation'],
      ['$$$', 'pure punctuation'],
      ['...', 'pure punctuation'],
      ['   ', 'whitespace only'],
    ])('uses trigram for %j (%s)', (value) => {
      expect(shouldUseTsvector(value)).toBe(false);
    });
  });

  // WXYC/Backend-Service#2739: pin the ASCII-only decision (option (a) — see
  // this function's docstring) against every charset-torture entry whose
  // ONLY letters/digits are non-Latin (i.e. an entry `/[a-zA-Z0-9]/` cannot
  // see at all). `shouldUseTsvector` must route every one of those to the
  // trigram branch. This is a routing pin, not a recall claim:
  // the docstring records — and PG 18.6 confirms — that the tsvector path
  // *could* tokenize several of these scripts; the point here is that this
  // function does not currently route them there, and a change to
  // `/[\p{L}\p{N}]/u` (matching `hasAlphanumeric`) must fail this table.
  // Entries shorter than three characters stay on trigram under either regex
  // (the length floor), so only the longer ones detect that swap.
  describe('routes every no-ASCII-alphanumeric charset-torture entry to trigram (BS#2739, decision (a))', () => {
    // Recomputed from the fixture, not copied from the issue — the issue's
    // count (33 of 57) is a snapshot, this filter is the source of truth.
    // `null\u0000byte` (the `quoting` category's NUL-byte entry) is excluded
    // by this same filter because it contains ASCII letters ("null", "byte")
    // — it is not part of the no-ASCII-alphanumeric cohort this table pins,
    // and this test never writes it to Postgres (which cannot store a NUL
    // byte in `text`), since `shouldUseTsvector` is a pure string predicate.
    const noAsciiAlphanumericEntries = CHARSET_TORTURE_ENTRIES.filter((e) => !/[a-zA-Z0-9]/.test(e.input));

    it('the corpus has at least one qualifying entry (the table below is not vacuous)', () => {
      expect(noAsciiAlphanumericEntries.length).toBeGreaterThan(0);
    });

    it.each(noAsciiAlphanumericEntries.map((entry) => [charsetEntryId(entry), entry] as const))(
      'uses trigram for %s (no ASCII alphanumeric)',
      (_id, entry) => {
        expect(shouldUseTsvector(entry.input)).toBe(false);
      }
    );
  });
});

describe('cursor codec', () => {
  describe('parseCursor', () => {
    it('parses a valid cursor, defaulting to the word tier when unmarked', () => {
      expect(parseCursor('2024-06-15T14:30:00.000Z_12345')).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 12345,
        tier: 'word',
      });
    });

    it('handles cursors that contain underscores in the timestamp segment', () => {
      // ISO timestamps do not contain underscores, but underscores at the
      // end of the timestamp would still split correctly because we use the
      // last underscore as the separator.
      expect(parseCursor('2024-06-15T14:30:00.000Z_999')).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 999,
        tier: 'word',
      });
    });

    it.each([
      ['', 'empty string'],
      ['no-underscore', 'no separator'],
      ['_42', 'empty addTime'],
      ['2024-06-15T14:30:00.000Z_', 'empty id'],
      ['2024-06-15T14:30:00.000Z_abc', 'non-numeric id'],
      ['not-a-date_42', 'unparseable date'],
      ['2024-06-15T14:30:00.000Z_12345_sub_sub', 'doubled _sub marker'],
      ['2024-06-15T14:30:00.000Z_12345_pfx_sub', 'mixed _pfx and _sub markers'],
      ['2024-06-15T14:30:00.000Z_12345_SUB', 'uppercase marker (case-sensitive)'],
    ])('returns null for %j (%s)', (cursor) => {
      expect(parseCursor(cursor)).toBeNull();
    });
  });

  describe('encodeCursor', () => {
    it('round-trips with parseCursor on the word tier (no marker)', () => {
      const cursor = encodeCursor('2024-06-15T14:30:00.000Z', 12345, 'word');
      expect(parseCursor(cursor)).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 12345,
        tier: 'word',
      });
    });

    it('round-trips with parseCursor on the prefix tier (_pfx marker)', () => {
      const cursor = encodeCursor('2024-06-15T14:30:00.000Z', 12345, 'prefix');
      expect(cursor).toBe('2024-06-15T14:30:00.000Z_12345_pfx');
      expect(parseCursor(cursor)).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 12345,
        tier: 'prefix',
      });
    });

    it('round-trips with parseCursor on the substring tier (_sub marker)', () => {
      const cursor = encodeCursor('2024-06-15T14:30:00.000Z', 12345, 'substring');
      expect(cursor).toBe('2024-06-15T14:30:00.000Z_12345_sub');
      expect(parseCursor(cursor)).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 12345,
        tier: 'substring',
      });
    });
  });
});

describe('searchFlowsheet cursor pagination', () => {
  it('returns nextCursor when results fill the page and cursor mode is active', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => {
      const hour = String(i % 24).padStart(2, '0');
      return makeRow({
        id: 100 - i,
        play_date: new Date(`2024-06-15T${hour}:00:00Z`),
        cursor_time: `2024-06-15T${hour}:00:00.000000Z`,
      });
    });
    mockDataAndCount(rows, 1000);

    const result = await searchFlowsheet({
      q: '',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: '2024-06-16T00:00:00.000Z_999',
    });

    expect(result.results).toHaveLength(50);
    expect(result.nextCursor).toBe(encodeCursor(rows[49].cursor_time, rows[49].id, 'word'));
  });

  it('omits nextCursor when fewer rows are returned than requested', async () => {
    const rows = [makeRow({ id: 1 })];
    mockDataAndCount(rows, 1);

    const result = await searchFlowsheet({
      q: '',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: '2024-06-16T00:00:00.000Z_999',
    });

    expect(result.nextCursor).toBeUndefined();
  });

  // BS#2344: a full page emits a cursor whether or not the request carried
  // one. This used to assert the opposite, which is the bug that capped
  // dj-site's Previous Sets archive at a single page — see
  // search.service.first-page-cursor.test.ts for the full coverage.
  it('returns nextCursor on a full first page even though no cursor was provided', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ id: i + 1 }));
    mockDataAndCount(rows, 1000);

    const result = await searchFlowsheet({
      q: '',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
    });

    expect(result.nextCursor).toBe(encodeCursor(rows[49].cursor_time, rows[49].id, 'word'));
  });

  it('omits nextCursor when sort is not date even if cursor is provided', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ id: i + 1 }));
    mockDataAndCount(rows, 1000);

    const result = await searchFlowsheet({
      q: '',
      page: 0,
      limit: 50,
      sort: 'artist',
      order: 'asc',
      cursor: '2024-06-16T00:00:00.000Z_999',
    });

    expect(result.nextCursor).toBeUndefined();
  });

  it('still returns total even in cursor mode (for backward-compat display)', async () => {
    const rows = [makeRow()];
    mockDataAndCount(rows, 7);

    const result = await searchFlowsheet({
      q: '',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
      cursor: '2024-06-16T00:00:00.000Z_999',
    });

    expect(result.total).toBe(7);
  });
});
