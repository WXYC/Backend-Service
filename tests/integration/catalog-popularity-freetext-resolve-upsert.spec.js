/**
 * Integration test for the catalog-popularity-freetext-resolve UPSERT
 * contract (BS#1491 / catalog-popularity Phase-2 Track 1).
 *
 * Validates against a REAL Postgres (the migration 0106 table) the
 * `flowsheet_freetext_resolution` writer contract that the cron job issues
 * via `upsertVerdict`:
 *   - match: release id + confidence + match_source persisted, attempt_at +
 *     resolved_at stamped on the composite PK (norm_artist, norm_album).
 *   - no-match: release id NULL, resolved_at NULL, attempt_at STILL stamped
 *     (a responded outcome arms the TTL retry window).
 *   - idempotency: re-running the same verdict is a no-op upsert that updates
 *     in place — the composite PK never duplicates the row.
 *   - master-id preservation: a verdict UPSERT that omits discogs_master_id
 *     must NOT clobber a master id a later Track-0-aware run wrote.
 *   - the retry-eligibility predicate `loadSkipKeys` reads (resolved rows +
 *     no-match rows inside the TTL; never-tried + transient-failed excluded).
 *
 * Pure SQL — does NOT import the TS job (the integration runner is babel-jest
 * with no TS support). Mirrors the sibling
 * `flowsheet-metadata-backfill-upsert.spec.js` in shape. When `upsertVerdict`
 * in `jobs/catalog-popularity-freetext-resolve/job.ts` is hand-edited, the SQL
 * here must follow.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const MATCH_SOURCE = 'lml_bulk_lookup';

/**
 * Issue the job's UPSERT directly. Mirrors `upsertVerdict` in
 * `jobs/catalog-popularity-freetext-resolve/job.ts`:
 *   - attempt_at = NOW() always (responded outcome).
 *   - resolved_at = NOW() only when a release id is present, else NULL.
 *   - discogs_master_id is NEVER written (omitted from INSERT and the conflict
 *     SET clause) so a later Track-0 write survives.
 */
async function upsertVerdict(sql, v) {
  const hasMatch = v.discogs_release_id !== null && v.discogs_release_id !== undefined;
  await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet_freetext_resolution
      (norm_artist, norm_album, discogs_release_id, match_confidence, match_source,
       attempt_at, resolved_at)
    VALUES
      (${v.norm_artist}, ${v.norm_album}, ${v.discogs_release_id ?? null},
       ${v.match_confidence ?? null}, ${MATCH_SOURCE}, NOW(),
       ${hasMatch ? sql`NOW()` : null})
    ON CONFLICT (norm_artist, norm_album) DO UPDATE
       SET discogs_release_id = EXCLUDED.discogs_release_id,
           match_confidence   = EXCLUDED.match_confidence,
           match_source       = EXCLUDED.match_source,
           attempt_at         = NOW(),
           resolved_at        = ${hasMatch ? sql`NOW()` : null}
  `;
}

async function readRow(sql, normArtist, normAlbum) {
  const rows = await sql`
    SELECT * FROM ${sql(SCHEMA)}.flowsheet_freetext_resolution
    WHERE norm_artist = ${normArtist} AND norm_album = ${normAlbum}
  `;
  return rows[0] ?? null;
}

describe('catalog-popularity-freetext-resolve UPSERT contract (real PG, BS#1491)', () => {
  let sql;
  const insertedKeys = []; // [normArtist, normAlbum] pairs to clean up.

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    for (const [a, b] of insertedKeys) {
      await sql`
        DELETE FROM ${sql(SCHEMA)}.flowsheet_freetext_resolution
        WHERE norm_artist = ${a} AND norm_album = ${b}
      `;
    }
  });

  test('match: persists release id + confidence + source; stamps attempt_at and resolved_at', async () => {
    const key = ['bs1491 j dilla', 'donuts-match'];
    insertedKeys.push(key);
    await upsertVerdict(sql, {
      norm_artist: key[0],
      norm_album: key[1],
      discogs_release_id: 12345,
      match_confidence: 0.91,
    });

    const row = await readRow(sql, key[0], key[1]);
    expect(row).not.toBeNull();
    expect(row.discogs_release_id).toBe(12345);
    expect(Number(row.match_confidence)).toBeCloseTo(0.91, 5);
    expect(row.match_source).toBe(MATCH_SOURCE);
    expect(row.attempt_at).not.toBeNull();
    expect(row.resolved_at).not.toBeNull();
    // discogs_master_id stays NULL (Track 0 fills it later).
    expect(row.discogs_master_id).toBeNull();
  });

  test('no-match: null release id and resolved_at; attempt_at still stamped', async () => {
    const key = ['bs1491 unknown artist', 'unknown-album'];
    insertedKeys.push(key);
    await upsertVerdict(sql, {
      norm_artist: key[0],
      norm_album: key[1],
      discogs_release_id: null,
      match_confidence: null,
    });

    const row = await readRow(sql, key[0], key[1]);
    expect(row.discogs_release_id).toBeNull();
    expect(row.resolved_at).toBeNull();
    expect(row.match_confidence).toBeNull();
    // attempt_at stamped → the TTL retry window arms.
    expect(row.attempt_at).not.toBeNull();
  });

  test('idempotency: re-UPSERTing the same verdict updates in place, never duplicates the PK', async () => {
    const key = ['bs1491 idem artist', 'idem-album'];
    insertedKeys.push(key);
    const verdict = { norm_artist: key[0], norm_album: key[1], discogs_release_id: 777, match_confidence: 0.8 };

    await upsertVerdict(sql, verdict);
    await upsertVerdict(sql, verdict);
    await upsertVerdict(sql, verdict);

    const rows = await sql`
      SELECT * FROM ${sql(SCHEMA)}.flowsheet_freetext_resolution
      WHERE norm_artist = ${key[0]} AND norm_album = ${key[1]}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].discogs_release_id).toBe(777);
  });

  test('no-match → later match upsert flips release id and sets resolved_at (a later Discogs add can match)', async () => {
    const key = ['bs1491 flip artist', 'flip-album'];
    insertedKeys.push(key);

    await upsertVerdict(sql, {
      norm_artist: key[0],
      norm_album: key[1],
      discogs_release_id: null,
      match_confidence: null,
    });
    let row = await readRow(sql, key[0], key[1]);
    expect(row.discogs_release_id).toBeNull();
    expect(row.resolved_at).toBeNull();

    await upsertVerdict(sql, {
      norm_artist: key[0],
      norm_album: key[1],
      discogs_release_id: 999,
      match_confidence: 0.95,
    });
    row = await readRow(sql, key[0], key[1]);
    expect(row.discogs_release_id).toBe(999);
    expect(row.resolved_at).not.toBeNull();
  });

  test('master-id preservation: a verdict upsert does NOT clobber a previously-written discogs_master_id', async () => {
    const key = ['bs1491 master artist', 'master-album'];
    insertedKeys.push(key);

    // Initial resolve writes the release id (no master id yet).
    await upsertVerdict(sql, {
      norm_artist: key[0],
      norm_album: key[1],
      discogs_release_id: 555,
      match_confidence: 0.9,
    });

    // Simulate a later Track-0-aware run writing the master id directly.
    await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet_freetext_resolution
         SET discogs_master_id = 888
       WHERE norm_artist = ${key[0]} AND norm_album = ${key[1]}
    `;

    // A subsequent freetext-resolve sweep re-UPSERTs the verdict (release leg
    // only). It must NOT null out the master id.
    await upsertVerdict(sql, {
      norm_artist: key[0],
      norm_album: key[1],
      discogs_release_id: 555,
      match_confidence: 0.9,
    });

    const row = await readRow(sql, key[0], key[1]);
    expect(row.discogs_master_id).toBe(888);
    expect(row.discogs_release_id).toBe(555);
  });

  test('retry-eligibility predicate: skips resolved + in-TTL no-match; re-tries old no-match and never-tried', async () => {
    const ttlDays = 30;
    const resolvedKey = ['bs1491 retry resolved', 'a'];
    const freshNoMatchKey = ['bs1491 retry fresh-nomatch', 'b'];
    const staleNoMatchKey = ['bs1491 retry stale-nomatch', 'c'];
    const neverTriedKey = ['bs1491 retry never-tried', 'd'];
    insertedKeys.push(resolvedKey, freshNoMatchKey, staleNoMatchKey, neverTriedKey);

    // resolved -> skip.
    await upsertVerdict(sql, {
      norm_artist: resolvedKey[0],
      norm_album: resolvedKey[1],
      discogs_release_id: 1,
      match_confidence: 0.9,
    });
    // fresh no-match -> skip while inside TTL.
    await upsertVerdict(sql, {
      norm_artist: freshNoMatchKey[0],
      norm_album: freshNoMatchKey[1],
      discogs_release_id: null,
      match_confidence: null,
    });
    // stale no-match — attempt_at older than TTL, must be retried.
    await upsertVerdict(sql, {
      norm_artist: staleNoMatchKey[0],
      norm_album: staleNoMatchKey[1],
      discogs_release_id: null,
      match_confidence: null,
    });
    await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet_freetext_resolution
         SET attempt_at = NOW() - (INTERVAL '1 day' * ${ttlDays + 5})
       WHERE norm_artist = ${staleNoMatchKey[0]} AND norm_album = ${staleNoMatchKey[1]}
    `;
    // never-tried: attempt_at NULL — always retried (insert a bare row).
    await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet_freetext_resolution (norm_artist, norm_album)
      VALUES (${neverTriedKey[0]}, ${neverTriedKey[1]})
    `;

    // Mirror loadSkipKeys' SQL predicate.
    const skipRows = await sql`
      SELECT norm_artist, norm_album
      FROM ${sql(SCHEMA)}.flowsheet_freetext_resolution
      WHERE attempt_at IS NOT NULL
        AND (
          discogs_release_id IS NOT NULL
          OR attempt_at > NOW() - (INTERVAL '1 day' * ${ttlDays})
        )
        AND norm_artist LIKE 'bs1491 retry %'
    `;
    const skipSet = new Set(skipRows.map((r) => JSON.stringify([r.norm_artist, r.norm_album])));

    expect(skipSet.has(JSON.stringify(resolvedKey))).toBe(true); // resolved -> skip
    expect(skipSet.has(JSON.stringify(freshNoMatchKey))).toBe(true); // fresh no-match -> skip
    expect(skipSet.has(JSON.stringify(staleNoMatchKey))).toBe(false); // stale no-match -> retry
    expect(skipSet.has(JSON.stringify(neverTriedKey))).toBe(false); // never-tried -> retry
  });
});
