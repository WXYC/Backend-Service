/**
 * Integration tests for the REAL shipped merge functions of
 * `jobs/artist-unicode-dedup` (BS#1897 review MED-1).
 *
 * Unlike `artist-unicode-dedup.spec.js` (which tests the fold function + the
 * matcher predicate with pure SQL), this spec `require`s and RUNS the actual
 * `mergeGroup` / `findDuplicateGroups` / `intArrayLiteral` from the compiled
 * `dist/merge.cjs` — no reimplementation — so the dangerous, non-obvious
 * branches of the destructive merge have direct coverage:
 *   (a) `artist_crossreference` two-endpoint repoint (a row with BOTH source and
 *       target in the merge group) + the 2-column-key collision-delete + the
 *       post-loop `(surv, surv)` self-reference DELETE.
 *   (b) `artist_search_alias` 3-column-PK `(artist_id, source, variant)`
 *       collision-delete + the nullable `related_artist_id` plain repoint.
 *   (c) reconciled-identity `COALESCE` determinism when two duplicates both
 *       carry a non-null column: the lowest-id duplicate's value wins (ascending
 *       processing order), and a survivor's own non-null value always wins.
 * Plus an idempotency re-scan (a merged group drops out of findDuplicateGroups).
 *
 * The merge functions use the `@wxyc/database` `db` singleton (its own pool,
 * DB_* env); this spec seeds + asserts via `getTestDb()` (a separate pool on the
 * same DB). All writes commit, so the two pools see each other's rows. When
 * `jobs/artist-unicode-dedup/merge.ts` changes, rebuild before running
 * (`npm run build --workspace=@wxyc/artist-unicode-dedup`); CI's Build step
 * produces `dist/merge.cjs` before the integration tier runs.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock (written for the
// ts-jest unit tier) is AUTOMATICALLY applied to every `drizzle-orm` require —
// no `jest.mock(...)` needed — including here in the integration tier. Our
// compiled `dist/merge.cjs` requires the REAL drizzle-orm (its `sql` template
// builds the merge queries `@wxyc/database`'s postgres-js driver runs), so
// unmock it (same pattern as `rotation-match.spec.js`). Hoisted above the
// requires below by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

// The REAL compiled merge core (MED-1: no reimplementation). `dist/merge.cjs`
// is produced by the workspace `build` (tsup dual-format esm+cjs); CI's Build
// step runs before the integration tier. Rebuild after editing merge.ts.
const merge = require(path.join(__dirname, '..', '..', 'jobs', 'artist-unicode-dedup', 'dist', 'merge.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE_ID = 11; // exists in the integration fixture

// Each test uses a UNIQUE prefix so its fold key is distinct from the others'
// — the tests don't cross-contaminate even if a cleanup is ever incomplete.
// `.normalize()` guarantees the NFC/NFD byte distinction regardless of how the
// source file is encoded (ü composed U+00FC vs decomposed u + U+0308).
const forms = (prefix) => {
  const base = `${prefix} Nilüfer`;
  return { nfc: base.normalize('NFC'), nfd: base.normalize('NFD'), upper: base.toUpperCase().normalize('NFC') };
};

describe('artist-unicode-dedup mergeGroup — REAL functions (real PG, BS#1897 MED-1)', () => {
  let sql;
  const artistIds = [];

  beforeAll(async () => {
    sql = getTestDb();
    // Recovery path (BS#2011): `afterEach` below narrows the crash window to
    // one in-flight test, but a process death still skips it — routine under
    // `jest.config.json`'s `forceExit: true`. A crashed prior run leaves
    // genuinely fold-duplicate `artists` rows (the fixture shape under test),
    // which `jobs/artist-unicode-dedup`'s `--dry-run` sizing would then
    // silently count as real merge candidates on a persistent dev DB. Delete
    // by the stable `ZZMERGE` marker every seeded name in this file carries
    // (`forms()` always prefixes with a `ZZMERGE...` test id), with no prior
    // knowledge required. Same child-then-parent order as `afterEach`.
    const marker = 'ZZMERGE%';
    await sql`
      DELETE FROM ${sql(SCHEMA)}.artist_crossreference
       WHERE source_artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
          OR target_artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
    `;
    await sql`
      DELETE FROM ${sql(SCHEMA)}.artist_search_alias
       WHERE artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
          OR related_artist_id IN (SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${marker})
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
    // Clear every child row (some FKs RESTRICT rather than CASCADE — e.g.
    // library.artist_id, and genre_artist_crossreference in this DB) before
    // deleting the artists. Idempotent across a merge that already deleted dups.
    if (artistIds.length === 0) return;
    const ids = `{${artistIds.join(',')}}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.artist_crossreference WHERE source_artist_id = ANY(${ids}::int[]) OR target_artist_id = ANY(${ids}::int[])`;
    await sql`DELETE FROM ${sql(SCHEMA)}.artist_search_alias WHERE artist_id = ANY(${ids}::int[]) OR related_artist_id = ANY(${ids}::int[])`;
    await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id = ANY(${ids}::int[])`;
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE artist_id = ANY(${ids}::int[])`;
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ANY(${ids}::int[])`;
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

  async function insertGenreCrossref(artistId, genreCode, genreId = GENRE_ID) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
      VALUES (${artistId}, ${genreId}, ${genreCode})
    `;
  }

  async function insertCrossref(source, target) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.artist_crossreference (source_artist_id, target_artist_id)
      VALUES (${source}, ${target})
    `;
  }

  async function insertAlias(artistId, source, variant, relatedArtistId = null) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.artist_search_alias
        (artist_id, source, variant, related_artist_id, method, confidence, last_verified_at)
      VALUES (${artistId}, ${source}, ${variant}, ${relatedArtistId}, 'test', 1.0, NOW())
    `;
  }

  /** Find the fold-group covering `id` from the REAL findDuplicateGroups(). */
  async function groupFor(id) {
    const groups = await merge.findDuplicateGroups();
    return groups.find((g) => [g.survivorId, ...g.duplicateIds].includes(id)) ?? null;
  }

  test('intArrayLiteral builds the PG array-literal form', () => {
    expect(merge.intArrayLiteral([1, 2, 3])).toBe('{1,2,3}');
    expect(merge.intArrayLiteral([])).toBe('{}');
  });

  test('(a) artist_crossreference: two-endpoint repoint, 2-col collision, self-ref cleanup', async () => {
    const { nfc, nfd } = forms('ZZMERGEA');
    const S = await insertArtist(nfc, 'ZM1'); // survivor (lower id, NFC)
    const D = await insertArtist(nfd, 'ZM2'); // duplicate (NFD)
    const X = await insertArtist('ZZMERGEA Distinct Other', 'ZMX'); // unrelated artist
    expect(D).toBeGreaterThan(S);

    // (S,D): both endpoints in the group → becomes (S,S) → self-ref DELETE removes it.
    await insertCrossref(S, D);
    // (S,X) exists AND (D,X): repointing D→S on (D,X) collides with (S,X) → collision-DELETE drops (D,X).
    await insertCrossref(S, X);
    await insertCrossref(D, X);

    const group = await groupFor(S);
    expect(group).not.toBeNull();
    expect(group.survivorId).toBe(S);
    expect(group.duplicateIds).toEqual([D]);

    await merge.mergeGroup(group);

    // Only (S,X) survives: (S,D) self-ref deleted, (D,X) collision-deleted.
    const rows = await sql`
      SELECT source_artist_id AS s, target_artist_id AS t
      FROM ${sql(SCHEMA)}.artist_crossreference
      WHERE source_artist_id IN (${S}, ${D}, ${X}) OR target_artist_id IN (${S}, ${D}, ${X})
      ORDER BY source_artist_id, target_artist_id
    `;
    expect(rows.map((r) => [Number(r.s), Number(r.t)])).toEqual([[S, X]]);
    // No self-reference left behind.
    expect(rows.every((r) => Number(r.s) !== Number(r.t))).toBe(true);
    // Duplicate artist row gone; survivor + X remain.
    const remaining = await sql`SELECT id FROM ${sql(SCHEMA)}.artists WHERE id IN (${S}, ${D}, ${X}) ORDER BY id`;
    expect(remaining.map((r) => Number(r.id))).toEqual([S, X].sort((a, b) => a - b));
  });

  test('(b) artist_search_alias: 3-col-PK collision-delete + related_artist_id repoint', async () => {
    const { nfc, nfd } = forms('ZZMERGEB');
    const S = await insertArtist(nfc, 'ZB1');
    const D = await insertArtist(nfd, 'ZB2');

    // Same (source, variant) on both → collision: dup's row dropped, survivor's kept.
    await insertAlias(S, 'discogs', 'nilufer');
    await insertAlias(D, 'discogs', 'nilufer');
    // Variant only the dup has → plain repoint to survivor (no collision).
    await insertAlias(D, 'discogs', 'nilufer-alt');
    // related_artist_id pointing at the dup → nullable FK plain repoint D→S.
    await insertAlias(S, 'manual', 'see-also', D);

    const group = await groupFor(S);
    await merge.mergeGroup(group);

    const aliases = await sql`
      SELECT artist_id AS a, source AS s, variant AS v, related_artist_id AS r
      FROM ${sql(SCHEMA)}.artist_search_alias
      WHERE artist_id IN (${S}, ${D}) OR related_artist_id IN (${S}, ${D})
      ORDER BY variant
    `;
    // All alias rows now belong to the survivor; none reference the (deleted) dup.
    expect(aliases.every((r) => Number(r.a) === S)).toBe(true);
    // The colliding (discogs, nilufer) collapsed to exactly one row.
    const collided = aliases.filter((r) => r.s === 'discogs' && r.v === 'nilufer');
    expect(collided).toHaveLength(1);
    // The dup-only variant was repointed, not dropped.
    expect(aliases.some((r) => r.v === 'nilufer-alt' && Number(r.a) === S)).toBe(true);
    // related_artist_id repointed D → S.
    const seeAlso = aliases.find((r) => r.v === 'see-also');
    expect(Number(seeAlso.r)).toBe(S);
  });

  test('(c) identity COALESCE: lowest-id duplicate wins; survivor own value wins', async () => {
    // Survivor has NULL discogs but a non-null musicbrainz → its own MB must win.
    const { nfc, nfd, upper } = forms('ZZMERGEC');
    const S = await insertArtist(nfc, 'ZC1', { musicbrainz: 'MB-SURVIVOR' });
    const D1 = await insertArtist(nfd, 'ZC2', { discogs: 111 }); // lower dup id
    const D2 = await insertArtist(upper, 'ZC3', { discogs: 222, musicbrainz: 'MB-DUP' }); // higher dup id
    expect(D1).toBeGreaterThan(S);
    expect(D2).toBeGreaterThan(D1);

    const group = await groupFor(S);
    expect(group.survivorId).toBe(S);
    expect(group.duplicateIds).toEqual([D1, D2]);

    await merge.mergeGroup(group);

    const rows = await sql`
      SELECT discogs_artist_id AS d, musicbrainz_artist_id AS m
      FROM ${sql(SCHEMA)}.artists WHERE id = ${S}
    `;
    // discogs filled from the LOWEST-id dup (D1=111), not D2=222.
    expect(Number(rows[0].d)).toBe(111);
    // musicbrainz: survivor's own value survives (never overwritten by D2's).
    expect(rows[0].m).toBe('MB-SURVIVOR');
    // both dups gone.
    const left = await sql`SELECT id FROM ${sql(SCHEMA)}.artists WHERE id IN (${S}, ${D1}, ${D2})`;
    expect(left.map((r) => Number(r.id))).toEqual([S]);
  });

  describe('describeGroupRisk — dry-run risk flags (MED-2)', () => {
    const TEMP_GENRE = 90001; // second genre for the multi-genre case

    beforeAll(async () => {
      await sql`INSERT INTO ${sql(SCHEMA)}.genres (id, genre_name) VALUES (${TEMP_GENRE}, 'ZZ Temp Genre') ON CONFLICT (id) DO NOTHING`;
    });
    afterAll(async () => {
      await sql`DELETE FROM ${sql(SCHEMA)}.genres WHERE id = ${TEMP_GENRE}`;
    });

    test('pure Unicode-form duplicate in one genre → formOnly, not multiGenre', async () => {
      const { nfc, nfd } = forms('ZZMERGERK1');
      const S = await insertArtist(nfc, 'ZK1');
      const D = await insertArtist(nfd, 'ZK2');
      await insertGenreCrossref(S, 96001, GENRE_ID);
      await insertGenreCrossref(D, 96002, GENRE_ID);

      const risk = await merge.describeGroupRisk(await groupFor(S));
      expect(risk.formOnly).toBe(true); // NFC and NFD are byte-identical after NFC
      expect(risk.multiGenre).toBe(false);
      expect(risk.genreIds).toEqual([GENRE_ID]);
    });

    test('accent-only difference across two genres → NOT formOnly, multiGenre', async () => {
      // Fold-equal but not form-equal: diacritic vs ASCII-fold (the risky case).
      const nfc = 'ZZMERGERK2 Nilüfer'.normalize('NFC');
      const ascii = 'ZZMERGERK2 Nilufer';
      const S = await insertArtist(nfc, 'ZK3');
      const D = await insertArtist(ascii, 'ZK4');
      await insertGenreCrossref(S, 96003, GENRE_ID);
      await insertGenreCrossref(D, 96004, TEMP_GENRE);

      const risk = await merge.describeGroupRisk(await groupFor(S));
      expect(risk.formOnly).toBe(false); // differs beyond Unicode form (accent)
      expect(risk.multiGenre).toBe(true);
      expect(risk.genreIds).toEqual([GENRE_ID, TEMP_GENRE].sort((a, b) => a - b));
    });
  });

  test('idempotency: a merged group drops out of findDuplicateGroups (re-scan)', async () => {
    const { nfc, nfd } = forms('ZZMERGEI');
    const S = await insertArtist(nfc, 'ZI1');
    const D = await insertArtist(nfd, 'ZI2');
    await insertGenreCrossref(S, 95001);
    await insertGenreCrossref(D, 95002);

    const foldKey = (await groupFor(S)).foldKey;
    await merge.mergeGroup(await groupFor(S));

    const after = await merge.findDuplicateGroups();
    expect(after.some((g) => g.foldKey === foldKey)).toBe(false);
  });
});
