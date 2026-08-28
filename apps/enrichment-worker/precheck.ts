/**
 * Cache-first pre-check for the enrichment consumer (B1 / BS#1747, under
 * Epic C #877).
 *
 * The CDC worker issued one LML lookup per new flowsheet row with no
 * `album_metadata` pre-check, so a release played 50× paid 50 cold lookups.
 * Epic D (#899) collapsed the per-play *writes* — the worker now UPSERTs
 * `album_metadata` once per album — but not the per-play *LML call*. B1
 * closes that gap at the call level: read `album_metadata` for the row's
 * album before calling LML and skip the call when the album already carries
 * a load-bearing field. This is the single largest LML call-count cut in the
 * latency plan (it kills the 50×/album amplifier).
 *
 * Regression safety — BS#1089 negative-cache poisoning (MUST HOLD):
 *   A naive "skip if any `album_metadata` row exists" would freeze a false
 *   no-match forever. The no-match arm of `enrich.ts` writes an
 *   `album_metadata` row carrying ONLY the four synthesized search URLs
 *   (`spotify_url` / `youtube_music_url` / `bandcamp_url` / `soundcloud_url`)
 *   and leaves `artwork_url` / `discogs_url` NULL. Such a shell — or a null
 *   `artwork_url` written during a cold-cache degradation window — is exactly
 *   the state that must keep re-calling LML so it self-heals. So the skip
 *   keys on a confirmed non-null *load-bearing* field only.
 *
 * Load-bearing fields: `artwork_url` and `discogs_url`. These are the
 * `album_metadata` columns that carry a real, resolved Discogs match (a
 * cover image or a canonical release URL). The BS#1747 body names the LML
 * triad `discogs_url` / `release_id` / `artwork_url`; `album_metadata` has no
 * `release_id` column — the release identity is carried by `discogs_url`
 * (the `.../release/<id>` URL) — so the two persisted columns are the
 * complete load-bearing set here. The four search-URL columns are
 * deliberately excluded: they are synthesized locally on every no-match and
 * so never distinguish a real match from a poisoned shell.
 *
 * BS#1915 (bounded self-heal of unresolved streaming links) layers a second
 * gate on top: even with load-bearing artwork/discogs present, a row is NOT
 * "done" while a streaming field (`spotify_status` / `apple_music_status` /
 * `bandcamp_status`) is `'unresolved'` AND the album is still under
 * `STREAMING_REASK_ATTEMPT_CAP` — that combination re-calls LML too, so a
 * transient "couldn't check" null self-heals instead of freezing forever.
 * `'absent'` stays terminal (never re-asked — preserves #1747's amplifier
 * fix) and a NULL status (never-consulted) does not force a re-ask; only an
 * explicit `'unresolved'` does. See `enrich.ts` for the merge logic that
 * writes these columns and the shared per-album `streaming_reask_attempts`
 * counter.
 *
 * BS#2295 (streaming-columns gate). Load-bearing artwork/discogs alone is
 * not sufficient either: an album whose `album_metadata` row carries
 * `artwork_url` (or `discogs_url`) but none of the five streaming columns
 * (`spotify_url` / `apple_music_url` / `youtube_music_url` / `bandcamp_url` /
 * `soundcloud_url`) used to skip the LML call anyway, and
 * `finalizeFromCachedMetadata` then flips the flowsheet row to a terminal
 * `'enriched_match'` WITHOUT ever writing those columns — every client
 * reading that row got five permanent nulls. This is a standing prod
 * backlog, not a hypothetical — measured at 4 of 152 recent track rows, all
 * with `artwork_url` present and `discogs_url` NULL. Today's match-write
 * path (`enrich.ts#upsertMatchedAlbumMetadata`) always lands at least one
 * streaming column (a verified URL or a synthesized search fallback)
 * alongside `artwork_url`, so it is not the writer that produced them;
 * which path did is not established, and the gate deliberately does not
 * care — it keys on the shape, so it also floors any future writer that
 * persists a load-bearing match without the streaming columns. The skip
 * therefore also requires at least one streaming URL column to be non-null;
 * a row with artwork/discogs but zero streaming URLs falls through to the
 * normal LML path so it gets a real chance to fill them. This does not widen the #1747 amplifier: an album with load-bearing
 * artwork/discogs AND at least one streaming URL is still skipped, so the
 * common already-enriched case pays no extra LML calls.
 *
 * Note that this conjunct is deliberately UNBOUNDED, unlike the BS#1915
 * re-ask gate sitting beside it, which is capped by
 * `streaming_reask_attempts`. The reason the two differ: #1915 re-asks a
 * question that can legitimately keep coming back unanswered (a service
 * that simply has no match for this album), so it needs a cap or it asks
 * forever. This gate's question is answered by construction on the FIRST
 * fall-through — both write arms in `enrich.ts` populate
 * `youtube_music_url` and `soundcloud_url` unconditionally from
 * `synthesizeSearchUrls` (the match arm at `upsertMatchedAlbumMetadata`, and
 * the linked no-match arm) — so the qualifying population is self-draining
 * and a cap would only serve to re-freeze rows the fix exists to unfreeze.
 *
 * The one shape that could defeat that: both write arms carry
 * `setWhere: album_metadata.updated_at < NOW()`, so a row whose `updated_at`
 * is not strictly in the past (clock skew on the writing host, an
 * out-of-band backfill stamping a future timestamp) makes the whole conflict
 * `SET` a no-op — `artwork_url` survives, the five streaming columns stay
 * NULL, and the row re-calls LML on every play with nothing to stop it.
 * That is a defect in the write guard rather than in this gate, and the
 * fix belongs there; recorded here so a future reader tracing per-play LML
 * calls back to this predicate finds the actual culprit.
 */

import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';

import { isBandcampReaskEnabled, resolveComposer, STREAMING_REASK_ATTEMPT_CAP, type EnrichRow } from './enrich.js';

/**
 * True when the album already has a persisted, load-bearing Discogs match in
 * `album_metadata` (`artwork_url` OR `discogs_url` non-null) AND at least one
 * of the five streaming URL columns is non-null (BS#2295 — see file header)
 * AND no streaming field is still bounded-re-ask-eligible (BS#1915 — see
 * file header). False when the row is missing, all-null, a search-URL-only
 * shell (BS#1089 guard), a load-bearing match with zero streaming columns
 * populated (BS#2295), or carries an `'unresolved'` streaming field under
 * the attempt cap, so the caller re-calls LML and the row self-heals.
 *
 * Only linked rows (flowsheet `album_id` non-null) have an `album_metadata`
 * row to consult; the caller gates on that before invoking this.
 */
export async function hasLoadBearingAlbumMetadata(albumId: number): Promise<boolean> {
  // COALESCE(..., false) is load-bearing, not decorative: SQL's
  // three-valued logic makes `col = 'unresolved'` evaluate to NULL (not
  // false) when `col` is NULL, so for the common case of all three status
  // columns still NULL (never consulted), the un-coalesced expression would
  // evaluate to NULL — and negating a NULL WHERE-clause term excludes the
  // row, silently breaking the base BS#1747 skip for every plain
  // load-bearing row. COALESCE pins the "nothing to re-ask" default to an
  // explicit false before negating.
  // Bandcamp re-ask de-freeze (ENRICHMENT_BANDCAMP_REASK): kept in lockstep
  // with the positive form in `streaming-reask.ts#findUnresolvedStreamingCandidates`
  // — see that function for the full rationale. A load-bearing row whose
  // Bandcamp is a NULL-status search-fallback (the legacy frozen shape) is NOT
  // "done": this negative gate returns false for it so a subsequent PLAY
  // re-asks LML (the sweep covers albums that aren't played again). Gated, so
  // flag-off is a byte-for-byte no-op.
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
  // BS#2295: a confirmed load-bearing match (artwork/discogs) is not "done"
  // unless at least one of the five streaming columns actually carries a
  // value — see the file header for why a load-bearing-only row must fall
  // through to LML instead of freezing a terminal status with five nulls.
  const hasAnyStreamingUrl = or(
    isNotNull(album_metadata.spotify_url),
    isNotNull(album_metadata.apple_music_url),
    isNotNull(album_metadata.youtube_music_url),
    isNotNull(album_metadata.bandcamp_url),
    isNotNull(album_metadata.soundcloud_url)
  );
  const rows = await db
    .select({ album_id: album_metadata.album_id })
    .from(album_metadata)
    .where(
      and(
        eq(album_metadata.album_id, albumId),
        or(isNotNull(album_metadata.artwork_url), isNotNull(album_metadata.discogs_url)),
        hasAnyStreamingUrl,
        sql`NOT ${needsStreamingReask}`
      )
    )
    .limit(1);
  return rows.length > 0;
}

export type CacheHitOutcome = 'cache_hit' | 'cache_hit_raced';

/**
 * Finalize an enriching row from already-cached `album_metadata` — the skip
 * path. No `album_metadata` write happens: the album-level columns are
 * already populated (that's why we skipped LML). We only flip the flowsheet
 * row's `metadata_status` off `'enriching'` to a terminal `'enriched_match'`
 * so the C6 stranded-claim sweep (#895) doesn't revert it and re-drive a
 * lookup, and we stamp the per-playcut composer.
 *
 * Composer resolves via the artist-as-proxy fallback (BS#1499's dominant
 * ~79% case): the skip trades the small chance of surfacing per-playcut
 * Discogs writer credits on a repeat play for eliminating the 50×/album LML
 * amplifier. `resolveComposer(row, null)` is the identical value the
 * no-credit LML arms already write, so the skip stays consistent with the
 * full path.
 *
 * The WHERE narrows by `metadata_status = 'enriching'` (the same idempotency
 * guard `finalizeRow` uses): if a sibling worker or the C6 sweep already
 * moved the row off `'enriching'`, the UPDATE matches 0 rows and we report
 * `'cache_hit_raced'`.
 */
export async function finalizeFromCachedMetadata(row: EnrichRow): Promise<CacheHitOutcome> {
  const { composer, composer_source } = resolveComposer(row, null);
  const updated = await db
    .update(flowsheet)
    .set({ metadata_status: 'enriched_match', composer, composer_source })
    .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'cache_hit_raced' : 'cache_hit';
}
