/**
 * Integration test for the epic #1810 W4 rotation self-heal candidate query
 * (BS#895, folded into this issue per the 2026-07-25 scoping comment),
 * against real PostgreSQL.
 *
 * The unit suite (worklist.test.ts) pins the statement's *shape* under the
 * mocked drizzle harness; this spec validates its *semantics* against real
 * timestamp comparisons — the exact state-change gate the ticket requires
 * ("re-select rotation-linked enriched_no_match rows once their
 * rotation.discogs_release_id transitions NULL→present — state-change-gated,
 * not blind time"):
 *
 *   candidate ⟺ f.metadata_status = 'enriched_no_match'
 *             AND f.rotation_id IS NOT NULL
 *             AND r.discogs_release_id IS NOT NULL
 *             AND ( f.metadata_attempt_at IS NULL
 *                   OR r.discogs_release_id_resolve_attempted_at > f.metadata_attempt_at )
 *
 * Seeded matrix (all flowsheet rows carry a "bs895selfheal" marker so the
 * mirrored query can scope itself):
 *   - rot-resolved-never-attempted: rotation has a discogs_release_id,
 *     flowsheet row is enriched_no_match with metadata_attempt_at NULL (the
 *     common case — the CDC worker, not this job, wrote the terminal
 *     status) → CANDIDATE.
 *   - rot-resolved-after-attempt: rotation's discogs_release_id_resolve_attempted_at
 *     is AFTER the flowsheet row's metadata_attempt_at (a genuine NULL→present
 *     transition since this job last tried it) → CANDIDATE.
 *   - rot-resolved-before-attempt: rotation resolved BEFORE the flowsheet
 *     row's last attempt (this job already re-tried post-resolution; no new
 *     state change) → NOT a candidate.
 *   - rot-unresolved: rotation.discogs_release_id is still NULL → NOT a
 *     candidate (nothing changed yet).
 *   - not-rotation-linked: flowsheet.rotation_id IS NULL → NOT a candidate
 *     (the self-heal is rotation-scoped only).
 *   - still-pending: flowsheet.metadata_status = 'pending' (not yet
 *     terminal) → NOT a candidate (that's the main sweep's job, not W4's).
 *
 * Pure SQL — does NOT import `jobs/flowsheet-metadata-backfill/worklist.ts`.
 * Integration runner is babel-jest with no TS support; the statement below
 * mirrors `buildRotationSelfHealCandidates`. When worklist.ts is hand-edited
 * the SQL here must follow.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Mirror of `buildRotationSelfHealCandidates` in
 * `jobs/flowsheet-metadata-backfill/worklist.ts`, plus a test-hermetic
 * `track_title ILIKE '%bs895selfheal%'` scope for isolation from other
 * specs' fixture rows.
 */
async function scopedSelfHealCandidates(sql) {
  const rows = await sql`
    SELECT f."id" AS id, f."track_title" AS track_title
    FROM ${sql(SCHEMA)}.flowsheet f
    JOIN ${sql(SCHEMA)}.rotation r ON r."id" = f."rotation_id"
    WHERE f."metadata_status" = 'enriched_no_match'
      AND f."rotation_id" IS NOT NULL
      AND r."discogs_release_id" IS NOT NULL
      AND (
        f."metadata_attempt_at" IS NULL
        OR r."discogs_release_id_resolve_attempted_at" > f."metadata_attempt_at"
      )
      AND f."track_title" ILIKE '%bs895selfheal%'
    ORDER BY f."id" ASC
  `;
  return rows;
}

describe('flowsheet-metadata-backfill W4 rotation self-heal candidates (real PG, BS#895 / epic #1810)', () => {
  let sql;
  const flowsheetIds = [];
  const rotationIds = [];

  /** Insert a rotation row. discogsReleaseId / resolveAttemptedAt default to NULL (unresolved). */
  async function seedRotation(discogsReleaseId = null, resolveAttemptedAt = null) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation
        (rotation_bin, artist_name, album_title, discogs_release_id, discogs_release_id_resolve_attempted_at)
      VALUES
        ('M', 'BS895 Self-Heal Test Artist', 'BS895 Self-Heal Test Album', ${discogsReleaseId}, ${resolveAttemptedAt})
      RETURNING id
    `;
    rotationIds.push(rows[0].id);
    return rows[0].id;
  }

  /** Insert a flowsheet track row, optionally linked to a rotation row. */
  async function seedFlowsheetRow(
    trackTitle,
    { rotationId = null, metadataStatus = 'enriched_no_match', metadataAttemptAt = null } = {}
  ) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title,
         request_flag, segue, rotation_id, metadata_status, metadata_attempt_at)
      VALUES
        (97531, 'track', 'BS895 Self-Heal Flowsheet Artist', 'BS895 Self-Heal Flowsheet Album',
         ${trackTitle}, false, false, ${rotationId}, ${metadataStatus}, ${metadataAttemptAt})
      RETURNING id
    `;
    flowsheetIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    sql = getTestDb();

    // CANDIDATE: rotation resolved, flowsheet row never attempted by this
    // job (metadata_attempt_at NULL — the common worker-authored case).
    const rotResolvedNeverAttempted = await seedRotation(11000001, sql`now() - interval '1 hour'`);
    await seedFlowsheetRow('bs895selfheal-resolved-never-attempted', { rotationId: rotResolvedNeverAttempted });

    // CANDIDATE: rotation resolved strictly AFTER this job's last attempt —
    // a genuine NULL→present transition since the last try.
    const rotResolvedAfterAttempt = await seedRotation(11000002, sql`now() - interval '10 minutes'`);
    await seedFlowsheetRow('bs895selfheal-resolved-after-attempt', {
      rotationId: rotResolvedAfterAttempt,
      metadataAttemptAt: sql`now() - interval '1 hour'`,
    });

    // NOT a candidate: rotation resolved BEFORE this job's last attempt —
    // already re-tried post-resolution, no new state change.
    const rotResolvedBeforeAttempt = await seedRotation(11000003, sql`now() - interval '1 hour'`);
    await seedFlowsheetRow('bs895selfheal-resolved-before-attempt', {
      rotationId: rotResolvedBeforeAttempt,
      metadataAttemptAt: sql`now() - interval '10 minutes'`,
    });

    // NOT a candidate: rotation still unresolved.
    const rotUnresolved = await seedRotation(null, null);
    await seedFlowsheetRow('bs895selfheal-unresolved', { rotationId: rotUnresolved });

    // NOT a candidate: not rotation-linked at all.
    await seedFlowsheetRow('bs895selfheal-not-linked', { rotationId: null });

    // NOT a candidate: still pending (the main sweep's job, not W4's).
    const rotForPending = await seedRotation(11000004, sql`now() - interval '1 hour'`);
    await seedFlowsheetRow('bs895selfheal-still-pending', {
      rotationId: rotForPending,
      metadataStatus: 'pending',
      metadataAttemptAt: null,
    });
  });

  afterAll(async () => {
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
    }
    if (rotationIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${rotationIds})`;
    }
  });

  it('selects the two genuinely state-changed rows and excludes the rest', async () => {
    const rows = await scopedSelfHealCandidates(sql);
    const titles = rows.map((r) => r.track_title);

    expect(titles).toEqual(['bs895selfheal-resolved-never-attempted', 'bs895selfheal-resolved-after-attempt']);
  });

  it('excludes a row whose rotation resolved BEFORE this job last attempted it (no new state change)', async () => {
    const rows = await scopedSelfHealCandidates(sql);
    expect(rows.some((r) => r.track_title === 'bs895selfheal-resolved-before-attempt')).toBe(false);
  });

  it('excludes an unresolved rotation row (discogs_release_id still NULL)', async () => {
    const rows = await scopedSelfHealCandidates(sql);
    expect(rows.some((r) => r.track_title === 'bs895selfheal-unresolved')).toBe(false);
  });

  it('excludes a non-rotation-linked row', async () => {
    const rows = await scopedSelfHealCandidates(sql);
    expect(rows.some((r) => r.track_title === 'bs895selfheal-not-linked')).toBe(false);
  });

  it('excludes a still-pending row (not W4′s job — the main sweep owns it)', async () => {
    const rows = await scopedSelfHealCandidates(sql);
    expect(rows.some((r) => r.track_title === 'bs895selfheal-still-pending')).toBe(false);
  });

  it('re-attempting a candidate (stamping metadata_attempt_at = now()) removes it from the candidate set on the next pass — the idempotent self-heal contract', async () => {
    // Simulate this job's own re-attempt: stamp metadata_attempt_at = now(),
    // which is now newer than the rotation's resolve timestamp (1h ago), so
    // the row drops out without needing a TTL or blind re-scan.
    const rotationId = await seedRotation(11000005, sql`now() - interval '1 hour'`);
    const flowsheetId = await seedFlowsheetRow('bs895selfheal-reattempt-drops-out', { rotationId });

    let rows = await scopedSelfHealCandidates(sql);
    expect(rows.some((r) => r.track_title === 'bs895selfheal-reattempt-drops-out')).toBe(true);

    await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet SET metadata_attempt_at = now() WHERE id = ${flowsheetId}
    `;

    rows = await scopedSelfHealCandidates(sql);
    expect(rows.some((r) => r.track_title === 'bs895selfheal-reattempt-drops-out')).toBe(false);
  });
});
