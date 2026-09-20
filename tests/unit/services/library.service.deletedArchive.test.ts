/**
 * Service-level unit tests for `GET /library/deleted`'s two read helpers
 * (BS#2561 / F2a review finding 2). Before this file, `getDeletedArchivePage`
 * and `countDeletedArchiveBatches` had zero unit coverage: the only test that
 * touched them was `tests/unit/controllers/library.deletedArchive.test.ts`,
 * which mocks the whole service and therefore asserts nothing about the
 * query these functions actually build.
 *
 * Worst of it: the `captured_at` ordering tiebreak (`desc(max(id))`) that
 * keeps paging stable when two snapshots share a `captured_at` — the common
 * case, since a batch's rows are written in one transaction and two deletes
 * in the same second collide too — was untested at every level. It is
 * covered directly here, against the ORDER BY clause the query builder
 * emits (see the first `describe` block below for why that is the right
 * level for a mocked-DB unit test).
 *
 * Follows the `db.select.mockReturnValueOnce(...)` two-statement priming
 * convention from `flowsheet.getRecentShows.test.ts`: `getDeletedArchivePage`
 * issues the batch-page aggregate SELECT first (terminal `.offset()`), then —
 * only when that page is non-empty — a second SELECT for the full rows
 * belonging to that page's batch ids (terminal `.where()`).
 * `parseCapturedEnvelope`/`orderBatchEntities` are IDENTITY mocks in
 * `tests/mocks/database.mock.ts` (real behavior is pinned separately in
 * `tests/unit/database/catalog-delete-envelope.test.ts`), so a fixture row's
 * `captured` must already be envelope-shaped
 * (`{ entity: { table, row }, children }`) and `rowsByBatch` ordering is
 * exactly whatever order the fixture rows are handed in.
 */
import { jest } from '@jest/globals';
import { desc, inArray, sql } from 'drizzle-orm';
import { db, createMockQueryChain, catalog_delete_snapshot } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';
import { getDeletedArchivePage, countDeletedArchiveBatches } from '../../../apps/backend/services/library.service';

type Row = Record<string, unknown>;

const snapshotRow = (over: Row = {}): Row => ({
  id: 1,
  batch_id: 'batch-1',
  entity_kind: 'library',
  entity_id: 42,
  captured: {
    entity: { table: 'library', row: { id: 42, album_title: 'On Your Own Love Again' } },
    children: { bins: [{ id: 1 }], reviews: [] },
  },
  captured_at: new Date('2026-09-10T12:00:00Z'),
  actor_user_id: 'librarian-1',
  actor_email: 'md@wxyc.org',
  actor_role: 'musicDirector',
  ...over,
});

/**
 * Primes the (up to) two statements `getDeletedArchivePage` issues in
 * sequence: the batch-page aggregate (terminal `.offset()`), and — only when
 * that page is non-empty, matching the production early-return — the
 * full-row fetch for those batch ids (terminal `.where()`). Returns both
 * chains so a test can assert on either statement's call args.
 */
const primeReads = ({ batchPage = [], rows = [] }: { batchPage?: Row[]; rows?: Row[] } = {}) => {
  const page = createMockQueryChain();
  page.offset.mockResolvedValue(batchPage);
  db.select.mockReturnValueOnce(page);

  let childRows: ReturnType<typeof createMockQueryChain> | undefined;
  if (batchPage.length > 0) {
    childRows = createMockQueryChain();
    childRows.where.mockResolvedValue(rows);
    db.select.mockReturnValueOnce(childRows);
  }
  return { page, childRows };
};

describe('getDeletedArchivePage (BS#2561 / F2a)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // A mocked DB cannot exercise Postgres's actual sort — what a unit test
  // CAN and must pin is that the ORDER BY clause the query builder emits
  // carries both criteria, in priority order. Delete the second `desc(...)`
  // (the tiebreak) and this call's argument COUNT changes from two to one:
  // `toHaveBeenCalledWith(a, b)` fails on arity, not just content, so this
  // test goes red the moment the tiebreak is removed.
  it('orders newest batch first, tiebreaking equal captured_at by descending max id', async () => {
    const { page } = primeReads({ batchPage: [] });

    await getDeletedArchivePage(0, 50);

    expect(page.orderBy).toHaveBeenCalledWith(
      desc(sql`max(${catalog_delete_snapshot.captured_at})`),
      desc(sql`max(${catalog_delete_snapshot.id})`)
    );
  });

  describe('paging boundary', () => {
    it('bounds the batch-page query with the requested page and limit', async () => {
      const { page } = primeReads({ batchPage: [] });

      await getDeletedArchivePage(2, 25);

      expect(page.limit).toHaveBeenCalledWith(25);
      // offset = page * limit
      expect(page.offset).toHaveBeenCalledWith(50);
    });

    it('never issues the full-row read when the batch page is empty, and answers []', async () => {
      primeReads({ batchPage: [] });

      const result = await getDeletedArchivePage(0, 50);

      expect(result).toEqual([]);
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    // The two-query design exists precisely so a page boundary can never
    // split one batch's rows across two pages: the second query is scoped
    // to ONLY the batch ids the first query's page returned, never "every
    // batch id at or after this page". This is what a unit test can pin
    // about that guarantee without a real DB.
    it("scopes the full-row read to exactly the current page's batch ids", async () => {
      const rowA = snapshotRow({ id: 1, batch_id: 'batch-a' });
      const rowB = snapshotRow({ id: 2, batch_id: 'batch-b' });
      const { childRows } = primeReads({
        batchPage: [
          { batch_id: 'batch-a', captured_at: rowA.captured_at },
          { batch_id: 'batch-b', captured_at: rowB.captured_at },
        ],
        rows: [rowA, rowB],
      });

      await getDeletedArchivePage(0, 50);

      expect(db.select).toHaveBeenCalledTimes(2);
      expect(childRows?.where).toHaveBeenCalledWith(inArray(catalog_delete_snapshot.batch_id, ['batch-a', 'batch-b']));
    });
  });

  describe('search predicate', () => {
    it('applies no predicate when search is omitted', async () => {
      const { page } = primeReads({ batchPage: [] });

      await getDeletedArchivePage(0, 50);

      expect(page.where).toHaveBeenCalledWith(undefined);
    });

    // Substring (ILIKE), not the field-scoped `artist:`/`album:` syntax
    // `GET /library/query`'s `q` parses — OR-joined across the three name
    // fields on the captured entity's row, with LIKE metacharacters escaped
    // so a literal `%`/`_` in a librarian's search cannot widen the match.
    it('OR-joins an escaped ILIKE substring match over the three captured name fields', async () => {
      const { page } = primeReads({ batchPage: [] });

      await getDeletedArchivePage(0, 50, '50% Off_Sale');

      const condition = page.where.mock.calls[0]?.[0];
      const rendered = renderSql(condition);

      expect(rendered.match(/ILIKE/g)).toHaveLength(3);
      expect(rendered).toContain(' OR ');
      expect(rendered).toContain('album_title');
      expect(rendered).toContain('artist_name');
      expect(rendered).toContain('alternate_artist_name');
      // The raw term's `%`/`_` are backslash-escaped before being wrapped in
      // the `%...%` substring wildcard.
      expect(rendered).toContain('%50\\% Off\\_Sale%');
    });
  });

  // Beyond F2a review finding 2's three named gaps: pins that the F2a
  // review finding 1 projection (children as counts, not rows) is what this
  // service function actually returns, and that the entity's own row is
  // left untouched.
  it('projects each child list to its count, and leaves the deleted parent row untouched', async () => {
    const captured = {
      entity: { table: 'library', row: { id: 42, album_title: 'On Your Own Love Again' } },
      children: { bins: [{ id: 1 }, { id: 2 }], reviews: [] },
    };
    const fixture = snapshotRow({ captured });
    primeReads({
      batchPage: [{ batch_id: 'batch-1', captured_at: fixture.captured_at }],
      rows: [fixture],
    });

    const [batch] = await getDeletedArchivePage(0, 50);

    expect(batch.entities[0].row).toEqual({ id: 42, album_title: 'On Your Own Love Again' });
    expect(batch.entities[0].children).toEqual({ bins: 2, reviews: 0 });
  });

  // The snapshot row carries `actor_email` — the capture stores it so a
  // restore can attribute the delete — and the projection deliberately drops
  // it, because `docs/pii.md` does not list an archive listing among the
  // permitted read sites for a PII email. Asserted as an ABSENCE rather than
  // simply left unasserted: without this, a projection that started echoing
  // the address would pass every other test in this file, and there is no
  // lint rule or sentinel scoped to `email` that would catch it either.
  it('does not project the actor email, though the snapshot row carries one', async () => {
    const fixture = snapshotRow({});
    primeReads({
      batchPage: [{ batch_id: 'batch-1', captured_at: fixture.captured_at }],
      rows: [fixture],
    });

    const [batch] = await getDeletedArchivePage(0, 50);

    expect(fixture.actor_email).toBe('md@wxyc.org');
    expect(batch.actor).toEqual({ user_id: 'librarian-1', role: 'musicDirector' });
    expect(batch.actor).not.toHaveProperty('email');
  });

  // `unrecoverable` was one constant attached to every batch, which was only
  // ever right while every batch was a release. An artist batch got handed the
  // five RELEASE tables -- none of which an artist delete touches -- and
  // nothing about the five it does, which is precisely the lossless-restore
  // promise the field exists to avoid making. The restore consumer is the
  // reader that would act on it.
  //
  // `unrecoverableDependentsForKinds` is the one envelope export
  // `database.mock.ts` forwards to the real implementation, so these assert
  // the routing rather than a stub (see that comment).
  it('gives an artist batch the artist dependents, not the release ones', async () => {
    const fixture = snapshotRow({
      entity_kind: 'artist',
      entity_id: 4211,
      captured: {
        entity: { table: 'artists', row: { id: 4211, artist_name: 'Chuquimamani-Condori' } },
        children: { genre_artist_crossreference: [{ genre_id: 11 }], compilation_track_artist: [] },
      },
    });
    primeReads({
      batchPage: [{ batch_id: 'batch-1', captured_at: fixture.captured_at }],
      rows: [fixture],
    });

    const [batch] = await getDeletedArchivePage(0, 50);

    expect([...batch.unrecoverable].sort()).toEqual(
      ['artist_search_alias', 'artist_similar_artists', 'artist_station_plays', 'concerts', 'concert_performers'].sort()
    );
    expect(batch.unrecoverable).not.toContain('album_metadata');
    expect(batch.unrecoverable).not.toContain('album_review_submissions');
    // No replay plan exists for `artist` (BS#2616) -- the listing must not
    // promise a restore the endpoint will refuse.
    expect(batch.restorable).toBe(false);
  });

  it('still gives a release batch the release dependents', async () => {
    const fixture = snapshotRow({});
    primeReads({
      batchPage: [{ batch_id: 'batch-1', captured_at: fixture.captured_at }],
      rows: [fixture],
    });

    const [batch] = await getDeletedArchivePage(0, 50);

    expect(batch.unrecoverable).toContain('album_metadata');
    expect(batch.unrecoverable).toContain('album_review_submissions');
    expect(batch.unrecoverable).not.toContain('artist_similar_artists');
    expect(batch.restorable).toBe(true);
  });

  // BS#2616 follow-up review finding 6: `[].every(...)` is vacuously true, so
  // a batch id the page query grouped but whose full-row read came back empty
  // (the `rowsByBatch.get(batch_id) ?? []` fallback) used to report
  // `restorable: true` on zero entities -- the opposite of this field's
  // conservative default.
  it('reports a batch as not restorable when its rows read back empty, rather than defaulting true', async () => {
    const captured_at = new Date('2026-09-10T12:00:00Z');
    primeReads({
      batchPage: [{ batch_id: 'batch-empty', captured_at }],
      rows: [], // the full-row read found nothing for this batch id
    });

    const [batch] = await getDeletedArchivePage(0, 50);

    expect(batch.entities).toEqual([]);
    expect(batch.restorable).toBe(false);
  });

  // BS#2616 follow-up review finding 7: `restorable` was decided on
  // `entity_kind` alone, so a `library` batch whose captured envelope is
  // corrupt (the same `entity.row === null` shape the restore endpoint's
  // `!plan || !envelope.entity.row` branch 500s on -- see
  // `tests/integration/library-restore-deleted.spec.js`'s tamper test) still
  // listed as restorable, promising a restore the endpoint could not perform.
  it('reports a library batch as not restorable when its captured row is missing, not merely by entity_kind', async () => {
    const fixture = snapshotRow({
      captured: { entity: { table: 'library', row: null }, children: {} },
    });
    primeReads({
      batchPage: [{ batch_id: 'batch-1', captured_at: fixture.captured_at }],
      rows: [fixture],
    });

    const [batch] = await getDeletedArchivePage(0, 50);

    expect(batch.entities[0].row).toBeNull();
    expect(batch.restorable).toBe(false);
  });
});

describe('countDeletedArchiveBatches (BS#2561 / F2a)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('answers 0 for an empty archive, with no predicate when search is omitted', async () => {
    const chain = createMockQueryChain();
    chain.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(chain);

    const total = await countDeletedArchiveBatches();

    expect(total).toBe(0);
    expect(chain.where).toHaveBeenCalledWith(undefined);
  });

  it('scopes the count by the same search predicate as the page read', async () => {
    const chain = createMockQueryChain();
    chain.where.mockResolvedValue([{ count: 3 }]);
    db.select.mockReturnValueOnce(chain);

    const total = await countDeletedArchiveBatches('pratt');

    expect(total).toBe(3);
    const rendered = renderSql(chain.where.mock.calls[0]?.[0]);
    expect(rendered.match(/ILIKE/g)).toHaveLength(3);
    expect(rendered).toContain('%pratt%');
  });
});
