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

const VERIFY_TIMEOUT_MS_ENV = 'ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS';
const VERIFY_TIMEOUT_MS_DEFAULT = 120_000;

const parseVerifyTimeoutMs = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') return VERIFY_TIMEOUT_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `[${JOB_NAME}] Invalid ${VERIFY_TIMEOUT_MS_ENV}=${raw}: must be a positive integer (milliseconds).`
    );
  }
  return parsed;
};

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
 * Verify completeness by comparing two aggregate counts: the size of
 * `album_metadata` against the number of distinct `album_id`s in the enriched
 * subset of flowsheet (the source set the INSERT enumerated).
 *
 * Wrapped in `db.transaction` + `SET LOCAL statement_timeout` because the
 * partial index from #660 (`idx_flowsheet_metadata_drain`) covers the
 * `metadata_attempt_at IS NULL` partition (drain direction) only — this
 * verify walks the opposite `IS NOT NULL` partition (~2.6M rows, no covering
 * index) and would otherwise trip the backend's default 5 s `statement_timeout`
 * (BS#1019 / BS#1022). `SET LOCAL` only scopes inside an explicit transaction
 * with the postgres-js driver (auto-commit per `execute` otherwise), which is
 * why both statements run on the closure-bound `tx` handle — running the
 * second statement against the top-level `db` would silently drop them onto
 * a different pooled connection and re-expose the 5 s default.
 *
 * The transaction wrapper sunsets naturally with D4 (#900) when the inline
 * columns drop and the verify shape changes; remove it then, not before.
 *
 * Invariant: `actual >= expected`. Equality is the steady state today
 * (D2 backfill only, no live writer to `album_metadata`). Once D3 (#899)
 * ships, a live UPSERT can land between this job's INSERT and the verify,
 * producing `actual > expected` legitimately — never the other way around,
 * since the INSERT is idempotent and never deletes. Re-running the job is
 * safe (`ON CONFLICT (album_id) DO NOTHING`).
 */
const verifyComplete = async (): Promise<void> => {
  const timeoutMs = parseVerifyTimeoutMs(process.env[VERIFY_TIMEOUT_MS_ENV]);

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const result = await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM "wxyc_schema"."album_metadata") AS actual,
        (SELECT count(DISTINCT "album_id")::int FROM "wxyc_schema"."flowsheet"
          WHERE "album_id" IS NOT NULL
            AND "metadata_attempt_at" IS NOT NULL) AS expected
    `);
    const row = (result as unknown as Array<{ actual: number; expected: number }>)[0];
    const actual = Number(row?.actual ?? 0);
    const expected = Number(row?.expected ?? 0);
    if (actual < expected) {
      throw new Error(
        `[${JOB_NAME}] Verification failed: album_metadata has ${actual} row(s), expected at least ${expected} ` +
          `from the enriched flowsheet subset. ` +
          `Re-run the backfill — it is idempotent and will pick up the remaining rows.`
      );
    }
    console.log(`[${JOB_NAME}] Verification passed: album_metadata=${actual} >= expected=${expected}.`);
  });
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
