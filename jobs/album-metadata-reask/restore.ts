/**
 * The re-ask's restore mode (BS#3148; BS#3137 decision 7): one statement per target in one transaction, `library`
 * first, then `album_metadata`. Each restores only what nothing has touched since: the album's row must still have
 * `updated_at` equal to the `written_at` of its own `album_metadata` backup row for the run (every later writer bumps
 * it), and a catalog cover must still equal the one the pass wrote. `album_metadata` goes last because its update
 * moves `updated_at`, which the library guard reads. It also writes a `restore` marker per restored album, which the
 * cohort reads as `restored` (`hold_restored`). A tsup entry for the integration spec.
 */

import { sql, type SQL } from 'drizzle-orm';
import { intArrayLiteral } from '@wxyc/database';
import { table, withStatementTimeout } from './cohort.js';
import { COLUMNS } from './write.js';

/** `REASK_RESTORE_STATEMENT_TIMEOUT_MS` default; the container's 5 s is too short for a whole run's restore. */
export const RESTORE_STATEMENT_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Which backup rows a restore reads: one run's, narrowed to `albumIds` when it is not empty. */
export interface RestoreScope {
  runId: string;
  albumIds: readonly number[];
}

const BACKUP = table('album_metadata_reask_backup');

const inScope = (alias: 'b' | 'lb', { runId, albumIds }: RestoreScope): SQL => {
  const backup = sql.raw(alias);
  const listed =
    albumIds.length > 0 ? sql` AND ${backup}.album_id = ANY(${intArrayLiteral([...albumIds])}::int[])` : sql``;
  return sql`${backup}.run_id = ${runId}::text${listed}`;
};

const lockClause = (lock: boolean, tables: string): SQL => sql.raw(lock ? ` FOR UPDATE OF ${tables}` : '');

type Hits = (scope: RestoreScope, lock: boolean) => SQL;

/** The run's album writes whose row is untouched since. */
const albumHits: Hits = (scope, lock) => sql`SELECT b.row_id AS album_id, b.before_image, b.after_image, b.provenance
    FROM ${BACKUP} b
    JOIN ${table('album_metadata')} am ON am."album_id" = b.row_id AND am."updated_at" = b.written_at
   WHERE ${inScope('b', scope)} AND b.target_table = 'album_metadata'${lockClause(lock, 'am')}`;

/** The run's catalog cover rewrites whose album is untouched since and whose cover is still the one written. */
const libraryHits: Hits = (scope, lock) => sql`SELECT l."id" AS id, lb.before_image->>'artwork_url' AS prior_cover
    FROM ${BACKUP} lb
    JOIN ${BACKUP} b ON b.run_id = lb.run_id AND b.target_table = 'album_metadata' AND b.row_id = lb.album_id
    JOIN ${table('album_metadata')} am ON am."album_id" = b.row_id AND am."updated_at" = b.written_at
    JOIN ${table('library')} l ON l."id" = lb.row_id AND l."artwork_url" IS NOT DISTINCT FROM lb.after_image->>'artwork_url'
   WHERE ${inScope('lb', scope)} AND lb.target_table = 'library'${lockClause(lock, 'am, l')}`;

/** The read-only probe: per target, the run's backup rows and how many of them a restore would put back. */
export const restoreProbeSql = (scope: RestoreScope): SQL => sql`SELECT
       count(*) FILTER (WHERE b.target_table = 'album_metadata')::int AS album_metadata_backups,
       (SELECT count(*)::int FROM (${albumHits(scope, false)}) h) AS album_metadata_restorable,
       count(*) FILTER (WHERE b.target_table = 'library')::int AS library_backups,
       (SELECT count(*)::int FROM (${libraryHits(scope, false)}) h) AS library_restorable
  FROM ${BACKUP} b WHERE ${inScope('b', scope)}`;

/** Put back each catalog cover the pass rewrote, where the guard still holds. */
export const restoreLibrarySql = (scope: RestoreScope): SQL => sql`WITH hit AS (
  ${libraryHits(scope, true)}
)
UPDATE ${table('library')} l
   SET "artwork_url" = h.prior_cover
  FROM hit h
 WHERE l."id" = h.id
RETURNING l."id"`;

/**
 * Put back the 13 imaged columns from the before-image, which always holds all of them, so `jsonb_populate_record`
 * never meets a missing key; and write a `restore` marker per restored album in the same statement.
 */
export const restoreAlbumSql = (scope: RestoreScope): SQL => sql`WITH hit AS (
  ${albumHits(scope, true)}
), restored AS (
  UPDATE ${table('album_metadata')} am
     SET ${sql.join(
       COLUMNS.map((key) => sql`${sql.identifier(key)} = p.${sql.identifier(key)}`),
       sql`, `
     )}, "updated_at" = NOW()
    FROM hit h, jsonb_populate_record(NULL::${table('album_metadata')}, h.before_image) p
   WHERE am."album_id" = h.album_id
  RETURNING am."album_id" AS album_id
)
INSERT INTO ${BACKUP} (run_id, target_table, row_id, album_id, before_image, after_image, provenance, written_at)
SELECT ${scope.runId}::text, 'restore', h.album_id, h.album_id, h.after_image, h.before_image, jsonb_build_object('restored_run_id', ${scope.runId}::text, 'restored_write', h.provenance), NOW()
  FROM hit h JOIN restored r ON r.album_id = h.album_id
RETURNING album_id`;

export interface RestoreTargetCounts {
  /** The run's backup rows for this target, in scope. */
  backed_up: number;
  /** Rows the guards still allow a restore of. */
  restorable: number;
  /** Rows put back; 0 on a dry run. */
  restored: number;
}

export interface RestoreResult {
  album_metadata: RestoreTargetCounts;
  library: RestoreTargetCounts;
  /** `<table>: <error>` for each `ANALYZE` that failed after the restore committed, else null. Not thrown. */
  analyze_error: string | null;
}

/** Library first: its guard reads the `updated_at` that the album statement then moves. */
const TARGETS = [
  { name: 'library', write: restoreLibrarySql },
  { name: 'album_metadata', write: restoreAlbumSql },
] as const;

/**
 * One run's restore: the probe and, with `execute`, each target's statement, only when the probe found rows for it
 * (a zero-row `library` UPDATE still bumps the catalog watermark), in one transaction under `SET LOCAL
 * statement_timeout`. Then `ANALYZE` each table written, in its own transaction (`docs/bulk-update-playbook.md`).
 */
export const runRestore = async (
  scope: RestoreScope,
  { execute, timeoutMs = RESTORE_STATEMENT_TIMEOUT_DEFAULT }: { execute: boolean; timeoutMs?: number }
): Promise<RestoreResult> => {
  const result = await withStatementTimeout(timeoutMs, async (tx): Promise<RestoreResult> => {
    const [probe] = (await tx.execute(restoreProbeSql(scope))) as unknown as Array<Record<string, number>>;
    const counts = (name: string): RestoreTargetCounts => ({
      backed_up: Number(probe[`${name}_backups`]),
      restorable: Number(probe[`${name}_restorable`]),
      restored: 0,
    });
    const out: RestoreResult = {
      album_metadata: counts('album_metadata'),
      library: counts('library'),
      analyze_error: null,
    };
    for (const { name, write } of TARGETS) {
      if (execute && out[name].restorable > 0) {
        out[name].restored = ((await tx.execute(write(scope))) as unknown as unknown[]).length;
      }
    }
    return out;
  });
  for (const { name } of TARGETS) {
    if (result[name].restored === 0) {
      continue;
    }
    try {
      await withStatementTimeout(timeoutMs, (tx) => tx.execute(sql`ANALYZE ${table(name)}`));
    } catch (err) {
      const failed = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      result.analyze_error = result.analyze_error === null ? failed : `${result.analyze_error}; ${failed}`;
    }
  }
  return result;
};
