/**
 * Row-mapping behaviour for `getRecentShows` (BS#2435) — the handoff read that
 * answers "who had the room before me". The rendered SQL is pinned separately
 * in `flowsheet.getRecentShows.sql.test.ts`.
 *
 * The property under test throughout is that the DJ list comes from the SAME
 * decision `GET /flowsheet/djs-on-air` applies (`composeShowDJList`), so the
 * two endpoints cannot disagree about a show they both report on.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';
import { getRecentShows } from '../../../apps/backend/services/flowsheet.service';

type Row = Record<string, unknown>;

/**
 * `getRecentShows` runs two statements in sequence: the bounded `shows` page,
 * then one `show_djs` read for the whole page. The `db.select` mock is primed
 * positionally in that order. The membership read is only issued when the page
 * is non-empty, so it is queued only then — an unconsumed `mockReturnValueOnce`
 * survives `jest.clearAllMocks()` and leaks into the next test.
 */
const primeReads = ({ rows = [], members = [] }: { rows?: Row[]; members?: Row[] } = {}) => {
  const page = createMockQueryChain();
  page.limit.mockResolvedValue(rows);
  db.select.mockReturnValueOnce(page);

  if (rows.length > 0) {
    const membership = createMockQueryChain();
    membership.orderBy.mockResolvedValue(members);
    db.select.mockReturnValueOnce(membership);
  }
};

const row = (over: Row = {}): Row => ({
  id: 1,
  show_name: null,
  start_time: new Date('2026-09-14T22:00:00.000Z'),
  end_time: new Date('2026-09-15T00:00:00.000Z'),
  dj_name_override: null,
  legacy_dj_name: null,
  primary_dj_id: null,
  user_id: null,
  user_dj_name: null,
  ...over,
});

describe('getRecentShows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns nothing, and asks nothing about membership, when the window is empty', async () => {
    primeReads({ rows: [] });

    const { shows } = await getRecentShows();

    expect(shows).toEqual([]);
    // One statement, not two: `inArray(col, [])` compiles to a literal `false`,
    // so a membership read over an empty page is a round trip that cannot
    // return a row (the same reason `getDJsInShow` short-circuits).
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('carries each show its start and end times', async () => {
    primeReads({
      rows: [
        row({
          id: 42,
          show_name: 'Backwards Bicycle',
          start_time: new Date('2026-09-14T22:00:00.000Z'),
          end_time: new Date('2026-09-15T00:00:00.000Z'),
        }),
      ],
    });

    const { shows } = await getRecentShows();

    expect(shows[0]).toMatchObject({
      id: 42,
      show_name: 'Backwards Bicycle',
      start_time: new Date('2026-09-14T22:00:00.000Z'),
      end_time: new Date('2026-09-15T00:00:00.000Z'),
    });
  });

  /**
   * A still-open show is the ordinary case for the newest row in the window —
   * the DJ who is on right now. `end_time` is null rather than absent.
   */
  it('reports an open show with a null end_time rather than dropping it', async () => {
    primeReads({ rows: [row({ id: 7, end_time: null })] });

    const { shows } = await getRecentShows();

    expect(shows[0]).toMatchObject({ id: 7, end_time: null });
  });

  it('preserves the newest-first order the query produced', async () => {
    primeReads({
      rows: [
        row({ id: 3, start_time: new Date('2026-09-15T02:00:00.000Z') }),
        row({ id: 2, start_time: new Date('2026-09-15T00:00:00.000Z') }),
        row({ id: 1, start_time: new Date('2026-09-14T22:00:00.000Z') }),
      ],
    });

    const { shows } = await getRecentShows();

    expect(shows.map((s) => s.id)).toEqual([3, 2, 1]);
  });

  it('groups every active account DJ onto their own show', async () => {
    primeReads({
      rows: [row({ id: 10 }), row({ id: 11 })],
      members: [
        { show_id: 10, id: 'dj-a', djName: 'DJ Mouseness' },
        { show_id: 10, id: 'dj-b', djName: 'dj meowww' },
        { show_id: 11, id: 'dj-c', djName: 'El Vaquero' },
      ],
    });

    const { shows } = await getRecentShows();

    expect(shows[0].djs).toEqual([
      { id: 'dj-a', dj_name: 'DJ Mouseness' },
      { id: 'dj-b', dj_name: 'dj meowww' },
    ]);
    expect(shows[1].djs).toEqual([{ id: 'dj-c', dj_name: 'El Vaquero' }]);
  });

  /**
   * The cohort the ticket names explicitly: a tubafrenzy-mirrored show has no
   * `show_djs` rows at all, and its identity lives on `shows.legacy_dj_name`.
   * Dropping it — or reporting it as DJ-less — is the "Off Air while a human DJ
   * is live" bug (BS#1547) on a historical surface.
   */
  it('names a legacy show from legacy_dj_name, with a null id', async () => {
    primeReads({ rows: [row({ id: 20, primary_dj_id: null, legacy_dj_name: 'DJ Flounder' })] });

    const { shows } = await getRecentShows();

    expect(shows[0].djs).toEqual([{ id: null, dj_name: 'DJ Flounder' }]);
  });

  it('prefers a per-show override over the linked account handle', async () => {
    primeReads({
      rows: [
        row({
          id: 21,
          primary_dj_id: 'dj-1',
          user_id: 'dj-1',
          user_dj_name: 'DJ Night Owl',
          dj_name_override: 'Aubrey Hearst',
        }),
      ],
      // No `show_djs` row, so the show-level chain is what answers.
      members: [],
    });

    const { shows } = await getRecentShows();

    expect(shows[0].djs).toEqual([{ id: null, dj_name: 'Aubrey Hearst' }]);
  });

  /**
   * Degrade visibly, not blank. A show whose handle resolves to nothing keeps
   * its row — with its times, and an empty DJ list a consumer can render as
   * "unknown" — rather than vanishing from the handoff list or carrying an
   * empty string that renders as a blank cell.
   */
  it('keeps a show whose handle is unresolvable, with an empty DJ list', async () => {
    primeReads({ rows: [row({ id: 22, primary_dj_id: null, legacy_dj_name: null })] });

    const { shows } = await getRecentShows();

    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({ id: 22, djs: [] });
  });

  /**
   * The same degradation one level down: an account row whose handle is the
   * literal "Anonymous" is filtered by `resolveDjDisplayName` to `null`, and
   * `djs-on-air` has always reported that as `dj_name: null` against a real
   * `id`. Preserved here byte-for-byte rather than dropped or blanked.
   */
  it('reports a null dj_name for an account DJ whose handle filters away', async () => {
    primeReads({
      rows: [row({ id: 23 })],
      members: [{ show_id: 23, id: 'dj-anon', djName: 'Anonymous' }],
    });

    const { shows } = await getRecentShows();

    expect(shows[0].djs).toEqual([{ id: 'dj-anon', dj_name: null }]);
  });

  /**
   * `djs-on-air` prefers account rows whenever the show has any, and only then
   * falls back to the legacy handle. A show carrying both must resolve the same
   * way here, or the two endpoints name different people for one show.
   */
  it('prefers account rows over legacy_dj_name when a show carries both', async () => {
    primeReads({
      rows: [row({ id: 24, legacy_dj_name: 'DJ Mouseness' })],
      members: [{ show_id: 24, id: 'dj-a', djName: 'dj meowww' }],
    });

    const { shows } = await getRecentShows();

    expect(shows[0].djs).toEqual([{ id: 'dj-a', dj_name: 'dj meowww' }]);
  });
});
