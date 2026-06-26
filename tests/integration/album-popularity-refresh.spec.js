/**
 * Integration test for the album_popularity rebuild contract (BS#1486
 * Phase-2 Track 2 / #1492), against a REAL Postgres (the migration 0107 table).
 *
 * Validates the two SQL legs that `album-popularity-refresh.service.ts` issues:
 *   1. LINKED leg — `flowsheet` track rows JOIN `library`, keyed by the
 *      `discogs:`-stripped `canonical_entity_id` (master:/release:) with a
 *      `library:<id>` fallback for unresolved rows. Two pressings sharing one
 *      `discogs:master:<id>` MUST collapse into ONE row whose `linked_plays`
 *      sums both pressings (the headline acceptance criterion).
 *   2. FREE-TEXT leg — UPSERT that folds free-text plays onto the linked row
 *      (`plays = linked_plays + EXCLUDED.freetext_plays`), or inserts a fresh
 *      free-text-only key (`linked_plays = 0`, NULL representative).
 *
 * Pure SQL — does NOT import the TS service (the integration runner is
 * babel-jest, no TS). The SQL here mirrors the service's two legs; when the
 * service's `refreshAlbumPopularity` SQL is hand-edited, this must follow. The
 * service's free-text aggregation/normalization (the JS keying) is covered by
 * the unit suite (`album-popularity-refresh.service.test.ts` +
 * `freetext-norm.test.ts`); this spec covers the DB-level collapse + UPSERT
 * arithmetic those keys feed.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 * Probe rows live in a reserved 7140-range, reusing fixture artist 7000 ('XA'),
 * genre 11 ('Rock'), format 1 ('cd').
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'

const PRESS_A = 7140; // pressing of master 99910001 (lower id -> representative)
const PRESS_B = 7141; // another pressing of the SAME master -> must collapse
const REL = 7142; // master-less release -> release:<id> fallback
const UNRESOLVED = 7143; // NULL canonical_entity_id -> library:<id> fallback

const MASTER_KEY = 'master:99910001';
const RELEASE_KEY = 'release:99920002';
const UNRESOLVED_KEY = `library:${UNRESOLVED}`;
const FREETEXT_ONLY_KEY = 'master:88880003'; // an album we play but don't own

/** Mirror of the service's LINKED leg: full DELETE + INSERT...SELECT. */
async function rebuildLinkedLeg(sql) {
  await sql`DELETE FROM ${sql(SCHEMA)}.album_popularity`;
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_popularity
      (logical_album_key, plays, linked_plays, freetext_plays, representative_library_id)
    SELECT "key", count(*)::int, count(*)::int, 0, min("library_id")
    FROM (
      SELECT
        CASE
          WHEN l.canonical_entity_id LIKE 'discogs:%'
            THEN substring(l.canonical_entity_id from 'discogs:(.*)')
          WHEN l.canonical_entity_id IS NOT NULL
            THEN l.canonical_entity_id
          ELSE 'library:' || l.id::text
        END AS "key",
        l.id AS "library_id"
      FROM ${sql(SCHEMA)}.flowsheet f
      JOIN ${sql(SCHEMA)}.library l ON l.id = f.album_id
      WHERE f.entry_type = 'track'
    ) t
    GROUP BY "key"
  `;
}

/** Mirror of the service's FREE-TEXT leg UPSERT for one logical key. */
async function upsertFreetext(sql, key, plays) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_popularity
      (logical_album_key, plays, linked_plays, freetext_plays, representative_library_id)
    VALUES (${key}, ${plays}, 0, ${plays}, NULL)
    ON CONFLICT (logical_album_key) DO UPDATE
      SET freetext_plays = EXCLUDED.freetext_plays,
          plays = ${sql(SCHEMA)}.album_popularity.linked_plays + EXCLUDED.freetext_plays
  `;
}

async function readKey(sql, key) {
  const rows = await sql`
    SELECT * FROM ${sql(SCHEMA)}.album_popularity WHERE logical_album_key = ${key}
  `;
  return rows[0] ?? null;
}

async function seedLibrary(sql, id, canonical, codeNumber) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, canonical_entity_id)
    VALUES (${id}, ${ART}, ${GEN}, ${FMT}, ${`bs1492 probe ${id}`}, ${codeNumber}, 'Shape Fixture Artist Alpha', ${canonical})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedPlays(sql, albumId, count, playOrderBase) {
  for (let i = 0; i < count; i++) {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (album_id, entry_type, play_order, artist_name, album_title, track_title)
      VALUES (${albumId}, 'track', ${playOrderBase + i}, 'Shape Fixture Artist Alpha', ${`bs1492 probe ${albumId}`}, ${`probe track ${i}`})
    `;
  }
}

describe('album_popularity rebuild contract (real PG, BS#1492)', () => {
  let sql;
  const libraryIds = [PRESS_A, PRESS_B, REL, UNRESOLVED];

  beforeAll(async () => {
    sql = getTestDb();

    await seedLibrary(sql, PRESS_A, 'discogs:master:99910001', 140);
    await seedLibrary(sql, PRESS_B, 'discogs:master:99910001', 141);
    await seedLibrary(sql, REL, 'discogs:release:99920002', 142);
    await seedLibrary(sql, UNRESOLVED, null, 143);

    await seedPlays(sql, PRESS_A, 1, 9140);
    await seedPlays(sql, PRESS_B, 1, 9150);
    await seedPlays(sql, REL, 1, 9160);
    await seedPlays(sql, UNRESOLVED, 2, 9170);
  });

  afterAll(async () => {
    if (!sql) return;
    // flowsheet.album_id is ON DELETE SET NULL — reap play rows by album_id
    // BEFORE deleting the library row (album_id goes NULL after).
    for (const id of libraryIds) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE album_id = ${id}`;
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
    // Drop the probe-derived rows so a later test never sees stale popularity.
    for (const key of [MASTER_KEY, RELEASE_KEY, UNRESOLVED_KEY, FREETEXT_ONLY_KEY]) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_popularity WHERE logical_album_key = ${key}`;
    }
  });

  test('linked leg collapses two pressings of one master into a single row summing both plays', async () => {
    await rebuildLinkedLeg(sql);

    const master = await readKey(sql, MASTER_KEY);
    expect(master).not.toBeNull();
    expect(master.linked_plays).toBe(2); // 1 (PRESS_A) + 1 (PRESS_B) collapsed
    expect(master.plays).toBe(2);
    expect(master.freetext_plays).toBe(0);
    // Representative is the canonical (lowest-id) pressing for Track 3's display join.
    expect(master.representative_library_id).toBe(PRESS_A);
  });

  test('master-less release keeps a release:<id> key; unresolved row falls back to library:<id>', async () => {
    await rebuildLinkedLeg(sql);

    const release = await readKey(sql, RELEASE_KEY);
    expect(release.linked_plays).toBe(1);
    expect(release.representative_library_id).toBe(REL);

    // NULL canonical_entity_id -> own logical album, plays never lost.
    const unresolved = await readKey(sql, UNRESOLVED_KEY);
    expect(unresolved.linked_plays).toBe(2);
    expect(unresolved.representative_library_id).toBe(UNRESOLVED);
  });

  test('free-text leg folds onto the linked row: plays = linked_plays + freetext_plays', async () => {
    await rebuildLinkedLeg(sql);
    await upsertFreetext(sql, MASTER_KEY, 3);

    const master = await readKey(sql, MASTER_KEY);
    expect(master.linked_plays).toBe(2); // unchanged by the free-text leg
    expect(master.freetext_plays).toBe(3);
    expect(master.plays).toBe(5); // 2 linked + 3 free-text
    // Multi-pressing logical album's popularity (5) >= any single pressing's
    // plays (1) — the Track 3 acceptance criterion.
    expect(master.plays).toBeGreaterThanOrEqual(1);
    // Representative survives the UPSERT (DO UPDATE does not touch it).
    expect(master.representative_library_id).toBe(PRESS_A);
  });

  test('free-text-only key (album played but not owned) inserts fresh with linked_plays 0 and null representative', async () => {
    await rebuildLinkedLeg(sql);
    await upsertFreetext(sql, FREETEXT_ONLY_KEY, 4);

    const ft = await readKey(sql, FREETEXT_ONLY_KEY);
    expect(ft).not.toBeNull();
    expect(ft.linked_plays).toBe(0);
    expect(ft.freetext_plays).toBe(4);
    expect(ft.plays).toBe(4);
    expect(ft.representative_library_id).toBeNull();
  });
});
