/**
 * Integration tests for the REAL shipped split functions of
 * `jobs/artist-conflation-split` (BS#2645), the inverse of
 * artist-unicode-dedup: give a confirmed-distinct act merged onto a shared
 * `artists` row its own row.
 *
 * Same arrangement as `artist-unicode-dedup-merge.spec.js`: this spec
 * `require`s and RUNS the actual `planDirective` / `executeDirective` from
 * the compiled `dist/split.cjs` — no reimplementation — against the Docker
 * integration Postgres. The branches under direct coverage:
 *   (a) the full split: new row inserted with name columns copied and
 *       identity columns NULL, the genre's crossreference row moved with its
 *       artist_genre_code intact, and exactly that genre's library rows
 *       repointed;
 *   (b) `clear_identity` NULLs the kept row's six identity columns;
 *   (c) validation refusals (missing filing, keep==split, missing artist) and
 *       the idempotency they buy: a completed directive re-plans as refused;
 *   (d) the operator report: `artist_crossreference` rows touching the split
 *       artist are counted, never repointed.
 * Plus the catalog→code completeness guard inherited from the dedup spec:
 * every FK the database declares against `artists.id` must be either MOVED
 * by the split (library, genre_artist_crossreference) or REPORTED to the
 * operator (REPORTED_SITES), so a newly-added reference site cannot be
 * silently neither.
 *
 * The split functions use the `@wxyc/database` `db` singleton (its own pool,
 * DB_* env); this spec seeds + asserts via `getTestDb()` (a separate pool on
 * the same DB). When `jobs/artist-conflation-split/split.ts` changes, rebuild
 * before running (`npm run build --workspace=@wxyc/artist-conflation-split`);
 * CI's Build step produces `dist/split.cjs` before the integration tier runs.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock (written for the
// ts-jest unit tier) is AUTOMATICALLY applied to every `drizzle-orm` require —
// unmock it so the compiled split.cjs gets the real one (same pattern as
// artist-unicode-dedup-merge.spec.js). Hoisted above the requires below.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

// The REAL compiled split core. `dist/split.cjs` is produced by the workspace
// `build` (tsup dual-format esm+cjs).
const split = require(path.join(__dirname, '..', '..', 'jobs', 'artist-conflation-split', 'dist', 'split.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// Both exist in the integration fixture's genres table.
const KEEP_GENRE = 6;
const SPLIT_GENRE = 11;

describe('artist-conflation-split — REAL functions (real PG, BS#2645)', () => {
  let sql;
  const artistIds = [];

  const directive = (artistId, overrides = {}) => ({
    artistId,
    keepGenreId: KEEP_GENRE,
    splitGenreIds: [SPLIT_GENRE],
    clearIdentity: false,
    ...overrides,
  });

  beforeAll(async () => {
    sql = getTestDb();
    // Recovery path (the BS#2011 arrangement): a crashed prior run leaves
    // seeded rows behind; delete by the stable ZZSPLIT marker every seeded
    // name here carries, children before parents. Split-created rows carry
    // the same marker because they copy the seeded artist_name.
    const marker = 'ZZSPLIT%';
    await sql`
      DELETE FROM ${sql(SCHEMA)}.artist_crossreference
       WHERE source_artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
          OR target_artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
    `;
    await sql`
      DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference
       WHERE artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
    `;
    await sql`
      DELETE FROM ${sql(SCHEMA)}.library
       WHERE artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
    `;
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker}`;
  });

  afterEach(async () => {
    // The split CREATES artists rows this spec never learns ids for, so
    // clean by the ZZSPLIT name marker (children before parents), then by
    // the tracked ids as a belt for renamed rows.
    const marker = 'ZZSPLIT%';
    await sql`
      DELETE FROM ${sql(SCHEMA)}.artist_crossreference
       WHERE source_artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
          OR target_artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
    `;
    await sql`
      DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference
       WHERE artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
    `;
    await sql`
      DELETE FROM ${sql(SCHEMA)}.library
       WHERE artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
    `;
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker}`;
    artistIds.length = 0;
  });

  async function insertArtist(name, codeLetters, identity = {}) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists
        (artist_name, alphabetical_name, code_letters, discogs_artist_id, musicbrainz_artist_id)
      VALUES (${name}, ${name}, ${codeLetters}, ${identity.discogs ?? null}, ${identity.musicbrainz ?? null})
      RETURNING id
    `;
    const id = Number(rows[0].id);
    artistIds.push(id);
    return id;
  }

  async function insertGenreCrossref(artistId, genreId, genreCode) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
      VALUES (${artistId}, ${genreId}, ${genreCode})
    `;
  }

  async function insertRelease(artistId, genreId, title) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (${artistId}, ${genreId}, 1, ${title}, 1)
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  /** Seed the canonical two-act shape: one row, two filings, one release each. */
  async function seedConflated(name, identity = {}) {
    const id = await insertArtist(name, 'ZS', identity);
    await insertGenreCrossref(id, KEEP_GENRE, 1);
    await insertGenreCrossref(id, SPLIT_GENRE, 13);
    const keepRelease = await insertRelease(id, KEEP_GENRE, `${name} Kept Record`);
    const splitRelease = await insertRelease(id, SPLIT_GENRE, `${name} Split Record`);
    return { id, keepRelease, splitRelease };
  }

  test('(a) a split moves the filing, repoints only that genre, and never copies identity', async () => {
    const { id, keepRelease, splitRelease } = await seedConflated('ZZSPLITA Isis', { discogs: 1108500 });

    const plan = await split.planDirective(directive(id));
    expect(plan.refusals).toEqual([]);
    expect(plan.perGenre).toEqual([{ genreId: SPLIT_GENRE, artistGenreCode: 13, libraryRows: 1 }]);

    const result = await split.executeDirective(directive(id));
    const newId = result.newArtistIds[SPLIT_GENRE];
    expect(newId).toBeDefined();
    expect(result.libraryRowsRepointed).toBe(1);

    // The new row copies the name columns and starts with NO identity —
    // the name-keyed stamp belongs to at most one act.
    const [newRow] = await sql`
      SELECT artist_name, code_letters, discogs_artist_id, musicbrainz_artist_id
      FROM ${sql(SCHEMA)}.artists WHERE id = ${newId}
    `;
    expect(newRow.artist_name).toBe('ZZSPLITA Isis');
    expect(newRow.code_letters).toBe('ZS');
    expect(newRow.discogs_artist_id).toBeNull();

    // The crossreference row MOVED (same code, new owner); the kept filing stayed.
    const gac = await sql`
      SELECT artist_id, genre_id, artist_genre_code FROM ${sql(SCHEMA)}.genre_artist_crossreference
      WHERE artist_id IN (${id}, ${newId}) ORDER BY genre_id
    `;
    expect(gac.map((r) => [Number(r.artist_id), Number(r.genre_id), Number(r.artist_genre_code)])).toEqual([
      [id, KEEP_GENRE, 1],
      [newId, SPLIT_GENRE, 13],
    ]);

    // Exactly the split genre's release moved; the kept genre's stayed put.
    const [kept] = await sql`SELECT artist_id FROM ${sql(SCHEMA)}.library WHERE id = ${keepRelease}`;
    const [moved] = await sql`SELECT artist_id FROM ${sql(SCHEMA)}.library WHERE id = ${splitRelease}`;
    expect(Number(kept.artist_id)).toBe(id);
    expect(Number(moved.artist_id)).toBe(newId);

    // The kept row's identity is untouched when clear_identity is false.
    const [keptRow] = await sql`SELECT discogs_artist_id FROM ${sql(SCHEMA)}.artists WHERE id = ${id}`;
    expect(Number(keptRow.discogs_artist_id)).toBe(1108500);
  });

  test('(b) clear_identity NULLs the kept row identity columns', async () => {
    const { id } = await seedConflated('ZZSPLITB King', { discogs: 155327, musicbrainz: 'mbid-king' });

    await split.executeDirective(directive(id, { clearIdentity: true }));

    const [keptRow] = await sql`
      SELECT discogs_artist_id, musicbrainz_artist_id FROM ${sql(SCHEMA)}.artists WHERE id = ${id}
    `;
    expect(keptRow.discogs_artist_id).toBeNull();
    expect(keptRow.musicbrainz_artist_id).toBeNull();
  });

  test('(c) refusals: missing filing, keep listed as split, missing artist — and idempotency', async () => {
    const { id } = await seedConflated('ZZSPLITC Trees');

    const notFiled = await split.planDirective(directive(id, { splitGenreIds: [3] }));
    expect(notFiled.refusals).toEqual([expect.stringContaining('not filed under split genre 3')]);

    const keepIsSplit = await split.planDirective(directive(id, { splitGenreIds: [KEEP_GENRE] }));
    expect(keepIsSplit.refusals).toEqual(
      expect.arrayContaining([expect.stringContaining('also listed in split_genre_ids')])
    );

    const missing = await split.planDirective(directive(999999999));
    expect(missing.refusals).toEqual(expect.arrayContaining([expect.stringContaining('does not exist')]));

    // A completed split re-plans as refused (the filing is gone) — the
    // idempotency contract: re-running a finished directives file is a no-op.
    await split.executeDirective(directive(id));
    const rerun = await split.planDirective(directive(id));
    expect(rerun.refusals).toEqual([expect.stringContaining('already split: artists row #')]);
    await expect(split.executeDirective(directive(id))).rejects.toThrow(/refused/);
  });

  describe('moved + reported completeness (catalog → code)', () => {
    it('finds no FK on artists.id the split neither moves nor reports', async () => {
      const rows = await sql`
        SELECT tc.table_name, kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
           AND kcu.constraint_schema = tc.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = ${SCHEMA}
           AND ccu.table_name = 'artists'
           AND ccu.column_name = 'id'
      `;
      // Sanity floor: an empty catalog read would make the assertion below
      // vacuously green — the failure mode an introspection guard rots into.
      expect(rows.length).toBeGreaterThan(0);

      const moved = new Set(['library.artist_id', 'genre_artist_crossreference.artist_id']);
      const reported = new Set(split.REPORTED_SITES.map((t) => `${t.table}.${t.column}`));
      const missing = [...new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))]
        .filter((site) => !moved.has(site) && !reported.has(site))
        .sort();
      expect(missing).toEqual([]);
    });
  });

  test('(d) artist_crossreference rows are reported for the operator, never repointed', async () => {
    const { id } = await seedConflated('ZZSPLITD Bile');
    const other = await insertArtist('ZZSPLITD Other', 'ZO');
    await insertGenreCrossref(other, KEEP_GENRE, 99);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.artist_crossreference (source_artist_id, target_artist_id)
      VALUES (${other}, ${id})
    `;

    const plan = await split.planDirective(directive(id));
    expect(plan.reportedCounts['artist_crossreference.target_artist_id']).toBe(1);

    await split.executeDirective(directive(id));

    // The row still points at the ORIGINAL id — which act the librarian
    // meant is not mechanically knowable, so the job must not guess.
    const [xref] = await sql`
      SELECT target_artist_id FROM ${sql(SCHEMA)}.artist_crossreference WHERE source_artist_id = ${other}
    `;
    expect(Number(xref.target_artist_id)).toBe(id);
  });
});
