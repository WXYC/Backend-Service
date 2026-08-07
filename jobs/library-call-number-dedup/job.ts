/**
 * One-shot dedup: resolve duplicate call-number slots in `library` so a
 * uniqueness constraint can be added to the column that addresses the shelf.
 * CLI entrypoint — the importable core lives in `merge.ts` so the destructive
 * functions can be tested against a real Postgres without this module's
 * `main()` auto-run firing on import.
 *
 * A WXYC call number addresses a physical slot: genre-scoped code letters, a
 * number, and an optional volume letter — "KE 7". Nothing enforces that a slot
 * is used once, and `generateAlbumCodeNumber` reads MAX+1 and inserts without a
 * lock, so concurrent adds under one artist already produce the same number
 * with no user error involved. Slots accumulated more than one release.
 *
 * Two rows in a slot are one of two very different things, and telling them
 * apart is the whole job. Most are one release entered twice under differently
 * decorated titles (`It's a Party 12"` / `It's a Party cd-single`) and merge
 * with no disc moving. The rest are genuinely different releases, where one row
 * must be renumbered AND THE PHYSICAL DISC RELABELLED — so an execute run emits
 * a worklist, and the constraint cannot land until the shelf work is done.
 *
 * DATA SAFETY / ops (docs/bulk-update-playbook.md):
 *   - **Dry-run by default; pass `--execute` to write.** Dry-run SELECTs and
 *     reports the full plan, including the finished worklist, with zero writes.
 *   - Idempotent: a completed merge drops that slot out of the
 *     `HAVING count(*) > 1` set, so a re-run finds nothing to do.
 *   - Each slot's repoints + delete run in a single transaction — a mid-run
 *     abort leaves each slot either fully merged or untouched.
 *   - Repoint precedes delete, always. Six FK sites declare `onDelete: cascade`
 *     and two declare `set null`, so deleting first would silently destroy
 *     rotation history, album metadata, and reviews, and silently unlink plays.
 *   - A renumber re-checks its destination inside the transaction and declines
 *     rather than colliding if a librarian took it since the plan was built.
 *   - `ANALYZE` on the rewritten tables after an `--execute` run (BS#934).
 *
 * SEQUENCING: run this AFTER the tubafrenzy ETL stops (turndown Phase 5,
 * BS#1543). `jobs/library-etl` upserts on `legacy_release_id` and carries
 * `code_number` + `code_volume_letters` in its refresh set, so while that ETL
 * is live it will overwrite a renumber and reinstate a deleted row from the
 * upstream MySQL catalog.
 *
 * The revert is triggered by an UPSTREAM EDIT, not by the clock — and pausing
 * the ETL is therefore not a workaround. `library-etl` is incremental
 * (`WHERE lr.TIME_LAST_MODIFIED > <last run>`), so it fetches only releases
 * whose MySQL timestamp advanced. This job writes Postgres only, so a deduped
 * release is absent from the next fetch and the next pass does NOT revert it.
 * What reverts it is a librarian editing that release in tubafrenzy, at any
 * point afterward. A pause window covers a ~20s run that was never at risk.
 *
 * The uniqueness constraint this job exists to enable has its own hard gate on
 * the same event, for a different reason (BS#2033): upstream MySQL enforces no
 * uniqueness and hosts the unlocked MAX+1 allocator, so it can mint a new
 * duplicate at any time. That INSERT would violate the constraint, and
 * ON CONFLICT (legacy_release_id) does not absorb a violation of a different
 * index — the release loop is one transaction, so it aborts the WHOLE ETL run
 * (same failure library-etl documents for library_legacy_release_id_idx, #752).
 *
 * Run procedure: Manual Build & Deploy with `target=library-call-number-dedup`,
 * then SSH to EC2 and:
 *   docker run --rm --env-file .env <image>            2>&1 | tee log-dry
 *   docker run --rm --env-file .env <image> --execute  2>&1 | tee log-exec
 *
 * Environment: standard DB_* connection vars (same as the other one-shots).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runDedup } from './merge.js';

const main = async () => {
  try {
    const summary = await runDedup();
    // A skipped renumber leaves a slot still colliding, so the run did not
    // finish its job even though nothing failed. Surface it in the exit code
    // rather than only in a warning line buried in the log.
    if (summary.renumbersSkipped > 0) process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((err) => {
  console.error('[library-call-number-dedup] Fatal error:', err);
  // exitCode (not exit) so the finally body runs and the pg pool closes.
  process.exitCode = 1;
});
