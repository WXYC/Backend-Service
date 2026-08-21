/**
 * Row-mapping behaviour for `getOpenShows` (BS#2235) — the `is_current` /
 * `likely_abandoned` decision and the DJ-name chain. The rendered SQL is pinned
 * separately in `flowsheet.getOpenShows.sql.test.ts`.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';
import {
  getOpenShows,
  LIKELY_ABANDONED_ENTRY_THRESHOLD,
  OPEN_SHOWS_DEFAULT_WINDOW_HOURS,
} from '../../../apps/backend/services/flowsheet.service';

type Row = Record<string, unknown>;

/**
 * `getOpenShows` fires three reads concurrently through `Promise.all`, so the
 * `db.select` mock is primed positionally in call order: the grouped open-shows
 * query, the older-than-window count, then `getLatestShow`'s `getNShows`.
 */
const primeReads = (rows: Row[], olderCount: number, latestShowId: number | null) => {
  const openShows = createMockQueryChain();
  openShows.orderBy.mockResolvedValue(rows);
  db.select.mockReturnValueOnce(openShows);

  const older = createMockQueryChain();
  older.where.mockResolvedValue([{ n: olderCount }]);
  db.select.mockReturnValueOnce(older);

  const latest = createMockQueryChain();
  latest.limit.mockResolvedValue(latestShowId === null ? [] : [{ id: latestShowId }]);
  db.select.mockReturnValueOnce(latest);

  return { openShows };
};

const row = (over: Row = {}): Row => ({
  id: 1,
  primary_dj_id: null,
  show_name: null,
  start_time: new Date('2026-08-14T12:00:00.000Z'),
  legacy_show_id: null,
  dj_name_override: null,
  legacy_dj_name: null,
  user_id: null,
  user_dj_name: null,
  entry_count: 0,
  ...over,
});

describe('getOpenShows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('flags a low-entry non-current show as likely abandoned', async () => {
    primeReads([row({ id: 74840, entry_count: 0 })], 0, 1951168);

    const { shows } = await getOpenShows();

    expect(shows[0]).toMatchObject({ id: 74840, entry_count: 0, is_current: false, likely_abandoned: true });
  });

  /**
   * The load-bearing exclusion. A DJ who signed on two minutes ago has one or
   * two entries and is emphatically not abandoned — flagging the live show as a
   * close candidate is how an operator ends a broadcast in progress. `is_current`
   * resolves against `getLatestShow`'s `max(shows.id)`, the same pivot every
   * on-air read uses, so this endpoint and the banner cannot disagree.
   */
  it('never flags the current show, however few entries it has', async () => {
    primeReads([row({ id: 1951168, entry_count: 1 })], 0, 1951168);

    const { shows } = await getOpenShows();

    expect(shows[0]).toMatchObject({ id: 1951168, is_current: true, likely_abandoned: false });
  });

  it('does not flag a non-current show at or above the entry threshold', async () => {
    primeReads(
      [
        row({ id: 10, entry_count: LIKELY_ABANDONED_ENTRY_THRESHOLD - 1 }),
        row({ id: 11, entry_count: LIKELY_ABANDONED_ENTRY_THRESHOLD }),
      ],
      0,
      99
    );

    const { shows } = await getOpenShows();

    expect(shows.map((s) => s.likely_abandoned)).toEqual([true, false]);
  });

  it('treats every show as non-current when nothing is open at all', async () => {
    primeReads([row({ id: 7, entry_count: 1 })], 0, null);

    const { shows } = await getOpenShows();

    expect(shows[0]).toMatchObject({ is_current: false, likely_abandoned: true });
  });

  it('resolves the DJ handle through the shared chain: override beats the user row', async () => {
    primeReads(
      [
        row({
          primary_dj_id: 'dj-1',
          user_id: 'dj-1',
          user_dj_name: 'DJ Night Owl',
          dj_name_override: 'Aubrey Hearst',
        }),
      ],
      0,
      99
    );

    const { shows } = await getOpenShows();

    expect(shows[0].dj_name).toBe('Aubrey Hearst');
  });

  it('falls back to legacy_dj_name for a show with no linked account', async () => {
    // The shape of the entire historical cohort: primary_dj_id NULL, identity
    // carried by the tubafrenzy handle.
    primeReads([row({ primary_dj_id: null, legacy_dj_name: 'DJ Mouseness' })], 0, 99);

    const { shows } = await getOpenShows();

    expect(shows[0].dj_name).toBe('DJ Mouseness');
  });

  it('reports the count of open shows older than the window without listing them', async () => {
    primeReads([row({ id: 1951168, entry_count: 11 })], 2813, 1951168);

    const result = await getOpenShows();

    // Production on 2026-08-21: 2,814 open shows, one of them inside a 7-day
    // window. Listing the other 2,813 would bury the actionable one.
    expect(result.shows).toHaveLength(1);
    expect(result.older_open_show_count).toBe(2813);
  });

  it('defaults the window to a week', () => {
    expect(OPEN_SHOWS_DEFAULT_WINDOW_HOURS).toBe(24 * 7);
  });
});
