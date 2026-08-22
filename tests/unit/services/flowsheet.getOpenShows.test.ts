/**
 * Row-mapping behaviour for `getOpenShows` (BS#2235) — the `is_current` /
 * `likely_abandoned` decision and the DJ-name chain. The rendered SQL is pinned
 * separately in `flowsheet.getOpenShows.sql.test.ts`.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';
import { getOpenShows, LIKELY_ABANDONED_ENTRY_THRESHOLD } from '../../../apps/backend/services/flowsheet.service';

type Row = Record<string, unknown>;

/**
 * `getOpenShows` fires three reads concurrently through `Promise.all`, so the
 * `db.select` mock is primed positionally in call order: the grouped open-shows
 * query, the older-than-window count, then `getLatestShow`'s `getNShows`.
 */
/**
 * `getOpenShows` fires three reads concurrently through `Promise.all`, so the
 * `db.select` mock is primed positionally in call order: the open-shows page,
 * the one FILTERed count row, then `getLatestShow`'s `getNShows`. A fourth
 * (`isLatestEntryShowEnd`) follows only when the newest show is on the page.
 *
 * An options object rather than four positionals: `latestShowId` defaults to a
 * value no fixture row uses, so the common "nothing is current" case says
 * nothing at all instead of passing a bare sentinel.
 */
const NO_SHOW_IS_CURRENT = -1;

const primeReads = ({
  rows = [],
  olderCount = 0,
  latestShowId = NO_SHOW_IS_CURRENT,
  windowCount,
  latestEntryIsShowEnd = false,
}: {
  rows?: Row[];
  olderCount?: number;
  latestShowId?: number | null;
  windowCount?: number;
  latestEntryIsShowEnd?: boolean;
} = {}) => {
  // `buildOpenShowsQuery` builds two selects: the inner `shows` page (closed
  // with `.as('page')`) and the outer statement that joins and counts against
  // it. Both are constructed before anything awaits, so they take the first
  // two `db.select` slots in that order.
  const page = createMockQueryChain();
  db.select.mockReturnValueOnce(page);

  const openShows = createMockQueryChain();
  openShows.orderBy.mockResolvedValue(rows);
  db.select.mockReturnValueOnce(openShows);

  const counts = createMockQueryChain();
  counts.where.mockResolvedValue([{ in_window: windowCount ?? rows.length, older: olderCount }]);
  db.select.mockReturnValueOnce(counts);

  const latest = createMockQueryChain();
  latest.limit.mockResolvedValue(latestShowId === null ? [] : [{ id: latestShowId }]);
  db.select.mockReturnValueOnce(latest);

  // Queued ONLY when it will actually be consumed. `getOpenShows` reads the
  // terminal marker just for the newest show, and only when that show is on
  // the page — `mockReturnValueOnce` is a queue, so an unconsumed entry does
  // not vanish at `jest.clearAllMocks()` (that clears calls, not the queue).
  // It leaks into the next test and hands the inner page query a chain whose
  // `orderBy` resolves to rows, which fails on the following `.limit`.
  if (latestShowId !== null && rows.some((r) => r.id === latestShowId)) {
    const terminalMarker = createMockQueryChain();
    terminalMarker.limit.mockResolvedValue([{ entry_type: latestEntryIsShowEnd ? 'show_end' : 'track' }]);
    db.select.mockReturnValueOnce(terminalMarker);
  }

  return { page, openShows };
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
    primeReads({ rows: [row({ id: 74840, entry_count: 0 })], latestShowId: 1951168 });

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
    primeReads({ rows: [row({ id: 1951168, entry_count: 1 })], latestShowId: 1951168 });

    const { shows } = await getOpenShows();

    expect(shows[0]).toMatchObject({ id: 1951168, is_current: true, likely_abandoned: false });
  });

  it('does not flag a non-current show at or above the entry threshold', async () => {
    primeReads({
      rows: [
        row({ id: 10, entry_count: LIKELY_ABANDONED_ENTRY_THRESHOLD - 1 }),
        row({ id: 11, entry_count: LIKELY_ABANDONED_ENTRY_THRESHOLD }),
      ],
    });

    const { shows } = await getOpenShows();

    expect(shows.map((s) => s.likely_abandoned)).toEqual([true, false]);
  });

  it('treats every show as non-current when nothing is open at all', async () => {
    primeReads({ rows: [row({ id: 7, entry_count: 1 })], latestShowId: null });

    const { shows } = await getOpenShows();

    expect(shows[0]).toMatchObject({ is_current: false, likely_abandoned: true });
  });

  /**
   * BS#2068's correction, re-applied here. A show whose `show_end` marker
   * landed but whose `end_time` was never stamped keeps `max(shows.id)` while
   * being demonstrably over — a bare `id === max(id)` test reports it as live,
   * suppressing `likely_abandoned` on exactly the cohort this endpoint serves.
   */
  it('does not treat a max(id) show as current when its terminal entry is a show_end marker', async () => {
    primeReads({
      rows: [row({ id: 1951168, entry_count: 2 })],
      latestShowId: 1951168,
      latestEntryIsShowEnd: true,
    });

    const { shows } = await getOpenShows();

    expect(shows[0]).toMatchObject({ is_current: false, likely_abandoned: true });
  });

  it('resolves the DJ handle through the shared chain: override beats the user row', async () => {
    primeReads({
      rows: [
        row({
          primary_dj_id: 'dj-1',
          user_id: 'dj-1',
          user_dj_name: 'DJ Night Owl',
          dj_name_override: 'Aubrey Hearst',
        }),
      ],
    });

    const { shows } = await getOpenShows();

    expect(shows[0].dj_name).toBe('Aubrey Hearst');
  });

  it('falls back to legacy_dj_name for a show with no linked account', async () => {
    // The shape of the entire historical cohort: primary_dj_id NULL, identity
    // carried by the tubafrenzy handle.
    primeReads({ rows: [row({ primary_dj_id: null, legacy_dj_name: 'DJ Mouseness' })] });

    const { shows } = await getOpenShows();

    expect(shows[0].dj_name).toBe('DJ Mouseness');
  });

  it('reports the count of open shows older than the window without listing them', async () => {
    primeReads({ rows: [row({ id: 1951168, entry_count: 11 })], olderCount: 2813, latestShowId: 1951168 });

    const result = await getOpenShows();

    // Production on 2026-08-21: 2,814 open shows, one of them inside a 7-day
    // window. Listing the other 2,813 would bury the actionable one.
    expect(result.shows).toHaveLength(1);
    expect(result.older_open_show_count).toBe(2813);
  });

  /**
   * `total_in_window` is the only way a caller can tell a truncated page from a
   * complete one — without it, `limit` silently lies about how much is open.
   */
  it('reports total_in_window separately from the truncated page', async () => {
    primeReads({ rows: [row({ id: 1 }), row({ id: 2 })], windowCount: 57 });

    const result = await getOpenShows(168, 2);

    expect(result.shows).toHaveLength(2);
    expect(result.total_in_window).toBe(57);
  });
});
