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
 */

import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';

import { resolveComposer, STREAMING_REASK_ATTEMPT_CAP, type EnrichRow } from './enrich.js';

/**
 * True when the album already has a persisted, load-bearing Discogs match in
 * `album_metadata` (`artwork_url` OR `discogs_url` non-null) AND no
 * streaming field is still bounded-re-ask-eligible (BS#1915 — see file
 * header). False when the row is missing, all-null, a search-URL-only shell
 * (BS#1089 guard), or carries an `'unresolved'` streaming field under the
 * attempt cap, so the caller re-calls LML and the row self-heals.
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
  const needsStreamingReask = sql<boolean>`COALESCE(
    ${album_metadata.streaming_reask_attempts} < ${STREAMING_REASK_ATTEMPT_CAP}
    AND (
      ${album_metadata.spotify_status} = 'unresolved'
      OR ${album_metadata.apple_music_status} = 'unresolved'
      OR ${album_metadata.bandcamp_status} = 'unresolved'
    ),
    false
  )`;
  const rows = await db
    .select({ album_id: album_metadata.album_id })
    .from(album_metadata)
    .where(
      and(
        eq(album_metadata.album_id, albumId),
        or(isNotNull(album_metadata.artwork_url), isNotNull(album_metadata.discogs_url)),
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
