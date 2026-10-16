/**
 * Startup reconciliation for a `catalog_export_flag_state`-tracked env flag
 * (BS#2318 schema; BS#2320 first consumer, `DIGITAL_ARCHIVE_STREAMING_ENABLED`).
 *
 * WHY THIS EXISTS. `GET /library/catalog` is served through
 * `createWatermarkCache` + `conditionalGet(getCatalogLastModifiedAt)`
 * (`middleware/conditionalGet.ts`): a client with an unchanged
 * `Last-Modified` gets a cheap 304 forever. A flag that changes the export
 * projection (today, `has_digital_audio`) but touches no `library`/
 * `digital_asset` row does not advance `library_watermark` on its own — a
 * container recreate clears the in-process cache, but every device keeps
 * 304-ing against a stale `Last-Modified`. A kill-switch-off would leave
 * badges up over a now-403ing endpoint; a light-up would leave badges dark
 * until an unrelated library write happens to move the watermark. This runs
 * once per boot (every flip already recreates the container, so that is
 * exactly when it needs to run) and calls
 * `wxyc_schema.touch_library_watermark_now()` when — and only when — the
 * flag's value actually changed since it was last observed.
 *
 * ABSENT ROW = FALSE, NOT "UNKNOWN" (issue #2320 decision comment). A
 * client's decode of the optional `has_digital_audio` already treats an
 * absent key as `false`, so a first boot with no `catalog_export_flag_state`
 * row for this name tells clients nothing they don't already believe when
 * the env flag is also `false` — write the row (so the NEXT boot has a real
 * "last observed" value to diff against) but do NOT touch the watermark. A
 * first boot with the flag `true`, though, genuinely is a change from every
 * client's current belief and must touch.
 *
 * `changed_at` is set EXPLICITLY on the UPDATE path: migration 0158 declares
 * it `DEFAULT now()`, which fires on INSERT only, so an UPDATE that relied on
 * the default would leave a stale timestamp on the one row whose purpose is
 * recording when the flip happened.
 *
 * ONE TRANSACTION (BS#2334). The state-row write and the watermark touch run
 * in a single `db.transaction`, so a failed touch rolls the row back: the
 * next boot still sees the change and retries the touch. Every statement
 * therefore goes through the transaction handle (`tx.execute`), never the
 * top-level `db` — a statement on `db` would commit on its own and bring the
 * defect back. `tests/integration/catalog-export-flag-reconcile.spec.js`
 * pins the rollback and retry against real Postgres.
 *
 * Raw `tx.execute` throughout, not the query builder — a plain `.where()`
 * read is not itself awaitable against this repo's unit-test `db` mock
 * (only `.execute()`/`.returning()` are), and this module's own unit tests
 * exercise it that way.
 */

import { sql } from 'drizzle-orm';
import { db, catalog_export_flag_state, type DbTransaction } from '@wxyc/database';

/** `RETURNS void` wrapper around 0104's watermark UPDATE (migration 0159) —
 * `touch_library_watermark()` itself is `RETURNS trigger` and cannot be
 * `SELECT`ed from application code. */
const touchLibraryWatermarkNow = (tx: DbTransaction): Promise<unknown> =>
  tx.execute(sql`SELECT wxyc_schema.touch_library_watermark_now()`);

/**
 * Reconciles one flag by name against its last-observed value, writing
 * `catalog_export_flag_state` and touching the watermark exactly when the
 * value changed. Call once per boot, per flag, from the app's startup
 * sequence.
 */
export async function reconcileCatalogExportFlag(envVarName: string): Promise<void> {
  // One transaction, so a failed watermark touch rolls back the state-row
  // write and the next boot sees the same change and retries the touch.
  await db.transaction((tx) => reconcileInTransaction(tx, envVarName));
}

async function reconcileInTransaction(tx: DbTransaction, envVarName: string): Promise<void> {
  const current = process.env[envVarName] === 'true';
  const currentValue = current ? 'true' : 'false';

  const rows = await tx.execute(sql`
    SELECT ${catalog_export_flag_state.value} AS value
    FROM ${catalog_export_flag_state}
    WHERE ${catalog_export_flag_state.name} = ${envVarName}
  `);
  const existing = (rows as unknown as { value: string }[])[0];

  if (existing === undefined) {
    // First boot for this flag name: absent reads as `false` (see module
    // doc comment). Write unconditionally so the next boot has a real
    // last-observed value; touch only if this boot's value is a change from
    // that assumed `false`.
    await tx.execute(sql`
      INSERT INTO ${catalog_export_flag_state} (name, value) VALUES (${envVarName}, ${currentValue})
    `);
    if (current) {
      await touchLibraryWatermarkNow(tx);
    }
    return;
  }

  const previous = existing.value === 'true';
  if (previous === current) {
    return;
  }

  await tx.execute(sql`
    UPDATE ${catalog_export_flag_state}
    SET value = ${currentValue}, changed_at = now()
    WHERE ${catalog_export_flag_state.name} = ${envVarName}
  `);
  await touchLibraryWatermarkNow(tx);
}
