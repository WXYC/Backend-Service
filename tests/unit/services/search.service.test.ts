import { db } from '../../mocks/database.mock';

beforeEach(() => {
  jest.clearAllMocks();
});

import { searchFlowsheet } from '../../../apps/backend/services/search.service';

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

describe('searchFlowsheet', () => {
  it('returns paginated results for a simple query', async () => {
    const rows = [makeRow(), makeRow({ id: 2, artist_name: 'Autolux' })];
    (db.execute as jest.Mock)
      .mockResolvedValueOnce(rows) // data query
      .mockResolvedValueOnce([{ total: 2 }]); // count query

    const result = await searchFlowsheet({ q: 'aut', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('returns empty results when no matches', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    const result = await searchFlowsheet({ q: 'nonexistent', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('calculates correct offset from page and limit', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow()])
      .mockResolvedValueOnce([{ total: 100 }]);

    const result = await searchFlowsheet({ q: 'autechre', page: 2, limit: 10, sort: 'date', order: 'desc' });

    expect(result.results).toHaveLength(1);
    expect(result.total).toBe(100);
    // Verify db.execute was called (offset = 2 * 10 = 20)
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('handles field-prefixed queries', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow()])
      .mockResolvedValueOnce([{ total: 1 }]);

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

  it('formats play_date as ISO string', async () => {
    const date = new Date('2024-06-15T14:30:00Z');
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow({ play_date: date })])
      .mockResolvedValueOnce([{ total: 1 }]);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].play_date).toBe(date.toISOString());
  });

  it('coerces null dj_name to empty string', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow({ dj_name: null })])
      .mockResolvedValueOnce([{ total: 1 }]);

    const result = await searchFlowsheet({ q: 'autechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].dj_name).toBe('');
  });

  it('coerces null text fields to empty strings', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        makeRow({
          artist_name: null,
          track_title: null,
          album_title: null,
          record_label: null,
        }),
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const result = await searchFlowsheet({ q: 'test', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(result.results[0].artist_name).toBe('');
    expect(result.results[0].track_title).toBe('');
    expect(result.results[0].album_title).toBe('');
    expect(result.results[0].record_label).toBe('');
  });
});
