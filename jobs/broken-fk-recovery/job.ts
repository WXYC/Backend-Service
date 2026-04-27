/**
 * One-shot job: recover broken-FK flowsheet entries (B-0.5).
 *
 * Of the 1.18M unlinked flowsheet rows, 292K (15%) have a non-null
 * legacy_release_id whose value isn't in library.legacy_release_id. Some
 * fraction of those land after subsequent library imports — re-running the
 * existing legacy-FK resolver picks them up without LML. The residual is
 * the genuinely-unrecoverable bucket that B-2.2 will hand to LML.
 *
 * Phases:
 *   1. reresolveAlbumIds — re-runs the same UPDATE the flowsheet ETL ships,
 *      idempotent over album_id IS NULL.
 *   2. classifyUnresolvable — counts the residual split by missing vs.
 *      collision vs. other, single round-trip via FILTER aggregates.
 *   3. markUnresolvable — stamps legacy_link_attempted_at = now() so B-2.2
 *      can join (legacy_release_id IS NULL OR legacy_link_attempted_at IS
 *      NOT NULL) to find both broken-FK and never-had-FK buckets in one
 *      predicate.
 *
 * The classification report is printed to stdout. The operator pastes it as
 * a comment on issue #493 (per the issue's acceptance criteria).
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=broken-fk-recovery`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`.
 */

import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';

const JOB_NAME = 'broken-fk-recovery';

export type ClassificationCounts = {
  missing: number;
  collision: number;
  other: number;
  total: number;
};

/**
 * Re-run the legacy-FK album_id resolver against any flowsheet rows that
 * still have album_id IS NULL but a non-null legacy_release_id. Mirrors the
 * resolver in jobs/flowsheet-etl/job.ts — duplicated rather than imported
 * because the ETL package is a separate workspace and importing across job
 * packages would couple their build graphs.
 */
export const reresolveAlbumIds = async (): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet" AS f
    SET "album_id" = l."id"
    FROM "wxyc_schema"."library" AS l
    WHERE f."legacy_release_id" = l."legacy_release_id"
      AND f."legacy_release_id" IS NOT NULL
      AND f."album_id" IS NULL
  `);
  const resolved = Number(result.count ?? 0);
  console.log(`[${JOB_NAME}] Re-resolved album_id for ${resolved} flowsheet rows.`);
  return resolved;
};

/**
 * Classify the residual broken-FK rows into missing / collision / other in
 * a single round-trip. Postgres-js returns COUNT() as a string in some
 * driver configurations, so coerce every column to Number defensively.
 *
 * "missing" — flowsheet's legacy_release_id has zero matching library rows
 * (the typical post-deletion case).
 * "collision" — legacy_release_id matches multiple library rows. Structurally
 * impossible while library_legacy_release_id_idx is unique, but the SQL
 * carries the case forward in case a future migration relaxes that.
 * "other" — anything else (e.g. legacy_release_id IS 0 / sentinel data
 * the ETL didn't fully normalize).
 */
export const classifyUnresolvable = async (): Promise<ClassificationCounts> => {
  const rows = (await db.execute(sql`
    WITH unresolved AS (
      SELECT f."id", f."legacy_release_id"
      FROM "wxyc_schema"."flowsheet" AS f
      WHERE f."album_id" IS NULL
        AND f."legacy_release_id" IS NOT NULL
    ),
    counts AS (
      SELECT
        u."id",
        u."legacy_release_id",
        (SELECT COUNT(*) FROM "wxyc_schema"."library" AS l
          WHERE l."legacy_release_id" = u."legacy_release_id") AS lib_match_count
      FROM unresolved u
    )
    SELECT
      COUNT(*) FILTER (WHERE "lib_match_count" = 0 AND "legacy_release_id" > 0) AS "missing",
      COUNT(*) FILTER (WHERE "lib_match_count" > 1) AS "collision",
      COUNT(*) FILTER (WHERE "lib_match_count" = 0 AND ("legacy_release_id" <= 0)) AS "other",
      COUNT(*) AS "total"
    FROM counts
  `)) as unknown as Array<{
    missing: number | string;
    collision: number | string;
    other: number | string;
    total: number | string;
  }>;
  const row = rows[0];
  if (!row) return { missing: 0, collision: 0, other: 0, total: 0 };
  return {
    missing: Number(row.missing ?? 0),
    collision: Number(row.collision ?? 0),
    other: Number(row.other ?? 0),
    total: Number(row.total ?? 0),
  };
};

/**
 * Stamp legacy_link_attempted_at = now() on the broken-FK residual.
 *
 * Idempotent: the `legacy_link_attempted_at IS NULL` filter means a second
 * run skips rows already stamped, preserving the original "first attempted
 * at" timestamp. That matters for any future audit trying to reconstruct
 * when a row first fell off the legacy-FK path.
 */
export const markUnresolvable = async (): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet" AS f
    SET "legacy_link_attempted_at" = now()
    WHERE f."album_id" IS NULL
      AND f."legacy_release_id" IS NOT NULL
      AND f."legacy_link_attempted_at" IS NULL
  `);
  const stamped = Number(result.count ?? 0);
  console.log(`[${JOB_NAME}] Stamped legacy_link_attempted_at on ${stamped} unresolvable rows.`);
  return stamped;
};

/**
 * Produce a comment-friendly report of the classification. The operator
 * pastes this onto issue #493 per the acceptance criteria.
 */
export const formatReport = (counts: ClassificationCounts): string => {
  const fmt = (n: number) => n.toLocaleString('en-US');
  return [
    `Broken-FK recovery classification:`,
    `  missing   (no library row): ${fmt(counts.missing)}`,
    `  collision (multiple library rows): ${fmt(counts.collision)}`,
    `  other     (sentinel / non-positive legacy_release_id): ${fmt(counts.other)}`,
    `  total     residual: ${fmt(counts.total)}`,
  ].join('\n');
};

export const runRecovery = async (): Promise<{
  resolved: number;
  marked: number;
  counts: ClassificationCounts;
}> => {
  console.log(`[${JOB_NAME}] Starting broken-FK recovery.`);
  const resolved = await reresolveAlbumIds();
  const counts = await classifyUnresolvable();
  console.log(formatReport(counts));
  const marked = await markUnresolvable();
  console.log(`[${JOB_NAME}] Done. Resolved ${resolved}; marked ${marked} as legacy-FK unresolvable.`);
  return { resolved, marked, counts };
};

const main = async () => {
  try {
    await runRecovery();
  } finally {
    await closeDatabaseConnection();
  }
};

if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    console.error(`[${JOB_NAME}] Failed:`, error);
    process.exitCode = 1;
  });
}
