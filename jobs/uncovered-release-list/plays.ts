/**
 * Play-arm candidate source for jobs/uncovered-release-list (BS#1877, the
 * "widen the candidate set from active rotation to rotation ∪ recently
 * played" amendment to ADR 0013's "uncovered-release list handoff"). WXYC is
 * a freeform station: most of what a DJ actually enters into the flowsheet
 * is not a current rotation release, so the releases most likely to reach a
 * listener's feed are exactly the ones a rotation-only candidate set never
 * sees. This module is the second candidate arm alongside `rotation.ts`.
 *
 * Unlike `rotation.ts`, this module returns `CanonicalRelease[]` directly —
 * never `RotationRow[]`. `RotationRow` requires a non-nullable
 * `rotationId: number` a play row has no value for, and a linked play
 * already knows its `library.id` and joins its canonical strings in the
 * same query, so it needs no `ResolveCanonicalFn` resolve step.
 *
 * Two arms, selected by run mode — `job.ts` wires the right one in, this
 * module exports both and never itself decides which runs:
 *
 *   - `fetchRecentPlays(lookbackDays)` — steady state. A trailing window
 *     over `flowsheet`, grouped and ranked by play count within the window.
 *   - `fetchAllPlayedAlbums()` — `--backfill`. Reuses the existing
 *     `album_plays` materialized view (migration 0059) instead of
 *     re-aggregating 2.6M `flowsheet` rows: `album_plays` is defined as
 *     exactly this arm's aggregate minus the time window (`SELECT album_id,
 *     count(*) FROM flowsheet WHERE entry_type='track' AND album_id IS NOT
 *     NULL GROUP BY album_id`), uniquely indexed on `album_id`, and kept
 *     fresh hourly by the API container (`ALBUM_PLAYS_REFRESH_INTERVAL_MS`).
 *     It is precisely the "ever, ranked by play count" source the backfill
 *     arm wants, already maintained. `album_popularity` (migration 0107) is
 *     rejected for both arms — it collapses pressings into a master-level
 *     signal, which would break the `library_id` the wire contract requires.
 *
 * Both arms filter `entry_type = 'track'` — this is `album_plays`'s own
 * WHERE clause and the repo's canonical definition of "a play" (also
 * `catalog-popularity-freetext-resolve/job.ts`). It also lets the steady-
 * state arm use the only partial index on `add_time`
 * (`flowsheet_track_add_time_idx ON (add_time DESC) WHERE entry_type =
 * 'track'`, created by migration `0050_flowsheet-track-add-time-idx.sql`).
 * Correctness is unaffected either way —
 * non-track entries always have `album_id IS NULL` — but the predicate is
 * included because it's canonical and it lets the index fire.
 *
 * Free-text (unlinked) plays are out of scope: ~43% of music plays have
 * `album_id IS NULL` and cannot emit the wire contract's required
 * `library_id: int`. Resolving them would mean running the DJ-typed string
 * through a matcher, reintroducing exactly the wrong-album risk ADR 0013's
 * canonical-pair design exists to avoid. `flowsheet_freetext_resolution`
 * (migration 0106) is the future bridge, not built here.
 *
 * Both arms join `artists` (not `library.artist_name`'s denormalized
 * column) — the same canonical-artist source `rotation.ts`'s
 * `fetchCanonicalLibraryFields` uses, so every arm agrees on "canonical
 * artist string" by construction.
 */
import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { unwrapRows } from './db-utils.js';
import type { CanonicalRelease } from './rotation.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET = sql.raw(`"${SCHEMA}"."flowsheet"`);
const LIBRARY = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS = sql.raw(`"${SCHEMA}"."artists"`);
const ALBUM_PLAYS = sql.raw(`"${SCHEMA}"."album_plays"`);

interface RawPlayRow {
  library_id: number;
  artist_name: string;
  album_title: string;
}

const toCanonicalReleases = (rows: RawPlayRow[]): CanonicalRelease[] =>
  rows.map((row) => ({ libraryId: row.library_id, artist: row.artist_name, album: row.album_title }));

/**
 * Steady-state arm: linked plays within a trailing `lookbackDays`-day
 * window, ranked play-count desc. The interval binds through the drizzle
 * tagged template (`${lookbackDays}` below), not by string interpolation —
 * mirrors `catalog-popularity-freetext-resolve/job.ts`'s `checkLiveActivity`
 * (`now() - (interval '1 second' * ${lookbackSeconds})`).
 */
export const fetchRecentPlays = async (lookbackDays: number): Promise<CanonicalRelease[]> => {
  const result: unknown = await db.execute(sql`
    SELECT f."album_id" AS library_id, a."artist_name" AS artist_name, l."album_title" AS album_title, COUNT(*) AS play_count
    FROM ${FLOWSHEET} f
    JOIN ${LIBRARY} l ON l."id" = f."album_id"
    JOIN ${ARTISTS} a ON a."id" = l."artist_id"
    WHERE f."entry_type" = 'track' AND f."album_id" IS NOT NULL
      AND f."add_time" >= now() - (interval '1 day' * ${lookbackDays})
    GROUP BY f."album_id", a."artist_name", l."album_title"
    ORDER BY play_count DESC, f."album_id" ASC
  `);
  return toCanonicalReleases(unwrapRows<RawPlayRow>(result));
};

/**
 * Backfill arm (`--backfill`): every linked album ever played, ranked
 * play-count desc, sourced from the `album_plays` MV rather than
 * re-aggregating `flowsheet` directly. No time window, no SQL `LIMIT` —
 * capping is the orchestrator's job, at a single post-anti-join position
 * (see orchestrate.ts and the README's "Cap placement" section); a SQL
 * `LIMIT` here would silently stall the drain (the same top-N re-selected
 * and re-anti-joined-away on every run).
 */
export const fetchAllPlayedAlbums = async (): Promise<CanonicalRelease[]> => {
  const result: unknown = await db.execute(sql`
    SELECT p."album_id" AS library_id, a."artist_name" AS artist_name, l."album_title" AS album_title, p."plays" AS play_count
    FROM ${ALBUM_PLAYS} p
    JOIN ${LIBRARY} l ON l."id" = p."album_id"
    JOIN ${ARTISTS} a ON a."id" = l."artist_id"
    ORDER BY p."plays" DESC, p."album_id" ASC
  `);
  return toCanonicalReleases(unwrapRows<RawPlayRow>(result));
};
