/**
 * Integration test for BS#2000's candidate net (V/A Apple-URL remediation).
 *
 * WHY THIS CANNOT BE A UNIT TEST. `jest.unit.config.ts` maps `@wxyc/database`
 * to `tests/mocks/database.mock.ts`, so there is no Postgres: neither
 * `wxyc_schema.fold_artist_name` nor PG's `~` operator is evaluated. A unit
 * test would have to re-implement the regex in JS and would end up pinning the
 * TS twin against itself — which is exactly the drift class this pin exists to
 * catch. The whole point is that the SQL net and the TS arbiter agree, and only
 * a real database can speak for the SQL half.
 *
 * WHAT IT PROTECTS. The net must be a genuine SUPERSET of the arbiter, because
 * anything the SQL filters out is invisible to the arbiter no matter how
 * correct the arbiter is. Two real regressions this file would have caught:
 *
 *   1. `lower(artist_name) ~ '(various|…)'` — the original net. It never
 *      matches `Vàrious Artists`, so every diacritic-bearing V/A row was
 *      dropped before arbitration, while the TS-side fold pin passed happily.
 *   2. `v\.a\.` — LML's donor regex. `is_compilation_artist` accepts the
 *      DOTLESS form, so `v.a`, `v.a - jazz` and `v.a 1998` are arbiter-positive
 *      but donor-net-negative. Those rows would never be selected.
 *
 * Pure SQL — does NOT import the TS job (the integration runner is babel-jest
 * with no TS support). The predicate here mirrors `flowsheetNet` in
 * `jobs/va-apple-music-url-remediation/orchestrate.ts`; when that is
 * hand-edited, the SQL here must follow.
 *
 * The `::text` casts on bound params are deliberate: postgres-js raises
 * "inconsistent types deduced for parameter $N" (42P08) at Parse time when a
 * parameter is reused across two type contexts, and a Parse-time failure fails
 * every test in the file regardless of the data.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Kept byte-identical to VA_NET_REGEX in orchestrate.ts and to SUPERSET_REGEX
// in LML#1139's scripts/purge_va_apple_track_cache.py.
const VA_NET_REGEX = '(various|soundtrack|compilation|v[./]\\s*a\\.?)';

/** Artist credits that ARE V/A under wxyc-etl's rule — the net must reach all of them. */
const MUST_MATCH = [
  'Various Artists',
  'Various Artists - Blues',
  'Various Artists-Rock-Y',
  'V/A',
  'V.A.',
  'V.A', // dotless — regression (2)
  'V.A - Jazz',
  'Various',
  'Soundtrack',
  'Soundtracks',
  'Compilation',
  '  Various Artists', // leading whitespace
  'Various  Artists - Blues', // doubled inner space
  'Vàrious Artists', // diacritic — regression (1)
  'VÀRIOUS ARTISTS',
];

/**
 * Credits that are NOT V/A. The net is a deliberate superset, so several of
 * these DO match it — the TS arbiter is what excludes them. Only names that
 * genuinely share no substring should fall out here.
 */
const MUST_NOT_MATCH_NET = ['Stereolab', 'Juana Molina', 'Cat Power', 'Jessica Pratt'];

describe('BS#2000 candidate net (real Postgres)', () => {
  let sql;

  beforeAll(() => {
    // getTestDb() is synchronous — it returns the shared postgres-js pool.
    sql = getTestDb();
  });

  it('fold_artist_name exists and decomposes diacritics', async () => {
    const rows = await sql`
      SELECT ${sql(SCHEMA)}.fold_artist_name('Vàrious Artists') AS folded
    `;
    expect(rows[0].folded).toBe('various artists');
  });

  it.each(MUST_MATCH)('selects %p through the folded net', async (artist) => {
    const rows = await sql`
      SELECT ${sql(SCHEMA)}.fold_artist_name(${artist}::text) ~ ${VA_NET_REGEX}::text AS matched
    `;
    expect(rows[0].matched).toBe(true);
  });

  it.each(MUST_NOT_MATCH_NET)('does not select unrelated artist %p', async (artist) => {
    const rows = await sql`
      SELECT ${sql(SCHEMA)}.fold_artist_name(${artist}::text) ~ ${VA_NET_REGEX}::text AS matched
    `;
    expect(rows[0].matched).toBe(false);
  });

  it('an unfolded lower() net would MISS the diacritic row (the regression)', async () => {
    // Pins the reason the fold is in SQL rather than only in TypeScript.
    const rows = await sql`
      SELECT lower('Vàrious Artists') ~ ${VA_NET_REGEX}::text AS unfolded,
             ${sql(SCHEMA)}.fold_artist_name('Vàrious Artists') ~ ${VA_NET_REGEX}::text AS folded
    `;
    expect(rows[0].unfolded).toBe(false);
    expect(rows[0].folded).toBe(true);
  });

  it("a trailing-dot-only v.a. net would MISS the dotless family (the donor's gap)", async () => {
    const DONOR_REGEX = '(various|soundtrack|compilation|v/a|v\\.a\\.)';
    for (const artist of ['V.A', 'V.A - Jazz', 'V.A 1998']) {
      const rows = await sql`
        SELECT ${sql(SCHEMA)}.fold_artist_name(${artist}::text) ~ ${DONOR_REGEX}::text AS donor,
               ${sql(SCHEMA)}.fold_artist_name(${artist}::text) ~ ${VA_NET_REGEX}::text AS widened
      `;
      expect(rows[0].donor).toBe(false);
      expect(rows[0].widened).toBe(true);
    }
  });
});
