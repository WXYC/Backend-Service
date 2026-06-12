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
 * Idempotent and re-runnable: skips rows where BS's legacy_dj_name already
 * matches tubafrenzy's DJ_HANDLE (trimmed, case-sensitive), so a second pass
 * is a no-op. Marker dj_name re-resolution is scoped to rows whose current
 * dj_name equals the pre-update legacy_dj_name (the polluted value), so DJ-set
 * names from `auth_user.dj_name` aren't touched.
 *
 * Run procedure: Manual Build & Deploy with
 * `target=legacy-dj-name-remediation`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`. Pass
 * `--dry-run` as the docker CMD arg for a no-op preview.
 *
 * Environment: same as the flowsheet ETL (DB_*, LEGACY_DB_DOCKER_CONTAINER or
 * SSH_*).
 */

import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection, MirrorSQL } from '@wxyc/database';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 5000;

const legacyDB = MirrorSQL.instance();

// ---- Helpers ----

const getSchemaPrefix = (): string => {
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  return `"${schema}".`;
};

// ---- Pull DJ_HANDLE mappings from tubafrenzy ----

type HandleMapping = { showId: number; djHandle: string | null };

const fetchHandleMappings = async (): Promise<HandleMapping[]> => {
  console.log('[remediate] Fetching DJ_HANDLE mappings from tubafrenzy...');
  const raw = await legacyDB.send(`
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
    const djHandle = trimmed.length > 0 && trimmed !== 'NULL' ? trimmed : null;
    mappings.push({ showId, djHandle });
  }

  console.log(`[remediate] Pulled ${mappings.length} (showId, DJ_HANDLE) rows from tubafrenzy.`);
  return mappings;
};

// ---- Scrub shows.legacy_dj_name ----

type ScrubResult = {
  showsScanned: number;
  showsUpdated: number;
  markerRowsReset: number;
};

/**
 * For each (legacyShowId, newDjHandle) pulled from tubafrenzy: read BS's
 * current `legacy_dj_name`, and if it differs, overwrite. In the same step,
 * NULL out marker-row `dj_name` values that match the old polluted
 * `legacy_dj_name` — these are the rows whose surfaced dj_name on the v2 wire
 * came from the fallback arm of the COALESCE (i.e. `auth_user.dj_name` was
 * NULL at write time). They are re-resolved by `reresolveMarkerDjNames` once
 * the scrub finishes.
 *
 * NULL-out scoping is by (show_id, entry_type, dj_name) — never by dj_name
 * alone — so an unrelated DJ on a different show whose handle happens to
 * match the old polluted value is not affected.
 */
const scrubLegacyDjName = async (mappings: HandleMapping[]): Promise<ScrubResult> => {
  let showsScanned = 0;
  let showsUpdated = 0;
  let markerRowsReset = 0;

  for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
    const batch = mappings.slice(i, i + BATCH_SIZE);

    for (const m of batch) {
      showsScanned++;
      const current = (await db.execute(
        sql.raw(`
          SELECT id, legacy_dj_name
          FROM ${getSchemaPrefix()}shows
          WHERE legacy_show_id = ${m.showId}
        `)
      )) as unknown as Array<{ id: number; legacy_dj_name: string | null }>;

      const row = current[0];
      if (!row) continue;

      const oldHandle = row.legacy_dj_name?.trim() ?? null;
      const newHandle = m.djHandle?.trim() ?? null;

      // No-op cases: both null, or already equal (trimmed). Skipping these
      // keeps the script idempotent and means a successful run followed by
      // a re-run reports `showsUpdated: 0`.
      if (oldHandle === newHandle) continue;

      if (DRY_RUN) {
        console.log(
          `[remediate] [dry-run] Would update show legacy_show_id=${m.showId}: ` +
            `legacy_dj_name ${JSON.stringify(oldHandle)} -> ${JSON.stringify(newHandle)}`
        );
        showsUpdated++;
        continue;
      }

      const newHandleSql = newHandle ? `'${newHandle.replace(/'/g, "''")}'` : 'NULL';
      await db.execute(
        sql.raw(`
          UPDATE ${getSchemaPrefix()}shows
          SET legacy_dj_name = ${newHandleSql}
          WHERE id = ${row.id}
        `)
      );
      showsUpdated++;

      // Reset marker-row dj_name only when it matches the old polluted value
      // for THIS show. Scoping by show_id avoids collateral damage to
      // DJs on other shows who happen to share a substring.
      if (oldHandle !== null) {
        const oldSql = `'${oldHandle.replace(/'/g, "''")}'`;
        const resetResult = await db.execute(
          sql.raw(`
            UPDATE ${getSchemaPrefix()}flowsheet
            SET dj_name = NULL
            WHERE show_id = ${row.id}
              AND entry_type IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
              AND dj_name = ${oldSql}
          `)
        );
        markerRowsReset += Number((resetResult as unknown as Record<string, unknown>).count ?? 0);
      }
    }

    if ((i / BATCH_SIZE + 1) % 5 === 0) {
      console.log(
        `[remediate] ...scanned ${showsScanned}, updated ${showsUpdated} shows, ` +
          `reset ${markerRowsReset} marker rows so far.`
      );
    }
  }

  return { showsScanned, showsUpdated, markerRowsReset };
};

// ---- Re-resolve flowsheet.dj_name on marker rows ----

/**
 * Re-resolve `flowsheet.dj_name` on marker rows whose value was nulled out by
 * the scrub. Matches the COALESCE chain used everywhere else: the show DJ's
 * `auth_user.dj_name` first (now-corrected), `shows.legacy_dj_name` second
 * (also now corrected). Never falls back to `auth_user.name` — that's the
 * PII leak we're closing.
 *
 * Rows left NULL after this pass are the asymmetric-fallback case the live
 * path also tolerates: the marker row stays, the v2 wire surfaces empty
 * `dj_name`, and downstream renderers degrade to "Start of show:" without a
 * name. Better than leaking PII.
 */
const reresolveMarkerDjNames = async (): Promise<number> => {
  if (DRY_RUN) {
    const preview = await db.execute(
      sql.raw(`
        SELECT count(*)::int AS pending
        FROM ${getSchemaPrefix()}flowsheet
        WHERE entry_type IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
          AND dj_name IS NULL
      `)
    );
    const pending = Number((preview as unknown as Array<{ pending: number }>)[0]?.pending ?? 0);
    console.log(`[remediate] [dry-run] Would re-resolve dj_name for up to ${pending} marker rows.`);
    return pending;
  }

  const result = await db.execute(
    sql.raw(`
      UPDATE ${getSchemaPrefix()}flowsheet AS f
      SET dj_name = COALESCE(u.dj_name, s.legacy_dj_name)
      FROM ${getSchemaPrefix()}shows AS s
      LEFT JOIN auth_user AS u ON u.id = s.primary_dj_id
      WHERE f.show_id = s.id
        AND f.entry_type IN ('show_start', 'show_end', 'dj_join', 'dj_leave')
        AND f.dj_name IS NULL
    `)
  );
  return Number((result as unknown as Record<string, unknown>).count ?? 0);
};

// ---- Main ----

const main = async () => {
  if (DRY_RUN) {
    console.log('[remediate] Running in DRY-RUN mode — no database changes will be made.\n');
  }

  const mappings = await fetchHandleMappings();
  if (mappings.length === 0) {
    console.log('[remediate] No handle mappings returned from tubafrenzy — nothing to do.');
    return;
  }

  const scrub = await scrubLegacyDjName(mappings);
  console.log(
    `[remediate] Scrub: scanned ${scrub.showsScanned} shows, updated ${scrub.showsUpdated}, ` +
      `reset ${scrub.markerRowsReset} marker rows.`
  );

  const reresolved = await reresolveMarkerDjNames();
  console.log(`[remediate] Re-resolved dj_name on ${reresolved} marker rows.`);

  console.log('\n[remediate] Done.');
};

main()
  .catch((err) => {
    console.error('[remediate] Fatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    legacyDB.close();
    await closeDatabaseConnection();
  });
