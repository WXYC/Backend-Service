/**
 * One-shot remediation: scrub `shows.legacy_dj_name` of values pulled from the
 * wrong tubafrenzy column.
 *
 * The flowsheet ETL historically pulled `FLOWSHEET_RADIO_SHOW_PROD.DJ_NAME`
 * (the user's full real name, sent into tubafrenzy via the BS legacy mirror as
 * `realName || name`) into `shows.legacy_dj_name`, instead of the intended
 * `DJ_HANDLE` (on-air alias). That column became visible on the public v2
 * flowsheet wire as `dj_name` on marker rows (show_start / show_end / dj_join /
 * dj_leave) through the resolver's `COALESCE(auth_user.dj_name,
 * shows.legacy_dj_name)` fallback — the PII leak surfaced after BS#1371 plumbed
 * marker dj_name onto the wire.
 *
 * The ETL source fix (fetch-legacy.ts, backfill-legacy-ids.ts, and the
 * bulk-load tuple-position in jobs/flowsheet-etl/job.ts) stops new writes of
 * DJ_NAME into `legacy_dj_name`. This job is the historical-data cleanup:
 * rewrite existing polluted rows from tubafrenzy's DJ_HANDLE column, then
 * re-resolve `flowsheet.dj_name` on the marker rows whose value came from the
 * old polluted legacy_dj_name so the v2 wire heals on the next read.
 *
 * Idempotent and re-runnable: rows where BS's legacy_dj_name already matches
 * tubafrenzy's DJ_HANDLE (trim-aware) are filtered out by the CTE's
 * `IS DISTINCT FROM` predicate, so a second pass is a no-op on already-clean
 * rows. Marker dj_name re-resolution is scoped to the exact show_ids whose
 * legacy_dj_name was just rewritten, so DJ-set names on other shows aren't
 * touched and the operator's logged "re-resolved N marker rows" count is
 * an honest remediation-coverage metric.
 *
 * Run procedure: Manual Build & Deploy with
 * `target=legacy-dj-name-remediation`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> --dry-run 2>&1 | tee log-dry`,
 * then re-run without `--dry-run`. (The image's ENTRYPOINT pins the launcher
 * so docker-level args reach the script directly.)
 *
 * Environment: same as the flowsheet ETL (DB_*, LEGACY_DB_DOCKER_CONTAINER or
 * SSH_*).
 */

import { sql, type SQL } from 'drizzle-orm';
import { db, closeDatabaseConnection, MirrorSQL } from '@wxyc/database';

export const DRY_RUN = process.argv.includes('--dry-run');
export const BATCH_SIZE = 5000;

// ---- Schema helper ----

/**
 * Build the schema-qualifier prefix for raw SQL. `WXYC_SCHEMA_NAME` defaults
 * to 'wxyc_schema'. Returned as a Drizzle `sql` fragment so it can be
 * interpolated safely into typed templates without losing quoting.
 */
export const schemaPrefix = (): SQL => {
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  return sql.raw(`"${schema}"`);
};

// ---- Pull DJ_HANDLE mappings from tubafrenzy ----

export type HandleMapping = { showId: number; djHandle: string | null };

export const fetchHandleMappings = async (mirror = MirrorSQL.instance()): Promise<HandleMapping[]> => {
  console.log('[remediate] Fetching DJ_HANDLE mappings from tubafrenzy...');
  const raw = await mirror.send(`
    SELECT
      ID,
      REPLACE(REPLACE(IFNULL(DJ_HANDLE, ''), '\\t', ' '), '\\n', ' ')
    FROM FLOWSHEET_RADIO_SHOW_PROD;
  `);

  if (raw.trim().length === 0) return [];

  const mappings: HandleMapping[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const showId = Number(cols[0]);
    if (!Number.isFinite(showId)) continue;
    const trimmed = cols[1].trim();
    // Reject NUL bytes — Postgres refuses text containing U+0000, and a
    // dirty row would otherwise abort the batch mid-flight. Treat as missing.
    if (trimmed.includes('\0')) continue;
    const djHandle = trimmed.length > 0 && trimmed !== 'NULL' ? trimmed : null;
    mappings.push({ showId, djHandle });
  }

  console.log(`[remediate] Pulled ${mappings.length} (showId, DJ_HANDLE) rows from tubafrenzy.`);
  return mappings;
};

// ---- Per-batch scrub via a single CTE ----

export interface BatchResult {
  showsUpdated: number;
  markerRowsReset: number;
  touchedShowIds: number[];
}

/**
 * Build the per-batch CTE. Three operations in one statement, evaluated in
 * a single snapshot:
 *
 *   1. `to_update` — SELECT shows whose stored `legacy_dj_name` differs from
 *      the incoming DJ_HANDLE (`IS DISTINCT FROM` on trimmed values, so
 *      whitespace-only or NULL-vs-empty drift counts as no-change).
 *   2. `updated_shows` — UPDATE `shows.legacy_dj_name` to the new handle for
 *      those rows.
 *   3. `nulled_markers` — UPDATE marker `flowsheet.dj_name` to NULL on the
 *      same shows where the stored marker value still matches the OLD
 *      polluted handle (trim-aware so trailing-whitespace pollution is
 *      caught). Re-resolution happens later in a scoped pass.
 *
 * Returns three counts plus the touched show_ids so the caller can scope the
 * subsequent re-resolve pass.
 */
const buildScrubBatchSql = (batch: HandleMapping[]): SQL => {
  // Drizzle parameter-binds each fragment; `sql.join` interleaves them with a
  // separator. Casts pin the column types for the VALUES list.
  const valuesRows = batch.map((m) => sql`(${m.showId}::int, ${m.djHandle}::text)`);
  const values = sql.join(valuesRows, sql`, `);
  const schema = schemaPrefix();

  return sql`
    WITH input(legacy_show_id, new_handle) AS (
      VALUES ${values}
    ),
    to_update AS (
      SELECT
        s.id              AS show_id,
        s.legacy_dj_name  AS old_handle,
        i.new_handle      AS new_handle
      FROM ${schema}.shows AS s
      JOIN input AS i ON i.legacy_show_id = s.legacy_show_id
      WHERE COALESCE(trim(s.legacy_dj_name), '') IS DISTINCT FROM COALESCE(trim(i.new_handle), '')
    ),
    updated_shows AS (
      UPDATE ${schema}.shows AS s
      SET legacy_dj_name = t.new_handle
      FROM to_update AS t
      WHERE s.id = t.show_id
      RETURNING s.id
    ),
    nulled_markers AS (
      UPDATE ${schema}.flowsheet AS f
      SET dj_name = NULL
      FROM to_update AS t
      WHERE f.show_id = t.show_id
        AND f.entry_type IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
        AND t.old_handle IS NOT NULL
        AND trim(f.dj_name) = trim(t.old_handle)
      RETURNING f.id
    )
    SELECT
      (SELECT count(*)::int FROM updated_shows)                       AS shows_updated,
      (SELECT count(*)::int FROM nulled_markers)                      AS markers_reset,
      COALESCE((SELECT array_agg(show_id) FROM to_update), '{}'::int[]) AS touched_show_ids
  `;
};

/**
 * Same shape as the live CTE but with no data-modifying steps — counts what
 * WOULD change without writing. Used for `--dry-run` previews so the
 * operator-visible numbers reflect the actual blast radius (not just the
 * pre-existing-NULL marker count).
 */
const buildScrubBatchPreviewSql = (batch: HandleMapping[]): SQL => {
  const valuesRows = batch.map((m) => sql`(${m.showId}::int, ${m.djHandle}::text)`);
  const values = sql.join(valuesRows, sql`, `);
  const schema = schemaPrefix();

  return sql`
    WITH input(legacy_show_id, new_handle) AS (
      VALUES ${values}
    ),
    to_update AS (
      SELECT
        s.id              AS show_id,
        s.legacy_dj_name  AS old_handle
      FROM ${schema}.shows AS s
      JOIN input AS i ON i.legacy_show_id = s.legacy_show_id
      WHERE COALESCE(trim(s.legacy_dj_name), '') IS DISTINCT FROM COALESCE(trim(i.new_handle), '')
    ),
    markers AS (
      SELECT f.id
      FROM ${schema}.flowsheet AS f
      JOIN to_update AS t ON f.show_id = t.show_id
      WHERE f.entry_type IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
        AND t.old_handle IS NOT NULL
        AND trim(f.dj_name) = trim(t.old_handle)
    )
    SELECT
      (SELECT count(*)::int FROM to_update)                            AS shows_updated,
      (SELECT count(*)::int FROM markers)                              AS markers_reset,
      COALESCE((SELECT array_agg(show_id) FROM to_update), '{}'::int[]) AS touched_show_ids
  `;
};

type ScrubBatchRow = {
  shows_updated: number;
  markers_reset: number;
  touched_show_ids: number[] | null;
};

/**
 * Execute one batch — modifying in live mode, count-only in dry-run. The
 * data-modifying CTEs run as a single statement inside an implicit
 * transaction, so the (shows UPDATE, flowsheet UPDATE) pair is atomic per
 * batch. A mid-run abort leaves the database in a consistent per-batch state.
 */
export const runScrubBatch = async (batch: HandleMapping[]): Promise<BatchResult> => {
  if (batch.length === 0) {
    return { showsUpdated: 0, markerRowsReset: 0, touchedShowIds: [] };
  }
  const query = DRY_RUN ? buildScrubBatchPreviewSql(batch) : buildScrubBatchSql(batch);
  const rows = (await db.execute(query)) as unknown as ScrubBatchRow[];
  const row = rows[0] ?? { shows_updated: 0, markers_reset: 0, touched_show_ids: [] };
  return {
    showsUpdated: Number(row.shows_updated ?? 0),
    markerRowsReset: Number(row.markers_reset ?? 0),
    touchedShowIds: row.touched_show_ids ?? [],
  };
};

// ---- Re-resolve flowsheet.dj_name on marker rows ----

/**
 * Re-resolve `flowsheet.dj_name` on marker rows whose value was nulled out by
 * the scrub. Scoped to `show_id = ANY(${touchedShowIds})` so this UPDATE
 * touches at most one row per nulled marker, not the whole table — avoiding
 * the BS#511 wedge pattern and keeping the reported count an honest
 * remediation-coverage metric.
 *
 * Matches the COALESCE chain used everywhere else: the show DJ's
 * `auth_user.dj_name` first (now-corrected via BS#1286 / BS#1371),
 * `shows.legacy_dj_name` second (also now-corrected by the scrub). Never
 * falls back to `auth_user.name` — that's the PII leak BS#1371 closed at the
 * leaf. Rows left NULL after this pass are the asymmetric-fallback case the
 * live path tolerates.
 */
export const reresolveMarkerDjNames = async (touchedShowIds: number[]): Promise<number> => {
  if (touchedShowIds.length === 0) return 0;
  const schema = schemaPrefix();

  if (DRY_RUN) {
    const preview = (await db.execute(sql`
      SELECT count(*)::int AS pending
      FROM ${schema}.flowsheet
      WHERE entry_type IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
        AND dj_name IS NULL
        AND show_id = ANY(${touchedShowIds})
    `)) as unknown as Array<{ pending: number }>;
    return Number(preview[0]?.pending ?? 0);
  }

  const result = await db.execute(sql`
    UPDATE ${schema}.flowsheet AS f
    SET dj_name = COALESCE(u.dj_name, s.legacy_dj_name)
    FROM ${schema}.shows AS s
    LEFT JOIN auth_user AS u ON u.id = s.primary_dj_id
    WHERE f.show_id = s.id
      AND f.entry_type IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
      AND f.dj_name IS NULL
      AND f.show_id = ANY(${touchedShowIds})
  `);
  return Number(result.count ?? 0);
};

// ---- ANALYZE post-pass (paired-bulk rule, docs/bulk-update-playbook.md) ----

/**
 * Refresh planner stats on `shows` + `flowsheet` after a bulk rewrite of
 * `shows.legacy_dj_name` and `flowsheet.dj_name`. Without this, the
 * `shows_legacy_dj_name_trgm_idx` and `flowsheet_search_doc_idx` go stale and
 * downstream search queries fall off the index path until autovacuum catches
 * up — same shape as the BS#934 dj-site autocomplete regression.
 *
 * Skipped in dry-run.
 */
export const analyzeTables = async (): Promise<void> => {
  if (DRY_RUN) return;
  const schema = schemaPrefix();
  await db.execute(sql`ANALYZE ${schema}.shows`);
  await db.execute(sql`ANALYZE ${schema}.flowsheet`);
};

// ---- Main ----

const formatBatchProgress = (
  i: number,
  totalBatches: number,
  batchResult: BatchResult,
  totals: { showsUpdated: number; markerRowsReset: number; touchedShowIds: number }
): string =>
  `[remediate] batch ${i + 1}/${totalBatches}: ` +
  `${batchResult.showsUpdated} shows updated, ${batchResult.markerRowsReset} marker rows reset. ` +
  `Cumulative: ${totals.showsUpdated} shows, ${totals.markerRowsReset} markers, ` +
  `${totals.touchedShowIds} touched show_ids.`;

export const runRemediation = async (): Promise<void> => {
  if (DRY_RUN) {
    console.log('[remediate] Running in DRY-RUN mode — no database changes will be made.\n');
  }

  const mappings = await fetchHandleMappings();
  if (mappings.length === 0) {
    console.log('[remediate] No handle mappings returned from tubafrenzy — nothing to do.');
    return;
  }

  const totalBatches = Math.ceil(mappings.length / BATCH_SIZE);
  let totalShowsUpdated = 0;
  let totalMarkerRowsReset = 0;
  const allTouchedShowIds: number[] = [];

  for (let i = 0; i < totalBatches; i++) {
    const batch = mappings.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const result = await runScrubBatch(batch);
    totalShowsUpdated += result.showsUpdated;
    totalMarkerRowsReset += result.markerRowsReset;
    allTouchedShowIds.push(...result.touchedShowIds);

    console.log(
      formatBatchProgress(i, totalBatches, result, {
        showsUpdated: totalShowsUpdated,
        markerRowsReset: totalMarkerRowsReset,
        touchedShowIds: allTouchedShowIds.length,
      })
    );
  }

  console.log(
    `[remediate] Scrub: ${totalShowsUpdated} shows updated, ${totalMarkerRowsReset} marker rows reset, ` +
      `${allTouchedShowIds.length} show_ids touched.`
  );

  const reresolved = await reresolveMarkerDjNames(allTouchedShowIds);
  console.log(`[remediate] Re-resolved dj_name on ${reresolved} marker rows (scoped to touched show_ids).`);

  await analyzeTables();
  if (!DRY_RUN) {
    console.log('[remediate] ANALYZE complete on shows + flowsheet.');
  }

  console.log('\n[remediate] Done.');
};

const main = async () => {
  try {
    await runRemediation();
  } finally {
    MirrorSQL.instance().close();
    await closeDatabaseConnection();
  }
};

main().catch((err) => {
  console.error('[remediate] Fatal error:', err);
  // Use exitCode (not exit) so the .finally body in main() completes —
  // matches the sibling flowsheet-dj-name-backfill pattern and avoids leaking
  // the SSH session + pg pool on the error path.
  process.exitCode = 1;
});
