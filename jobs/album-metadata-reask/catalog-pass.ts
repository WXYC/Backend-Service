/**
 * The re-ask's catalog cover pass (BS#3146; BS#3137 decision 4). `library.artwork_url` is rewritten only where it
 * still equals the cover a run's album write replaced (`before_image->>'artwork_url'`): the copy this job can prove
 * came from the wrong release. A catalog cover that differs came from a librarian or another backfill and is left
 * alone, and so is an album whose stored cover changed since its write (`am.artwork_url` no longer equals
 * `after_image->>'artwork_url'`). The guard is the cover, not `updated_at` as in restore (BS#3274): the bio fill, the
 * streaming drains and the enrichment UPSERT bump `updated_at` without touching the cover, and must not cost an album
 * its catalog cover fix when `--catalog-pass` runs later for a run that died.
 *
 * The catalog watermark trigger (`touch_library_watermark`, migration 0185) is `FOR EACH STATEMENT` and fires even on
 * a zero-row UPDATE, and each bump makes every client re-download the catalog (BS#2052). So a run sends one read-only
 * probe and, only when it finds rows, one guarded statement that writes every `library` backup row and updates only
 * the rows it backed up. Idempotent: a rewritten album has its `library` backup row, which the next pass skips.
 * A tsup entry for the integration spec.
 */

import { sql, type SQL } from 'drizzle-orm';
import { table, withStatementTimeout } from './cohort.js';

/** `REASK_CATALOG_STATEMENT_TIMEOUT_MS` default; the container's 5 s is too short for the write with its CDC trigger. */
export const CATALOG_STATEMENT_TIMEOUT_DEFAULT = 30 * 1000;

/**
 * The covers to rewrite for one run. `cand` is the run's album writes whose stored cover is still the one written,
 * and not yet passed; `hit` is their catalog rows whose cover still mirrors the old one. The write locks both the
 * `album_metadata` and the `library` rows, so a row another writer commits meanwhile is re-checked on its latest
 * version; the probe locks nothing.
 */
const hitCtes = (runId: string, lock: boolean): SQL => sql`WITH cand AS (
  SELECT b.album_id, b.before_image->>'artwork_url' AS old_cover,
         b.after_image->>'artwork_url' AS new_cover, b.provenance
    FROM ${table('album_metadata_reask_backup')} b
    JOIN ${table('album_metadata')} am ON am."album_id" = b.row_id
   WHERE b.run_id = ${runId}::text AND b.target_table = 'album_metadata'
     AND am."artwork_url" IS NOT DISTINCT FROM b.after_image->>'artwork_url'
     AND NOT EXISTS (SELECT 1 FROM ${table('album_metadata_reask_backup')} lb
                      WHERE lb.run_id = b.run_id AND lb.target_table = 'library' AND lb.row_id = b.album_id)${sql.raw(
                        lock ? ' FOR UPDATE OF am' : ''
                      )}
), hit AS (
  SELECT l."id" AS id, l."artwork_url" AS prior_cover, c.new_cover, c.provenance
    FROM ${table('library')} l JOIN cand c ON c.album_id = l."id"
   WHERE l."artwork_url" IS NOT NULL AND l."artwork_url" = c.old_cover AND c.new_cover IS DISTINCT FROM l."artwork_url"${sql.raw(
     lock ? ' FOR UPDATE OF l' : ''
   )}
)`;

/** The read-only probe: the run's album writes (none means a wrong run_id) and the catalog covers it would rewrite. */
export const catalogProbeSql = (runId: string): SQL => sql`${hitCtes(runId, false)}
SELECT (SELECT count(*)::int FROM ${table('album_metadata_reask_backup')} w
         WHERE w.run_id = ${runId}::text AND w.target_table = 'album_metadata') AS album_writes,
       count(*)::int AS n FROM hit`;

/** The one guarded statement: the `library` backup rows, then the update of exactly the rows they back up. */
export const catalogPassSql = (runId: string): SQL => sql`${hitCtes(runId, true)}, backup AS (
  INSERT INTO ${table('album_metadata_reask_backup')}
         (run_id, target_table, row_id, album_id, before_image, after_image, provenance, written_at)
  SELECT ${runId}::text, 'library', h.id, h.id, jsonb_build_object('artwork_url', h.prior_cover), jsonb_build_object('artwork_url', h.new_cover), h.provenance, NOW()
    FROM hit h
  RETURNING row_id
)
UPDATE ${table('library')} l
   SET "artwork_url" = h.new_cover
  FROM hit h JOIN backup bk ON bk.row_id = h.id
 WHERE l."id" = h.id
RETURNING l."id"`;

export interface CatalogPassResult {
  /** The run's `album_metadata` backup rows; 0 means no such run. */
  album_writes: number;
  /** Covers the probe found; 0 means nothing else was sent. */
  probed: number;
  /** Covers rewritten; fewer than `probed` when a row moved between the probe and the write. */
  rewritten: number;
  /**
   * Why `ANALYZE` failed after a pass that wrote, else null. Not thrown: the rewrite and its backup rows have already
   * committed, and a rerun finds nothing to do, so the counts must still reach the caller.
   */
  analyze_error: string | null;
}

/**
 * One run's catalog cover pass: the probe and, only when it finds rows, the write, in one transaction under
 * `SET LOCAL statement_timeout`; then, if anything was written, `ANALYZE` the catalog in its own transaction under the
 * same timeout (`docs/bulk-update-playbook.md`).
 */
export const runCatalogPass = async (
  runId: string,
  timeoutMs: number = CATALOG_STATEMENT_TIMEOUT_DEFAULT
): Promise<CatalogPassResult> => {
  const result = await withStatementTimeout(timeoutMs, async (tx): Promise<CatalogPassResult> => {
    const [probe] = (await tx.execute(catalogProbeSql(runId))) as unknown as Array<{ album_writes: number; n: number }>;
    const probed = Number(probe.n);
    // Only when the probe found rows: a zero-row UPDATE still bumps the catalog watermark.
    const rewritten = probed === 0 ? 0 : ((await tx.execute(catalogPassSql(runId))) as unknown as unknown[]).length;
    return { album_writes: Number(probe.album_writes), probed, rewritten, analyze_error: null };
  });
  if (result.rewritten > 0) {
    try {
      await withStatementTimeout(timeoutMs, (tx) => tx.execute(sql`ANALYZE ${table('library')}`));
    } catch (err) {
      result.analyze_error = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
};
