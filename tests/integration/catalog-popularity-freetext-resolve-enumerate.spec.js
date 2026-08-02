/**
 * Integration test for the catalog-popularity-freetext-resolve ENUMERATE
 * representative-track selection (BS#1767), against real PostgreSQL.
 *
 * The unit suite (tests/unit/database/freetext-enumerate.test.ts) imports the
 * REAL `enumerateFreetextPairs` and pins the exact GROUP BY + DISTINCT ON +
 * ORDER BY it emits (so flipping an ASC/DESC, dropping the btrim non-empty-
 * first term, or changing the GROUP BY fails there). This spec validates
 * that pinned SQL's *runtime semantics* against real PG — which track the
 * modal ordering actually resolves to — the one thing a string assertion
 * can't observe.
 *
 * BS#1799: this spec now imports and executes `enumerateFreetextPairs`
 * ITSELF (extracted to `@wxyc/database` — see
 * `shared/database/src/freetext-enumerate.ts`) instead of a hand-duplicated
 * SQL mirror. There is no drift risk left to manage: this IS the production
 * statement. Since the production function has no test-scoping predicate
 * (it scans the whole `flowsheet` table), the seeded rows are marked with a
 * "bs1767" artist token and the returned pairs are filtered to that token in
 * JS before asserting cardinality/song — a behavior-preserving equivalent of
 * the old mirror's `ILIKE '%bs1767%'` WHERE clause, applied client-side
 * instead of in the statement itself.
 *
 * Seeded matrix (all rows carry a "bs1767" marker so the JS-side filter,
 * cleanup, and assertions stay hermetic; album_id NULL so they're unlinked):
 *   - Pair A ('bs1767 artist a', 'bs1767 album a'):
 *       NULL   track × 5 plays  (most-played OVERALL, but empty → must NOT win)
 *       'Modal Track' × 3 plays (most-played NON-empty → MUST win)
 *       'Other Track' × 1 play
 *     → song === 'Modal Track'. Proves non-empty-first dominates raw play_count
 *       AND that most-played wins among the non-empty tracks.
 *   - Pair B ('bs1767 artist b', 'bs1767 album b'):
 *       NULL track × 2 plays
 *       ''   track × 1 play
 *     → song === '' (all tracks unusable → album-only fallback, still enumerated).
 *
 * Cardinality: exactly one row per distinct pair among the bs1767-marked rows
 * (2 pairs → 2 rows). The inner GROUP BY only picks a better representative
 * track; it does not change which pairs are enumerated.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier)
 * plus a built `@wxyc/database` (`dist/`), same as running the app itself —
 * `@wxyc/database`'s package.json `require` export resolves to
 * `./dist/index.js`.
 */

// `@wxyc/database` -> `drizzle-orm`. The repo-wide `tests/__mocks__/drizzle-orm.ts`
// manual mock (written for the ts-jest unit config, see jest.unit.config.ts) is a
// Jest node_modules manual mock, which Jest substitutes automatically for ANY
// test file that requires `drizzle-orm` — no `jest.mock(...)` call needed to
// trigger it — including this babel-jest-transformed integration spec, where
// that `.ts` mock file fails to parse (no TypeScript-stripping transform is
// registered for `jest.config.json`). `jest.unmock` opts this file back into
// the real `drizzle-orm` package so `@wxyc/database`'s real postgres-js driver
// runs, which is the entire point of this spec (executing the production
// `enumerateFreetextPairs` against real PG).
jest.unmock('drizzle-orm');

const { getTestDb } = require('../utils/db');
const { enumerateFreetextPairs, closeDatabaseConnection } = require('@wxyc/database');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('catalog-popularity-freetext-resolve enumerate representative track (real PG, BS#1767)', () => {
  let sql;
  const flowsheetIds = [];

  /** Insert one unlinked flowsheet track row (album_id NULL). */
  async function seedPlay(artist, album, track) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title,
         request_flag, segue, album_id, add_time)
      VALUES
        (97671, 'track', ${artist}, ${album}, ${track},
         false, false, null, now() - interval '30 days')
      RETURNING id
    `;
    flowsheetIds.push(rows[0].id);
    return rows[0].id;
  }

  /** Scope `enumerateFreetextPairs`'s full-table result down to this spec's
   * own rows — the production function has no test-scoping predicate, so
   * filtering here is the client-side equivalent of the old mirror's
   * `ILIKE '%bs1767%'` WHERE clause. */
  const scopedRows = (rows) => rows.filter((r) => r.artist.includes('bs1767'));

  beforeAll(async () => {
    sql = getTestDb();

    // Pair A — most-played NON-empty track must win over a more-played empty one.
    for (let i = 0; i < 5; i += 1) await seedPlay('bs1767 artist a', 'bs1767 album a', null);
    for (let i = 0; i < 3; i += 1) await seedPlay('bs1767 artist a', 'bs1767 album a', 'Modal Track');
    await seedPlay('bs1767 artist a', 'bs1767 album a', 'Other Track');

    // Pair B — all tracks unusable → album-only fallback, still enumerated.
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1767 artist b', 'bs1767 album b', null);
    await seedPlay('bs1767 artist b', 'bs1767 album b', '');
  });

  afterAll(async () => {
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
    }
    // `@wxyc/database` opens the shared postgres-js pool as a side effect of
    // import (shared/database/src/client.ts's module-level
    // `createPostgresClient()`). That pool is separate from this spec's own
    // `sql` client above (`getTestDb()`), so it needs its own teardown or the
    // process has an open handle after the suite finishes.
    await closeDatabaseConnection();
  });

  it('returns exactly one row per distinct (artist, album) pair (cardinality unchanged)', async () => {
    const rows = scopedRows(await enumerateFreetextPairs());
    expect(rows).toHaveLength(2);
    const pairs = rows.map((r) => `${r.artist} | ${r.album}`).sort();
    expect(pairs).toEqual(['bs1767 artist a | bs1767 album a', 'bs1767 artist b | bs1767 album b']);
  });

  it('picks the most-played NON-empty track as the representative song (non-empty-first beats raw play_count)', async () => {
    const rows = scopedRows(await enumerateFreetextPairs());
    const pairA = rows.find((r) => r.artist === 'bs1767 artist a');
    expect(pairA).toBeDefined();
    // The NULL track has 5 plays vs 'Modal Track' 3, but non-empty sorts first
    // in the DISTINCT ON ordering, then most-played wins among the non-empty.
    expect(pairA.song).toBe('Modal Track');
  });

  it("enumerates a track-less pair with song='' (album-only fallback, never dropped)", async () => {
    const rows = scopedRows(await enumerateFreetextPairs());
    const pairB = rows.find((r) => r.artist === 'bs1767 artist b');
    // The pair is present (not filtered out by a track_title IS NOT NULL), and
    // its representative track collapses to '' at the enumerate boundary.
    expect(pairB).toBeDefined();
    expect(pairB.song).toBe('');
  });
});
