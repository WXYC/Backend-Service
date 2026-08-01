/**
 * Integration test for the metadata-no-match-digest query, against real
 * PostgreSQL. The unit suite (orchestrate.test.ts / format.test.ts) pins the
 * job's control flow and rendering under mocks; this spec validates the
 * SELECT's *semantics* on real PG: the strict `updated_at > :since` watermark
 * boundary, the `entry_type = 'track'` guard, the `metadata_status =
 * 'enriched_no_match'` filter, the rotation-linked-first ordering, and the
 * `LIMIT` cap.
 *
 * Pure SQL -- does NOT import `jobs/metadata-no-match-digest/query.ts` (the
 * integration runner is babel-jest with no TS support). The statement below
 * mirrors `queryNoMatchRows`; when query.ts is hand-edited the SQL here must
 * follow. Every seeded artist carries an 'nmd-' marker and every row's id is
 * tracked for teardown, so the spec never leaks rows into the shared schema.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Mirror of `jobs/metadata-no-match-digest/query.ts:queryNoMatchRows`
 * (projection trimmed to the columns these assertions read). `limit`
 * defaults to the production `MAX_DIGEST_ROWS`.
 */
async function queryNoMatchRows(sql, since, { limit = 5000 } = {}) {
  return sql`
    SELECT
      f."id" AS id,
      f."artist_name" AS artist_name,
      f."rotation_id" AS rotation_id,
      f."updated_at" AS updated_at,
      s."show_name" AS show_name
    FROM ${sql(SCHEMA)}.flowsheet f
    LEFT JOIN ${sql(SCHEMA)}.shows s ON s."id" = f."show_id"
    WHERE f."metadata_status" = 'enriched_no_match'
      AND f."entry_type" = 'track'
      AND f."updated_at" > ${since}
    ORDER BY (f."rotation_id" IS NOT NULL) DESC, f."updated_at" DESC
    LIMIT ${limit}
  `;
}

describe('metadata-no-match-digest query (real PG)', () => {
  let sql;
  const flowsheetIds = [];
  const rotationIds = [];

  /** Insert a flowsheet row already stamped `enriched_no_match` (or an override), returning its id + trigger-set updated_at. */
  async function seedRow(
    artist,
    { entryType = 'track', rotationId = null, metadataStatus = 'enriched_no_match' } = {}
  ) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title,
         request_flag, segue, rotation_id, add_time, metadata_status)
      VALUES
        (91234, ${entryType}, ${artist}, 'NMD Album', 'NMD Track',
         false, false, ${rotationId}, now(), ${metadataStatus})
      RETURNING id, updated_at
    `;
    flowsheetIds.push(rows[0].id);
    return rows[0];
  }

  async function seedRotation() {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, artist_name, album_title)
      VALUES (NULL, 'H', 'nmd-rotation-artist', 'nmd-rotation-album')
      RETURNING id
    `;
    rotationIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
    }
    if (rotationIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${rotationIds})`;
    }
  });

  it('returns only rows updated strictly after `since` (the exclusive watermark boundary on updated_at)', async () => {
    const older = await seedRow('nmd-boundary-older');
    // Capture the boundary from the DB clock with a >1ms gap on each side.
    // postgres-js parses timestamptz into a millisecond-precision JS Date, so
    // a boundary taken directly from a row's microsecond `updated_at` would
    // round DOWN and (wrongly) re-include that row under the strict `>`; the
    // pg_sleep gaps make the boundary unambiguous regardless of that rounding.
    // (Production is unaffected: the watermark is a JS-generated `runStart`,
    // already millisecond precision.)
    await sql`SELECT pg_sleep(0.02)`;
    const [{ since }] = await sql`SELECT now() AS since`;
    await sql`SELECT pg_sleep(0.02)`;
    const newer = await seedRow('nmd-boundary-newer');

    const ids = (await queryNoMatchRows(sql, since)).map((r) => r.id);

    expect(ids).toContain(newer.id); // updated after the boundary
    expect(ids).not.toContain(older.id); // updated before the boundary -- excluded
  });

  it("excludes non-'track' entry types even when stamped enriched_no_match", async () => {
    const { updated_at: since } = await seedRow('nmd-entrytype-anchor');
    const track = await seedRow('nmd-entrytype-track', { entryType: 'track' });
    const talkset = await seedRow('nmd-entrytype-talkset', { entryType: 'talkset' });

    const ids = (await queryNoMatchRows(sql, since)).map((r) => r.id);

    expect(ids).toContain(track.id);
    expect(ids).not.toContain(talkset.id);
  });

  it('excludes rows that are not in the enriched_no_match state', async () => {
    const { updated_at: since } = await seedRow('nmd-status-anchor');
    const noMatch = await seedRow('nmd-status-nomatch', { metadataStatus: 'enriched_no_match' });
    const matched = await seedRow('nmd-status-match', { metadataStatus: 'enriched_match' });

    const ids = (await queryNoMatchRows(sql, since)).map((r) => r.id);

    expect(ids).toContain(noMatch.id);
    expect(ids).not.toContain(matched.id);
  });

  it('orders rotation/catalog-linked rows ahead of freeform', async () => {
    const { updated_at: since } = await seedRow('nmd-order-anchor');
    const rotationId = await seedRotation();
    // Freeform seeded first (older), rotation-linked second (newer) -- so the
    // rotation-first ordering must override the newest-first tiebreak.
    const freeform = await seedRow('nmd-order-freeform', { rotationId: null });
    const linked = await seedRow('nmd-order-linked', { rotationId });

    const result = await queryNoMatchRows(sql, since);
    const linkedPos = result.findIndex((r) => r.id === linked.id);
    const freeformPos = result.findIndex((r) => r.id === freeform.id);

    expect(linkedPos).toBeGreaterThanOrEqual(0);
    expect(freeformPos).toBeGreaterThanOrEqual(0);
    expect(linkedPos).toBeLessThan(freeformPos);
  });

  it('caps the result set at the LIMIT', async () => {
    const { updated_at: since } = await seedRow('nmd-limit-anchor');
    await seedRow('nmd-limit-1');
    await seedRow('nmd-limit-2');
    await seedRow('nmd-limit-3');

    const capped = await queryNoMatchRows(sql, since, { limit: 2 });
    const uncapped = await queryNoMatchRows(sql, since, { limit: 100 });

    expect(capped).toHaveLength(2);
    expect(uncapped.length).toBeGreaterThanOrEqual(3);
  });
});
