/**
 * One-shot historical backfill: populate `album_metadata` from the enriched
 * subset of `flowsheet` (Epic D / WXYC/Backend-Service#898).
 *
 * D1 (#897) created `album_metadata` empty with a COALESCE LEFT JOIN in the
 * V2 read path. D3 (#899) will reroute the live enrichment writer to UPSERT
 * into this table. This job is the bridge: it scans the ~50k–100k enriched
 * flowsheet rows (those with `metadata_attempt_at IS NOT NULL`) and copies
 * the newest enrichment per distinct `album_id` into `album_metadata`.
 *
 * Operationally distinct from the bulk-update playbook's wedge case. That
 * playbook concerns per-row `UPDATE flowsheet` cost (CDC trigger + STORED
 * `search_doc` tsvector regen + 6 index updates). This job is
 * `INSERT INTO album_metadata SELECT FROM flowsheet`: no flowsheet write,
 * no CDC fan-out, no per-row index churn on the live table. The real risk
 * is buffer-cache eviction from a large SELECT scan on flowsheet — bound
 * it with a session `statement_timeout` and run in an off-hours window.
 *
 * `ON CONFLICT (album_id) DO NOTHING` makes the job idempotent. The
 * companion writer-cutover (#899) owns later updates via its own UPSERT
 * with a `setWhere: album_metadata.updated_at < NOW()` race guard.
 *
 * `updated_at` is seeded from `COALESCE(metadata_attempt_at, now())` to
 * preserve the original enrichment lineage. D4's consistency-check window
 * compares `album_metadata.updated_at` against `flowsheet.metadata_attempt_at`
 * and depends on that ordering being meaningful.
 *
 * Run procedure: see Backend-Service/CLAUDE.md and issue #898. Build via
 * `Manual Build & Deploy` with `target=album-metadata-backfill`, then SSH
 * to EC2 and `docker run --rm --env-file .env <image> 2>&1 | tee log`.
 */

import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';

const JOB_NAME = 'album-metadata-backfill';

/**
 * Run the INSERT inside a transaction so `SET LOCAL statement_timeout`
 * actually scopes. Outside a transaction the postgres-js driver auto-commits
 * per execute and `SET LOCAL` becomes a silent no-op — the 15-minute
 * guardrail would then disappear.
 */
const runBackfill = async (): Promise<number> => {
  console.log(`[${JOB_NAME}] Starting historical backfill of album_metadata.`);

  const startedAt = Date.now();
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '15min'`);
    const result = await tx.execute(sql`
      INSERT INTO "wxyc_schema"."album_metadata"
        ("album_id", "artwork_url", "discogs_url", "release_year",
         "spotify_url", "apple_music_url", "youtube_music_url",
         "bandcamp_url", "soundcloud_url", "artist_bio",
         "artist_wikipedia_url", "updated_at")
      SELECT DISTINCT ON ("album_id")
        "album_id", "artwork_url", "discogs_url", "release_year",
        "spotify_url", "apple_music_url", "youtube_music_url",
        "bandcamp_url", "soundcloud_url", "artist_bio",
        "artist_wikipedia_url",
        COALESCE("metadata_attempt_at", now())
      FROM "wxyc_schema"."flowsheet"
      WHERE "album_id" IS NOT NULL
        AND "metadata_attempt_at" IS NOT NULL
      ORDER BY "album_id", "metadata_attempt_at" DESC NULLS LAST
      ON CONFLICT ("album_id") DO NOTHING
    `);
    return Number(result.count ?? 0);
  });

  const elapsedMs = Date.now() - startedAt;
  console.log(`[${JOB_NAME}] INSERT done: ${inserted} album_metadata row(s) in ${formatDuration(elapsedMs)}.`);
  return inserted;
};

/**
 * Pair the bulk insert with ANALYZE so the planner stops using the
 * empty-table statistics that `album_metadata` shipped with from D1 (the
 * fresh CREATE TABLE in migration 0079 left pg_statistic empty). Per
 * docs/bulk-update-playbook.md.
 */
const analyzeTable = async (): Promise<void> => {
  console.log(`[${JOB_NAME}] Running ANALYZE on album_metadata.`);
  await db.execute(sql`ANALYZE "wxyc_schema"."album_metadata"`);
};

/**
 * Verify completeness via the same filter as the INSERT, anti-joined against
 * `album_metadata`. A non-zero count points to either concurrent writes during
 * the run (rare on an off-hours window) or a row that materialized between
 * the INSERT and the verify. Re-running the job is safe — the INSERT is
 * idempotent via `ON CONFLICT DO NOTHING`.
 */
const verifyComplete = async (): Promise<void> => {
  const result = await db.execute(sql`
    SELECT count(*)::int AS missing
    FROM "wxyc_schema"."flowsheet" AS f
    LEFT JOIN "wxyc_schema"."album_metadata" AS am ON f."album_id" = am."album_id"
    WHERE f."album_id" IS NOT NULL
      AND f."metadata_attempt_at" IS NOT NULL
      AND am."album_id" IS NULL
  `);
  const missing = Number((result as unknown as Array<{ missing: number }>)[0]?.missing ?? 0);
  if (missing > 0) {
    throw new Error(
      `[${JOB_NAME}] Verification failed: ${missing} flowsheet row(s) still have no matching album_metadata. ` +
        `Re-run the backfill — it is idempotent and will pick up the remaining rows.`
    );
  }
  console.log(
    `[${JOB_NAME}] Verification passed: every enriched flowsheet row has a corresponding album_metadata row.`
  );
};

const formatDuration = (ms: number): string => {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
};

const main = async () => {
  try {
    await runBackfill();
    await analyzeTable();
    await verifyComplete();
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  process.exitCode = 1;
});

// Exports for unit tests. Production entry point is the `main()` invocation
// above; tests reach into the individual primitives.
export { runBackfill, analyzeTable, verifyComplete, formatDuration };
