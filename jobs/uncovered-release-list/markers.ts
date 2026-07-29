/**
 * Writer for `uncovered_release_search_markers` (migration 0133,
 * jobs/uncovered-release-list, BS#1877). Called ONLY after a publish
 * actually commits (see orchestrate.ts) — marking a release "handed off"
 * before its snapshot line ever reached `WXYC/research-data` would let a
 * publish-disabled or failed run silently and permanently drop it from
 * every future cycle, defeating the whole point of the anti-join.
 *
 * UPSERTs on the table's real unique index (`album_id`), incrementing
 * `handoff_count` and refreshing `last_handed_off_at` on a repeat — which,
 * per the table's "publish-once" design, should only ever happen if this
 * job's own anti-join has a bug (a correctly-running anti-join never
 * re-offers an already-marked release). The counter makes that visible in
 * the data rather than silently overwriting `first_handed_off_at`.
 */
import { sql } from 'drizzle-orm';
import { db, uncovered_release_search_markers } from '@wxyc/database';

/**
 * Record a handoff for each `library.id` in `libraryIds`. Returns the
 * number of rows written (equal to `libraryIds.length` on success — every
 * id either inserts fresh or updates in place, never silently dropped).
 * Empty input short-circuits without a DB round-trip.
 */
export const recordHandoffs = async (libraryIds: number[]): Promise<number> => {
  if (libraryIds.length === 0) return 0;

  const t = uncovered_release_search_markers;
  const rows = libraryIds.map((albumId) => ({ album_id: albumId }));

  const result = await db
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: t.album_id,
      set: {
        last_handed_off_at: sql`now()`,
        handoff_count: sql`${t.handoff_count} + 1`,
      },
    })
    .returning({ id: t.id });

  return result.length;
};
