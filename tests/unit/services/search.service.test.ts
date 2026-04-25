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

const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  play_date: new Date('2024-06-15T14:30:00Z'),
  artist_name: 'Autechre',
  track_title: 'VI Scose Poise',
  album_title: 'Confield',
  record_label: 'Warp',
  show_id: 100,
  dj_name: 'DJ Test',
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
});

describe('cursor codec', () => {
  describe('parseCursor', () => {
    it('parses a valid cursor', () => {
      expect(parseCursor('2024-06-15T14:30:00.000Z_12345')).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 12345,
      });
    });

    it('handles cursors that contain underscores in the timestamp segment', () => {
      // ISO timestamps do not contain underscores, but underscores at the
      // end of the timestamp would still split correctly because we use the
      // last underscore as the separator.
      expect(parseCursor('2024-06-15T14:30:00.000Z_999')).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 999,
      });
    });

    it.each([
      ['', 'empty string'],
      ['no-underscore', 'no separator'],
      ['_42', 'empty addTime'],
      ['2024-06-15T14:30:00.000Z_', 'empty id'],
      ['2024-06-15T14:30:00.000Z_abc', 'non-numeric id'],
      ['not-a-date_42', 'unparseable date'],
    ])('returns null for %j (%s)', (cursor) => {
      expect(parseCursor(cursor)).toBeNull();
    });
  });

  describe('encodeCursor', () => {
    it('round-trips with parseCursor', () => {
      const cursor = encodeCursor('2024-06-15T14:30:00.000Z', 12345);
      expect(parseCursor(cursor)).toEqual({
        addTime: '2024-06-15T14:30:00.000Z',
        id: 12345,
      });
    });
  });
});

describe('searchFlowsheet cursor pagination', () => {
  it('returns nextCursor when results fill the page and cursor mode is active', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ...makeRow({ id: 100 - i, play_date: new Date(`2024-06-15T${String(i % 24).padStart(2, '0')}:00:00Z`) }),
    }));
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
    const lastRow = result.results[49];
    expect(result.nextCursor).toBe(encodeCursor(lastRow.play_date, lastRow.id));
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

  it('omits nextCursor when cursor is not provided (offset mode)', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ id: i + 1 }));
    mockDataAndCount(rows, 1000);

    const result = await searchFlowsheet({
      q: '',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
    });

    expect(result.nextCursor).toBeUndefined();
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
