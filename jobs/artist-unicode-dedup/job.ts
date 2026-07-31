/**
 * One-shot dedup: merge pre-existing Unicode-form-duplicate `artists` rows
 * (BS#1897). CLI entrypoint — the importable core lives in `merge.ts` so the
 * destructive functions can be tested against a real Postgres without this
 * module's `main()` auto-run firing on import.
 *
 * The catalog write-boundary matcher (`artistIdFromName`) historically matched
 * on `lower(artist_name)` — collation-aware but NOT Unicode-form aware — so
 * `Nilüfer Yanya` in NFC (`ü` = U+00FC), NFD (`u` + U+0308), and the ASCII-fold
 * `Nilufer Yanya` were byte-distinct, missed each other, and each spawned a
 * separate `artists` row. Those duplicate rows silently partition `library`
 * rows across `artist_id`s and break reconciled-identity attachment. Migration
 * 0134's matcher fix (`fold_artist_name`) stops NEW ones; this pass merges the
 * historical ones so the matcher deterministically resolves each folded name to
 * a single survivor.
 *
 * DATA SAFETY / ops (docs/bulk-update-playbook.md):
 *   - **Dry-run by default; pass `--execute` to write.** Dry-run SELECTs and
 *     logs the affected set (survivor, duplicates, per-FK repoint counts, plus
 *     the MED-2 multi-genre / not-form-only risk flags) with zero writes.
 *   - Idempotent: a completed run leaves one row per fold-group, so a re-run
 *     finds no groups (`HAVING count(*) > 1`) and is a no-op.
 *   - Each group's repoints + delete + normalize run in a single transaction —
 *     a mid-run abort leaves each group either fully merged or untouched.
 *   - `ANALYZE` on the rewritten tables after an `--execute` run so the
 *     planner's stats stay on the index path (BS#934 lesson).
 *
 * Run procedure: Manual Build & Deploy with `target=artist-unicode-dedup`, then
 * SSH to EC2 and:
 *   docker run --rm --env-file .env <image>            2>&1 | tee log-dry
 *   docker run --rm --env-file .env <image> --execute  2>&1 | tee log-exec
 *
 * Environment: standard DB_* connection vars (same as the other one-shots).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runDedup } from './merge.js';

const main = async () => {
  try {
    await runDedup();
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((err) => {
  console.error('[artist-dedup] Fatal error:', err);
  // exitCode (not exit) so the finally body runs and the pg pool closes.
  process.exitCode = 1;
});
