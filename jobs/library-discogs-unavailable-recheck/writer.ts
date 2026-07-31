/**
 * Writer for jobs/library-discogs-unavailable-recheck (BS#1283 / epic #1280
 * sub-issue 3).
 *
 * `writeMatch` is the high-confidence-match writer: a single DB transaction
 * that (1) overwrites `discogs_release_id` on EVERY `rotation` row for the
 * album — deliberately NO `IS NULL` guard, unlike
 * `jobs/rotation-release-id-backfill/writer.ts`'s idempotent single-row
 * UPDATE — and (2) clears the library flag/note and stamps the recheck
 * timestamp.
 *
 * The missing IS-NULL guard is BY DESIGN (fixes the parent issue's
 * "sticky-false-match bug"): a release flagged `discogs_unavailable` may
 * carry a stale, wrong `rotation.discogs_release_id` from before the MD
 * flagged it (or from an earlier, now-superseded recheck run). Once this
 * recheck gets a fresh ≥0.95-confidence match, that match is authoritative
 * and MUST replace whatever was there — preserving the stale id would mean
 * the flag clears (making the wrong match visible again) while the wrong id
 * stays pinned forever, exactly the bug the parent issue's self-review
 * caught. The data-preservation stance elsewhere in this codebase (avoid
 * clobbering successfully-collected data) applies to flag-set time, not to
 * recheck-found-correct-match time — see the parent issue body's "No
 * `IS NULL` guard" section.
 *
 * `rotation.album_id` is not unique — a release can carry multiple active
 * rotation rows over its lifecycle (re-bins, re-adds; see the `rotation`
 * table's doc comment in `shared/database/src/schema.ts`) — so the UPDATE
 * has no `LIMIT`/single-row assumption; ALL rows for the album_id are
 * overwritten in the same transaction (parent issue test 9).
 */

import { eq, sql } from 'drizzle-orm';
import { db, library, rotation } from '@wxyc/database';

export const RECHECK_SOURCE = 'recheck_after_unavailable' as const;

export const writeMatch = async (
  libraryId: number,
  releaseId: number
): Promise<{ written: boolean; rotationRowsUpdated: number }> => {
  return db.transaction(async (tx) => {
    const rotationUpdated = await tx
      .update(rotation)
      .set({
        discogs_release_id: releaseId,
        discogs_release_id_source: RECHECK_SOURCE,
      })
      .where(eq(rotation.album_id, libraryId))
      .returning({ id: rotation.id });

    const libraryUpdated = await tx
      .update(library)
      .set({
        discogs_unavailable: false,
        discogs_unavailable_note: null,
        last_discogs_recheck_at: sql`now()`,
      })
      .where(eq(library.id, libraryId))
      .returning({ id: library.id });

    return { written: libraryUpdated.length === 1, rotationRowsUpdated: rotationUpdated.length };
  });
};

/**
 * Stamps `last_discogs_recheck_at` only — used on both the `no_match` and
 * `low_confidence` outcomes, neither of which touches `discogs_unavailable`,
 * `discogs_unavailable_note`, or `rotation.discogs_release_id`. Not
 * transactional: a single-row, single-column UPDATE needs no transaction.
 */
export const stampRecheckTimestamp = async (libraryId: number): Promise<{ written: boolean }> => {
  const updated = await db
    .update(library)
    .set({ last_discogs_recheck_at: sql`now()` })
    .where(eq(library.id, libraryId))
    .returning({ id: library.id });
  return { written: updated.length === 1 };
};
