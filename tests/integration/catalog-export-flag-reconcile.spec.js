/**
 * BS#2334 -- the catalog-export-flag reconciler must write the `catalog_export_flag_state` row and touch
 * `library_watermark` in ONE transaction, so a failed touch rolls the row back and the next boot sees the same change
 * and retries the touch.
 *
 * The unit test (`tests/unit/services/catalog-export-flag-reconcile.service.test.ts`) mocks `db` and proves only that
 * the statements run on the transaction handle and that a touch error propagates; it never models a rollback. This
 * spec runs the REAL `reconcileCatalogExportFlag` against real Postgres, in a `tsx` child process (the integration
 * runner is babel-jest and cannot import TypeScript; see `tests/utils/run-catalog-export-flag-reconcile.ts`).
 *
 * The one-line production mutation it catches: moving `touchLibraryWatermarkNow` (or the state-row write) outside
 * the `db.transaction` callback in `catalog-export-flag-reconcile.service.ts`. The unit test's mock still passes if
 * the touch error reaches the caller by some other path; only here does the first run leave the state row at its OLD
 * value, which is what makes the second run see a change and touch again.
 *
 * The failure is injected by replacing `wxyc_schema.touch_library_watermark_now()` with a function that raises. Only
 * the reconciler calls that function (the table triggers call `touch_library_watermark()`), so no other spec observes
 * the replacement, and the original definition (captured with `pg_get_functiondef`) is restored in a `finally` and
 * again in `afterAll`.
 */

const path = require('path');
const { getTestDb } = require('../utils/db');
const { runTsxDriver } = require('../utils/run-tsx-driver');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const FLAG = 'BS2334_PROBE_FLAG';
const DRIVER = path.join(__dirname, '..', 'utils', 'run-catalog-export-flag-reconcile.ts');

// The child boots tsx and loads the built `@wxyc/database`; give it room (jest.parallel.config.json sets no timeout).
const TEST_TIMEOUT_MS = 60000;

/** Runs the real reconciler in a child; returns `{ ok: true }` or `{ ok: false, message }`. */
function runReconciler(flagValue) {
  return runTsxDriver(DRIVER, [FLAG], {
    marker: 'RECONCILE_RESULT',
    timeoutMs: TEST_TIMEOUT_MS - 5000,
    env: { [FLAG]: flagValue },
  });
}

describe('reconcileCatalogExportFlag atomicity against real Postgres (BS#2334)', () => {
  let sql;
  let originalTouchDef;

  const restoreTouchFunction = async () => {
    if (originalTouchDef) {
      await sql.unsafe(originalTouchDef);
    }
  };

  beforeAll(async () => {
    sql = getTestDb();
    const rows = await sql.unsafe(
      `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = 'touch_library_watermark_now'`,
      [SCHEMA]
    );
    expect(rows).toHaveLength(1);
    originalTouchDef = rows[0].def;
    await sql.unsafe(`DELETE FROM "${SCHEMA}".catalog_export_flag_state WHERE name = $1`, [FLAG]);
  });

  afterAll(async () => {
    // Never leave the raising stub installed, whatever happened in the test body.
    await restoreTouchFunction();
    await sql.unsafe(`DELETE FROM "${SCHEMA}".catalog_export_flag_state WHERE name = $1`, [FLAG]);
  });

  const stateValue = async () => {
    const rows = await sql.unsafe(`SELECT value FROM "${SCHEMA}".catalog_export_flag_state WHERE name = $1`, [FLAG]);
    return rows.length === 0 ? null : rows[0].value;
  };

  const watermarkEpochMs = async () => {
    const rows = await sql.unsafe(
      `SELECT (EXTRACT(EPOCH FROM last_modified_at) * 1000)::bigint AS ms FROM "${SCHEMA}".library_watermark WHERE id = true`
    );
    return Number(rows[0].ms);
  };

  test(
    'a failed watermark touch rolls back the state row, and the next run retries the touch',
    async () => {
      // Baseline: the row records `false` (first boot, flag false: INSERT, no touch).
      expect(runReconciler('false')).toEqual({ ok: true });
      expect(await stateValue()).toBe('false');

      // Age the watermark so "advanced" is unambiguous (a direct write; no trigger sits on library_watermark).
      await sql.unsafe(
        `UPDATE "${SCHEMA}".library_watermark SET last_modified_at = now() - interval '1 hour' WHERE id = true`
      );
      const agedWatermark = await watermarkEpochMs();

      // Flip the flag to true while the touch raises.
      let failedRun;
      try {
        await sql.unsafe(
          `CREATE OR REPLACE FUNCTION "${SCHEMA}".touch_library_watermark_now() RETURNS void AS $$
           BEGIN RAISE EXCEPTION 'BS#2334 injected touch failure'; END;
           $$ LANGUAGE plpgsql`
        );
        failedRun = runReconciler('true');
      } finally {
        await restoreTouchFunction();
      }

      // The call rejected, and the state row did NOT move to 'true': the write rolled back with the failed touch.
      expect(failedRun.ok).toBe(false);
      expect(failedRun.message).toMatch(/injected touch failure/);
      expect(await stateValue()).toBe('false');
      expect(await watermarkEpochMs()).toBe(agedWatermark);

      // Next boot, touch healthy again: the reconciler still sees false -> true, writes it, and advances the watermark.
      expect(runReconciler('true')).toEqual({ ok: true });
      expect(await stateValue()).toBe('true');
      expect(await watermarkEpochMs()).toBeGreaterThan(agedWatermark + 30 * 60 * 1000);
    },
    TEST_TIMEOUT_MS
  );
});
