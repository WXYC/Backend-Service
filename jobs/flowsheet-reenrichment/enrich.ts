/**
 * Per-row enrichment for the flowsheet-reenrichment one-shot drain (BS#1433).
 *
 * Modeled on `apps/enrichment-worker/enrich.ts:finalizeRow` with three
 * changes:
 *
 *   1. Idempotency guard: WHERE narrows by `metadata_status='enriched_no_match'
 *      AND album_id IS NULL` (replaces finalizeRow's `metadata_status='enriching'`).
 *      The `album_id IS NULL` clause is load-bearing — defends against a
 *      parallel linkage-resolver flipping album_id non-null between the
 *      orchestrator's SELECT and this UPDATE.
 *
 *   2. No-match → no-op early return. The row's four synthesized search URLs
 *      and `enriched_no_match` status are already correct from the original
 *      pass. Skipping the no-match UPDATE avoids per-row trigger cost on
 *      `flowsheet` per docs/bulk-update-playbook.md.
 *
 *   3. No linked branch at all. The cohort WHERE is `album_id IS NULL`, so
 *      the function never touches `album_metadata`.
 *
 *   4. BS#1998: an LML shed (Discogs breaker open, or the BS#1748 client-side
 *      limiter shed) returns the distinct `upstream_unavailable_skipped`
 *      outcome instead of collapsing into `still_no_match`. Both are no-ops
 *      at the DB level — the difference is that one is a verdict and the
 *      other is an un-asked question. See the guard's comment for why the
 *      distinction is load-bearing even with nothing written.
 *
 * `metadata_attempt_at` is NOT stamped — follow the CDC consumer convention
 * (`apps/enrichment-worker/enrich.ts:22-26`). Post-Epic-C, that column is
 * vestigial for the routine write path.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import { shedReasonOf, type DiscogsMatchResult, type GatedLookupResponse, type LookupResponse } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';

export type ReenrichRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
  // album_id is always null for this cohort (enforced by WHERE in orchestrate.ts),
  // so it is not part of this type — the function never touches album_metadata.
};

export type ReenrichOutcome = 'match' | 'match_raced' | 'still_no_match' | 'upstream_unavailable_skipped';

/**
 * Synthesized search URL fallbacks matching finalizeRow's inline copy.
 * Per-service semantics deliberately asymmetric — mirrors
 * `apps/enrichment-worker/enrich.ts:synthesizeSearchUrls` exactly so the
 * payload-parity test can snapshot-equal both paths.
 *
 * Apple Music has no synthesized fallback (BS#1192): null is the
 * load-bearing "no verified iTunes match" signal; a keyword-search URL
 * would launder it into a clickable button.
 */
const synthesizeSearchUrls = (
  row: ReenrichRow
): { spotify_url: string; youtube_music_url: string; bandcamp_url: string; soundcloud_url: string } => {
  const artist = row.artist_name;
  const album = row.album_title ?? undefined;
  const track = row.track_title ?? undefined;

  const spotifyQuery = track ? `${artist} ${track}` : album ? `${artist} ${album}` : artist;
  const youtubeQuery = track ? `${artist} ${track}` : album ? `${artist} ${album}` : artist;
  const bandcampQuery = album ? `${artist} ${album}` : artist;
  const soundcloudQuery = track ? `${artist} ${track}` : artist;

  return {
    spotify_url: `https://open.spotify.com/search/${encodeURIComponent(spotifyQuery)}`,
    youtube_music_url: `https://music.youtube.com/search?q=${encodeURIComponent(youtubeQuery)}`,
    bandcamp_url: `https://bandcamp.com/search?q=${encodeURIComponent(bandcampQuery)}`,
    soundcloud_url: `https://soundcloud.com/search?q=${encodeURIComponent(soundcloudQuery)}`,
  };
};

export const extractArtwork = (response: LookupResponse): DiscogsMatchResult | null => {
  const first = response.results?.[0];
  if (!first) return null;
  if (!first.artwork) return null;
  return first.artwork;
};

/**
 * Apply a single LML response to a flowsheet row in the enriched_no_match
 * cohort. Returns the outcome so the orchestrator can count it.
 *
 * On no-match: immediate no-op return (change 2 above). The existing
 * search URLs and status are already correct.
 *
 * On match: write the 10-column payload + flip metadata_status to
 * 'enriched_match'. If the idempotency WHERE returns 0 rows (another
 * process raced), return 'match_raced' — same data outcome, distinct
 * metric so the operator can distinguish "I personally flipped this row"
 * from "it was flipped by someone else mid-run."
 *
 * Errors propagate — do not swallow here. The orchestrator's catch arm
 * counts them as 'lml_error' and continues.
 */
export const reenrichRow = async (row: ReenrichRow, response: LookupResponse): Promise<ReenrichOutcome> => {
  const artwork = extractArtwork(response);

  // BS#1998 — shed classification, ported from the sibling drain's BS#1995
  // Arm 3 guard (`jobs/flowsheet-metadata-backfill/enrich.ts`). LML's Discogs
  // circuit breaker being open surfaces as `degraded: true, degraded_reason:
  // 'upstream_unavailable'`; the shared client's own bounded-limiter shed
  // (BS#1748 — not reachable from this job's unbounded limiter today, but
  // guarded defensively) surfaces as an `outcome` discriminator readable via
  // `shedReasonOf`. Either way LML never got an answer out of Discogs.
  //
  // Unlike the sibling, the stakes here are the VERDICT, not the row: this
  // job's no-match arm writes nothing, so a shed cannot corrupt data. It
  // corrupts the count. `still_no_match` is what the runbook tells the
  // operator to read as "LML looked and there is genuinely nothing there,"
  // and it is the number that decides whether a re-run is warranted —
  // laundering an un-asked row into it reports the drain as more complete
  // than it is. That is the reporting half of the same mistake the
  // 2026-08-03/04 incident made in the write path.
  //
  // Only skip when there is no usable verdict. LML's degraded-response
  // builder still returns whatever the tail legs produced BEFORE the breaker
  // tripped (`fetch_artwork` runs ahead of `enrich_metadata`/identity
  // resolution, either of which can raise), so a degraded response CAN carry
  // a complete match — discarding it would downgrade a real answer to a retry
  // and re-spend the exact Discogs ceiling the shed exists to protect. With
  // `artwork` present, fall through to the normal match path unchanged.
  //
  // Post-LML#1128 this also covers the SEARCH leg, which until then swallowed
  // the same breaker-open condition into a bare `Outcome.empty()` with no
  // marker (`core/search.py`); it now sets `state.upstream_shed`, which
  // `lookup/orchestrator.py` projects onto the same two wire fields. A bare
  // empty carrying no marker is therefore a genuine no-match again, and stays
  // terminal below — do NOT widen this guard to catch it, nor
  // `degraded_reason: 'deadline_exceeded'` / `timeout: true`, which are
  // deliberate terminal outcomes for this offline-drain caller (BS#1914 /
  // BS#1064 / BS#1180).
  const shedReason = shedReasonOf(response as GatedLookupResponse);
  if ((response.degraded_reason === 'upstream_unavailable' || shedReason !== undefined) && !artwork) {
    return 'upstream_unavailable_skipped';
  }

  // Change 2: no-match is a no-op. The four synthesized search URLs on
  // the row are already correct from the original enriched_no_match pass.
  if (!artwork) {
    return 'still_no_match';
  }

  const searchUrls = synthesizeSearchUrls(row);

  // 10-column payload mirrors finalizeRow's unlinked+match branch exactly
  // (payload-parity.test.ts pins this). Simple ?? operators — no
  // conditional spreads needed because this job has no dedup cache that
  // strips per-track URL fields from artwork objects.
  const payload = {
    artwork_url: filterSpacerGif(artwork.artwork_url),
    discogs_url: artwork.release_url ?? null,
    // Discogs returns 0 as "year unknown"; coerce to null so iOS doesn't
    // render literal "0". Mirrors metadata.service.ts#extractAlbumMetadata (#1002).
    release_year: artwork.release_year || null,
    spotify_url: artwork.spotify_url ?? searchUrls.spotify_url,
    // Apple Music has no synthesized fallback — null is load-bearing (BS#1192).
    apple_music_url: artwork.apple_music_url ?? null,
    youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url,
    bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url,
    soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url,
    artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
    artist_wikipedia_url: artwork.wikipedia_url ?? null,
    // Flip status as part of the same SET — atomically with the data write.
    metadata_status: 'enriched_match' as const,
    // Change 4: metadata_attempt_at is NOT stamped (CDC consumer convention).
  };

  // Change 1: idempotency guard. `album_id IS NULL` prevents racing a
  // parallel linkage-resolver that may have flipped album_id non-null
  // between the SELECT and this UPDATE.
  const updated = await db
    .update(flowsheet)
    .set(payload)
    .where(
      and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriched_no_match'), isNull(flowsheet.album_id))
    )
    .returning({ id: flowsheet.id });

  return updated.length === 0 ? 'match_raced' : 'match';
};
