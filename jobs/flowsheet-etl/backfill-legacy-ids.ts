/**
 * One-time backfill: populate legacy_release_id on flowsheet entries and
 * legacy_dj_name/legacy_dj_id on shows for rows imported before PR #328.
 *
 * After updating legacy_release_id, resolves flowsheet.album_id via the
 * library.legacy_release_id join.
 *
 * Usage:
 *   npx tsx jobs/flowsheet-etl/backfill-legacy-ids.ts [--dry-run]
 *
 * Environment: same as the flowsheet ETL (DB_*, LEGACY_DB_DOCKER_CONTAINER or SSH_*).
 */

import { sql } from 'drizzle-orm';
import { db, flowsheet, library, closeDatabaseConnection, MirrorSQL } from '@wxyc/database';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 5000;

const legacyDB = MirrorSQL.instance();

// ---- Flowsheet: legacy_release_id ----

type ReleaseMapping = { entryId: number; releaseId: number };

const fetchReleaseMappings = async (): Promise<ReleaseMapping[]> => {
  console.log('[backfill] Fetching LIBRARY_RELEASE_ID mappings from tubafrenzy...');
  const raw = await legacyDB.send(`
    SELECT ID, LIBRARY_RELEASE_ID
    FROM FLOWSHEET_ENTRY_PROD
    WHERE LIBRARY_RELEASE_ID IS NOT NULL AND LIBRARY_RELEASE_ID != 0;
  `);

  if (raw.trim().length === 0) return [];

  const mappings: ReleaseMapping[] = [];
  for (const line of raw.trim().split('\n')) {
    const [entryIdStr, releaseIdStr] = line.split('\t');
    const entryId = Number(entryIdStr);
    const releaseId = Number(releaseIdStr);
    if (Number.isFinite(entryId) && Number.isFinite(releaseId) && releaseId !== 0) {
      mappings.push({ entryId, releaseId });
    }
  }

  console.log(`[backfill] Found ${mappings.length} entries with LIBRARY_RELEASE_ID.`);
  return mappings;
};

const backfillReleaseIds = async (mappings: ReleaseMapping[]): Promise<number> => {
  let totalUpdated = 0;

  for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
    const batch = mappings.slice(i, i + BATCH_SIZE);

    // Build VALUES list: (entry_id, release_id), ...
    const valuesList = batch.map((m) => `(${m.entryId}, ${m.releaseId})`).join(', ');

    if (DRY_RUN) {
      console.log(
        `[backfill] [dry-run] Would update ${batch.length} entries (batch ${Math.floor(i / BATCH_SIZE) + 1}).`
      );
      totalUpdated += batch.length;
      continue;
    }

    const result = await db.execute(
      sql.raw(`
      UPDATE ${getSchemaPrefix()}flowsheet f
      SET legacy_release_id = v.release_id::int
      FROM (VALUES ${valuesList}) AS v(entry_id, release_id)
      WHERE f.legacy_entry_id = v.entry_id
        AND f.legacy_release_id IS NULL
    `)
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- db.execute returns untyped result
    const count = Number((result as Record<string, unknown>).count ?? batch.length);
    totalUpdated += count;

    if ((i / BATCH_SIZE + 1) % 20 === 0) {
      console.log(`[backfill] ...${totalUpdated} flowsheet entries updated so far.`);
    }
  }

  return totalUpdated;
};

// ---- Shows: legacy_dj_name, legacy_dj_id ----

type DJMapping = { showId: number; djName: string | null; djId: number | null };

const fetchDJMappings = async (): Promise<DJMapping[]> => {
  console.log('[backfill] Fetching DJ_NAME/DJ_ID mappings from tubafrenzy...');
  const raw = await legacyDB.send(`
    SELECT
      ID,
      REPLACE(REPLACE(IFNULL(DJ_NAME, ''), '\\t', ' '), '\\n', ' '),
      DJ_ID
    FROM FLOWSHEET_RADIO_SHOW_PROD;
  `);

  if (raw.trim().length === 0) return [];

  const mappings: DJMapping[] = [];
  for (const line of raw.trim().split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const showId = Number(cols[0]);
    if (!Number.isFinite(showId)) continue;
    const djName = cols[1].trim().length > 0 && cols[1].trim() !== 'NULL' ? cols[1].trim() : null;
    const rawDjId = Number(cols[2]);
    const djId = Number.isFinite(rawDjId) && rawDjId !== 0 ? rawDjId : null;
    if (djName || djId) {
      mappings.push({ showId, djName, djId });
    }
  }

  console.log(`[backfill] Found ${mappings.length} shows with DJ info.`);
  return mappings;
};

const backfillDJInfo = async (mappings: DJMapping[]): Promise<number> => {
  let totalUpdated = 0;

  for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
    const batch = mappings.slice(i, i + BATCH_SIZE);

    if (DRY_RUN) {
      console.log(`[backfill] [dry-run] Would update ${batch.length} shows (batch ${Math.floor(i / BATCH_SIZE) + 1}).`);
      totalUpdated += batch.length;
      continue;
    }

    for (const m of batch) {
      const djNameValue = m.djName ? `'${m.djName.replace(/'/g, "''")}'` : 'NULL';
      const djIdValue = m.djId != null ? String(m.djId) : 'NULL';
      await db.execute(
        sql.raw(`
        UPDATE ${getSchemaPrefix()}shows
        SET legacy_dj_name = ${djNameValue}, legacy_dj_id = ${djIdValue}
        WHERE legacy_show_id = ${m.showId} AND legacy_dj_name IS NULL
      `)
      );
    }

    totalUpdated += batch.length;

    if ((i / BATCH_SIZE + 1) % 5 === 0) {
      console.log(`[backfill] ...${totalUpdated} shows updated so far.`);
    }
  }

  return totalUpdated;
};

// ---- Resolve album_id ----

const resolveAlbumIds = async (): Promise<void> => {
  if (DRY_RUN) {
    const preview = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM ${flowsheet} f
      JOIN ${library} l ON f.legacy_release_id = l.legacy_release_id
      WHERE f.legacy_release_id IS NOT NULL AND f.album_id IS NULL
    `);
    const rows = preview as Record<string, unknown>[];
    const count = rows.length > 0 ? (rows[0].count as number) : '?';
    console.log(`[backfill] [dry-run] Would resolve album_id for ${count} entries.`);
    return;
  }

  await db.execute(sql`
    UPDATE ${flowsheet} f
    SET album_id = l.id
    FROM ${library} l
    WHERE f.legacy_release_id = l.legacy_release_id
      AND f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `);
  console.log('[backfill] Resolved album_id via legacy_release_id join.');
};

// ---- Helpers ----

const getSchemaPrefix = (): string => {
  const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  return `"${schema}".`;
};

// ---- Main ----

const main = async () => {
  if (DRY_RUN) {
    console.log('[backfill] Running in DRY-RUN mode — no database changes will be made.\n');
  }

  // 1. Backfill flowsheet.legacy_release_id
  const releaseMappings = await fetchReleaseMappings();
  if (releaseMappings.length > 0) {
    const updated = await backfillReleaseIds(releaseMappings);
    console.log(`[backfill] Flowsheet legacy_release_id: ${updated} entries updated.`);
  } else {
    console.log('[backfill] No release mappings found — skipping flowsheet backfill.');
  }

  // 2. Resolve album_id from legacy_release_id
  await resolveAlbumIds();

  // 3. Backfill shows.legacy_dj_name and legacy_dj_id
  const djMappings = await fetchDJMappings();
  if (djMappings.length > 0) {
    const updated = await backfillDJInfo(djMappings);
    console.log(`[backfill] Shows DJ info: ${updated} shows updated.`);
  } else {
    console.log('[backfill] No DJ mappings found — skipping shows backfill.');
  }

  console.log('\n[backfill] Done.');
};

main()
  .catch((err) => {
    console.error('[backfill] Fatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    legacyDB.close();
    await closeDatabaseConnection();
  });
