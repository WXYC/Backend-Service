/**
 * Hourly bounded self-heal sweep for unresolved streaming links (BS#1915).
 *
 * The CDC handler (`handler.ts` -> `enrich.ts#finalizeRow`) already re-asks
 * LML for an album whose streaming field is `unresolved` under the attempt
 * cap the next time that album is PLAYED (`precheck.ts`'s gate keeps the row
 * "not done"). But CDC only fires on a new flowsheet INSERT — an album that
 * isn't played again may never get another chance to self-heal. This module
 * is the other half of the bound: a periodic sweep that finds every
 * `album_metadata` row still carrying an `unresolved` streaming field and
 * re-asks LML directly, independent of play activity.
 *
 * Driven on an hourly cadence from `worker.ts` (mirrors `sweep.ts`'s
 * in-process interval pattern for the stranded-claim recovery sweep — see
 * that file's header for why an in-process interval beats a sibling cron
 * container at this frequency). "Hourly" is also the natural backoff
 * spacing BS#1915 specifies: no per-row `next_retry_at` column, no
 * exponential schedule — an unresolved field simply gets re-asked at most
 * once per sweep tick, and the sweep tick is hourly.
 *
 * Re-ask dispatch reuses `enrichmentBulkLookup` (`lookup-batcher.ts`) — the
 * SAME call already tagged `caller: 'enrichment-worker'`, which
 * `shared/lml-client/src/policy.ts` (BS#1826) registers as class 5
 * (batch/backfill), i.e. the low-priority lane per the #1819 isolation
 * contract. No new caller label or lane-selection logic is needed: this
 * sweep is just another source of `enrichmentBulkLookup` calls, batched and
 * rate-limited exactly like the live CDC path's.
 *
 * Write-back reuses `enrich.ts`'s `upsertMatchedAlbumMetadata` (merge +
 * UPSERT, never overwriting a verified URL, `absent` terminal) on a fresh
 * match, or `bumpStreamingReaskAttempts` (attempt spent, no other write)
 * when LML responds with no artwork at all for a candidate that previously
 * matched. A candidate whose LML call THROWS (transient failure or a shed)
 * spends nothing — it stays eligible for the next sweep tick, exactly like
 * the live CDC path's C6 stranded-claim treatment of a throw.
 */

import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { album_metadata, db, library } from '@wxyc/database';

import {
  bumpStreamingReaskAttempts,
  extractArtwork,
  isBandcampReaskEnabled,
  STREAMING_REASK_ATTEMPT_CAP,
  synthesizeSearchUrls,
  upsertMatchedAlbumMetadata,
} from './enrich.js';
import { enrichmentBulkLookup } from './lookup-batcher.js';

/** One album still eligible for a bounded streaming re-ask. */
export interface StreamingReaskCandidate {
  album_id: number;
  artist_name: string;
  album_title: string | null;
}

/**
 * Find up to `limit` albums that still carry a load-bearing Discogs match
 * (`artwork_url` OR `discogs_url` non-null — this sweep only upgrades
 * already-matched albums, never mints a new match) AND have at least one
 * streaming field `'unresolved'` under `STREAMING_REASK_ATTEMPT_CAP`.
 * Mirrors the BS#1915 half of `precheck.ts`'s gate predicate — those two
 * must stay in lockstep, this being the positive form of that negative gate
 * — including the same `COALESCE(..., false)` guard against SQL's
 * three-valued logic silently
 * dropping rows whose status columns are all still NULL... except here
 * NULL columns correctly never qualify a row (a never-consulted service
 * isn't a reason to re-ask), so the guard only matters for the base
 * artwork/discogs predicate interacting with an all-NULL streaming state —
 * kept for defense-in-depth and literal parity with precheck.ts.
 *
 * `precheck.ts`'s BS#2295 conjunct (skip also requires at least one of the
 * five streaming URL columns to be non-null) is deliberately NOT mirrored
 * here, so the lockstep is with that file's #1915 half only. This sweep
 * re-opens rows that WERE asked and came back `unresolved`; the BS#2295
 * cohort is the rows that were never asked at all — artwork present, all
 * five streaming columns NULL, all three status columns NULL — which have
 * no `unresolved` verdict for this query to key on and no attempt counter
 * to bound a sweep against. That cohort is reached by the two mechanisms
 * BS#2295 specifies instead: the pre-check gate re-opens each row the next
 * time its album is played, and a one-shot drain heals the standing
 * backlog. Consequence to know: an album in that shape which is never
 * played again is invisible to this sweep and stays frozen until the drain
 * runs. Widening the sweep to cover it would need a bound of its own — see
 * `precheck.ts`'s header on why that gate is unbounded and why a shared
 * `streaming_reask_attempts` cap is the wrong instrument for it.
 */
export async function findUnresolvedStreamingCandidates(limit: number): Promise<StreamingReaskCandidate[]> {
  // Bandcamp re-ask de-freeze (ENRICHMENT_BANDCAMP_REASK): the plain
  // `bandcamp_status = 'unresolved'` disjunct below only catches rows written
  // AFTER the write-side coercion in `enrich.ts` starts stamping 'unresolved'.
  // Rows that were enriched BEFORE the gate went live carry
  // `bandcamp_status = NULL` + a `bandcamp.com/search?q=` fallback URL — the
  // frozen shape. This extra disjunct (gated, so flag-off is a byte-for-byte
  // no-op) reaches that legacy backlog directly, WITHOUT a data migration:
  // a NULL status paired with the synthesized search-fallback URL is exactly
  // "matched, but Bandcamp never resolved to a direct URL". `absent` rows also
  // carry a search-fallback URL but are excluded here by the `IS NULL` guard
  // (they are terminal, never re-asked). Still bounded by the shared
  // `streaming_reask_attempts < CAP` guard, and once re-asked the coercion
  // moves them onto the clean `= 'unresolved'` disjunct.
  const bandcampFrozenReask = isBandcampReaskEnabled()
    ? sql` OR (${album_metadata.bandcamp_status} IS NULL AND ${album_metadata.bandcamp_url} LIKE ${'%bandcamp.com/search%'})`
    : sql``;
  const needsStreamingReask = sql<boolean>`COALESCE(
    ${album_metadata.streaming_reask_attempts} < ${STREAMING_REASK_ATTEMPT_CAP}
    AND (
      ${album_metadata.spotify_status} = 'unresolved'
      OR ${album_metadata.apple_music_status} = 'unresolved'
      OR ${album_metadata.bandcamp_status} = 'unresolved'${bandcampFrozenReask}
    ),
    false
  )`;

  const rows = await db
    .select({
      album_id: album_metadata.album_id,
      // `library.artist_name` is denormalized and nullable (schema.ts:
      // "Nullable until A.2"); the WHERE below excludes NULL rows, so this
      // cast reflects the actual (never-null) shape of the returned rows.
      artist_name: library.artist_name,
      album_title: library.album_title,
    })
    .from(album_metadata)
    .innerJoin(library, eq(library.id, album_metadata.album_id))
    .where(
      and(
        isNotNull(library.artist_name),
        or(isNotNull(album_metadata.artwork_url), isNotNull(album_metadata.discogs_url)),
        sql`${needsStreamingReask}`
      )
    )
    .limit(limit);
  return rows as StreamingReaskCandidate[];
}

export interface StreamingReaskSweepResult {
  /** Albums selected as re-ask-eligible this tick. */
  candidates: number;
  /** Candidates whose LML call resolved (match or no-match) and were written back. */
  succeeded: number;
  /** Candidates whose LML call threw — spent nothing, stay eligible for the next tick. */
  failed: number;
}

/**
 * Run one streaming-reask sweep tick. Dispatches every candidate's
 * `enrichmentBulkLookup` call concurrently — `lookup-batcher.ts` coalesces
 * them into as few real HTTP round-trips as its burst window allows, and
 * the shared client's Semaphore(5)/TokenBucket chokepoint still gates the
 * actual concurrency, so firing all candidates at once is safe even for a
 * large sweep batch.
 */
export async function reaskUnresolvedStreaming(limit: number): Promise<StreamingReaskSweepResult> {
  const candidates = await findUnresolvedStreamingCandidates(limit);
  if (candidates.length === 0) {
    return { candidates: 0, succeeded: 0, failed: 0 };
  }

  const outcomes = await Promise.allSettled(candidates.map((candidate) => reaskOne(candidate)));
  const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
  return { candidates: candidates.length, succeeded, failed: outcomes.length - succeeded };
}

async function reaskOne(candidate: StreamingReaskCandidate): Promise<void> {
  const response = await enrichmentBulkLookup(
    {
      artist_name: candidate.artist_name,
      album_title: candidate.album_title,
      // Album-level re-ask — no specific playcut track is driving this
      // sweep, so there is no track title to narrow the lookup with.
      track_title: null,
    },
    // `'sweep'` lane (BS#1978): this sweep is a bounded batch drain over
    // albums that ALREADY carry a Discogs match, so it keeps LML's ~4s
    // empty-state fast-degrade unconditionally and is never affected by
    // `ENRICHMENT_SUPPRESS_LML_BUDGET`. Declared explicitly rather than
    // relying on the enqueue default so the intent survives a refactor.
    'sweep'
  );
  // BS#2217: pass the candidate's own album_title so a row-less
  // correspondence match (e.g. a rotation arrival re-asked here after
  // already carrying a match) isn't rejected purely on `search_type`.
  const artwork = extractArtwork(response, candidate.album_title);
  if (artwork) {
    // Reuse the ONE canonical search-URL synthesizer (parity-tested against
    // the shared `@wxyc/metadata` module — see enrich.ts's file header)
    // rather than duplicating its per-service precedence rules here. `id`
    // and `album_id` are unused by `synthesizeSearchUrls` (it only reads
    // artist_name/album_title/track_title); album_id doubles as a stable
    // placeholder id since there's no flowsheet row driving this sweep.
    const searchUrls = synthesizeSearchUrls({
      id: candidate.album_id,
      artist_name: candidate.artist_name,
      album_title: candidate.album_title,
      track_title: null,
      album_id: candidate.album_id,
    });
    await upsertMatchedAlbumMetadata(candidate.album_id, artwork, searchUrls);
    return;
  }
  // LML answered but returned no artwork at all for an album that
  // previously matched (a rare Discogs-side flap). Still spends an
  // attempt — see the module header.
  await bumpStreamingReaskAttempts(candidate.album_id);
}
