/**
 * Integration test for the catalog-popularity-freetext-resolve ENUMERATE
 * play-count floor + play-descending drain (BS#1822), against real
 * PostgreSQL.
 *
 * Deliberately a SEPARATE spec file from
 * tests/integration/catalog-popularity-freetext-resolve-enumerate.spec.js
 * (the BS#1767 representative-track spec), not an added `describe` block in
 * it: that spec's `afterAll` calls `closeDatabaseConnection()` on
 * `@wxyc/database`'s shared postgres-js pool, and Jest runs multiple
 * `describe` blocks within ONE file sequentially in the SAME module registry
 * — a second `describe` block's queries would hit an already-closed
 * connection (`CONNECTION_ENDED`). Separate spec files each get their own
 * Jest module registry, so this file's own `@wxyc/database` import is an
 * independent pool untouched by the other spec's teardown.
 *
 * The unit suite (tests/unit/database/freetext-enumerate.test.ts) pins the
 * exact SQL shape `enumerateFreetextPairs` emits for the floor predicate
 * (`WHERE "total_plays" >= :minPlays`, gated before `DISTINCT ON`) and the
 * outer `ORDER BY "total_plays" DESC, "artist_name" ASC, "album_title" ASC`
 * re-order. This spec validates that pinned SQL's *runtime semantics* against
 * real PG: which pairs the floor actually excludes/includes, that a pair's
 * exclusion is NOT permanent (a later play crossing the floor re-includes
 * it), and the actual drain order (including a tie-break case).
 *
 * Four independently-scoped marker groups (own `bs1822<letter>` prefix each)
 * so one test's seed data / mid-suite mutation (Group B tops itself up)
 * can't influence another test's expectations:
 *   - Group A (floor gate): 'artist low' 1 play (below floor 2, excluded);
 *     'artist high' EXACTLY 2 plays (at the floor — `>=` must include it).
 *   - Group B (no permanent exclusion): starts at 1 play (excluded under
 *     floor 2); the SAME pair gets a second play mid-test and is re-queried,
 *     proving the floor is a live recomputation, not a persisted flag.
 *   - Group C (play-descending drain): three pairs with strictly distinct
 *     total play counts (5 / 3 / 2), unambiguous under any floor.
 *   - Group D (deterministic tiebreak): two pairs TIED on total plays (2
 *     each) but different artist names — the outer re-order's secondary
 *     `artist_name ASC` tiebreak must apply.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier)
 * plus a built `@wxyc/database` (`dist/`), same as running the app itself —
 * `@wxyc/database`'s package.json `require` export resolves to
 * `./dist/index.js`.
 */

// See tests/integration/catalog-popularity-freetext-resolve-enumerate.spec.js
// for why this is needed: the repo-wide `tests/__mocks__/drizzle-orm.ts`
// manual mock would otherwise apply here too (Jest substitutes it
// automatically for ANY file requiring `drizzle-orm`), and this spec's whole
// point is exercising `@wxyc/database`'s real postgres-js driver.
jest.unmock('drizzle-orm');

const { getTestDb } = require('../utils/db');
const { enumerateFreetextPairs, closeDatabaseConnection } = require('@wxyc/database');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('catalog-popularity-freetext-resolve enumerate play-floor + play-descending drain (real PG, BS#1822)', () => {
  let sql;
  const flowsheetIds = [];

  /** Insert one unlinked flowsheet track row (album_id NULL). */
  async function seedPlay(artist, album, track) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title,
         request_flag, segue, album_id, add_time)
      VALUES
        (97672, 'track', ${artist}, ${album}, ${track},
         false, false, null, now() - interval '30 days')
      RETURNING id
    `;
    flowsheetIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    sql = getTestDb();

    // Group A — floor gate at the `>=` boundary.
    await seedPlay('bs1822a artist low', 'bs1822a album low', 'Track');
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1822a artist high', 'bs1822a album high', 'Track');

    // Group B — starts below the floor; topped up mid-test below.
    await seedPlay('bs1822b artist reeligible', 'bs1822b album reeligible', 'Track');

    // Group C — strictly distinct total play counts (5 / 3 / 2).
    for (let i = 0; i < 5; i += 1) await seedPlay('bs1822c artist high', 'bs1822c album high', 'Track');
    for (let i = 0; i < 3; i += 1) await seedPlay('bs1822c artist mid', 'bs1822c album mid', 'Track');
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1822c artist low', 'bs1822c album low', 'Track');

    // Group D — tied total plays (2 each), different artist names.
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1822d artist b', 'bs1822d album b', 'Track');
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1822d artist a', 'bs1822d album a', 'Track');
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

  it('excludes a below-floor pair but keeps one exactly AT the floor (>= boundary; floor gates the PAIR, summed across tracks)', async () => {
    const rows = (await enumerateFreetextPairs(undefined, 2)).filter((r) => r.artist.startsWith('bs1822a'));
    expect(rows.map((r) => r.artist)).toEqual(['bs1822a artist high']); // the 1-play pair is excluded; the 2-play pair clears >=
  });

  it('does not permanently exclude a below-floor pair — it becomes eligible again once its play count crosses the floor (no persisted exclusion)', async () => {
    // Below the floor (1 play) — excluded this run.
    let rows = (await enumerateFreetextPairs(undefined, 2)).filter((r) => r.artist.startsWith('bs1822b'));
    expect(rows).toHaveLength(0);

    // A second play accrues — re-running the SAME query now includes it: the
    // floor is a live recomputation over the current flowsheet state, not a
    // persisted exclusion flag that would need a separate "un-exclude" step.
    await seedPlay('bs1822b artist reeligible', 'bs1822b album reeligible', 'Track');
    rows = (await enumerateFreetextPairs(undefined, 2)).filter((r) => r.artist.startsWith('bs1822b'));
    expect(rows.map((r) => r.artist)).toEqual(['bs1822b artist reeligible']);
  });

  it('drains pairs in play-descending order (total_plays DESC)', async () => {
    const rows = (await enumerateFreetextPairs(undefined, 0)).filter((r) => r.artist.startsWith('bs1822c'));
    expect(rows.map((r) => r.artist)).toEqual(['bs1822c artist high', 'bs1822c artist mid', 'bs1822c artist low']);
  });

  it('breaks a total_plays tie deterministically (artist_name ASC) so the drain order is stable', async () => {
    const rows = (await enumerateFreetextPairs(undefined, 0)).filter((r) => r.artist.startsWith('bs1822d'));
    expect(rows.map((r) => r.artist)).toEqual(['bs1822d artist a', 'bs1822d artist b']);
  });
});
