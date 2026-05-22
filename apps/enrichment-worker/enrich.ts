/**
 * Finalize UPDATE for the enrichment consumer (BS#892 / Epic C C2).
 *
 * Mirrors `jobs/flowsheet-metadata-backfill/enrich.ts` in shape — the same
 * 10-column on-match payload, the same 3-column on-no-match payload, the
 * same spacer.gif filter, the same synthesized search URLs — but with a
 * different idempotency guard and a different terminal state.
 *
 * Idempotency guard: WHERE narrows by `metadata_status = 'enriching'`. The
 * claim primitive (`claim.ts`) is the only writer that flips a row to
 * `enriching`, so the WHERE here can match only a row this worker (or a
 * sibling that already lost the claim race) is the registered claimer of.
 *
 * Terminal state:
 *   - LML returned artwork  → `metadata_status = 'enriched_match'`
 *   - LML returned no match → `metadata_status = 'enriched_no_match'`
 *   - LML threw             → caller catches; row stays `enriching`. The
 *                             C6 stranded-claim sweep (#895) reverts it to
 *                             `pending` past `enriching_since + 60s` so the
 *                             next CDC tick (or sweep) retries.
 *
 * No `metadata_attempt_at` stamping here. That column was the implicit
 * state machine the enum (BS#891) replaced; the consumer writes the explicit
 * status and leaves the marker alone. The backfill still stamps the marker
 * because its WHERE is `metadata_attempt_at IS NULL` — a historical-drain
 * concern that doesn't apply to the live consumer path.
 *
 * Build-graph isolation: the search-URL synthesis, spacer.gif filter, and bio
 * cleaner are inlined rather than imported from `apps/backend` or
 * `jobs/flowsheet-metadata-backfill` to keep this package independent. The
 * canonical implementations are in
 * `apps/backend/services/metadata/metadata.service.ts` (runtime) and
 * `jobs/flowsheet-metadata-backfill/enrich.ts` (backfill); divergence here
 * would be a bug. Parity is not test-pinned yet (the backfill pins parity to
 * the runtime; this would be a transitive parity test). Track in a follow-up
 * if drift becomes a real concern.
 */

import { and, eq } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';

export type EnrichRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
};

export type FinalizeOutcome =
  | 'enriched_match'
  | 'enriched_match_raced'
  | 'enriched_no_match'
  | 'enriched_no_match_raced';

export const cleanDiscogsBio = (bio: string): string =>
  bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');

export const filterSpacerGif = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.includes('spacer.gif')) return null;
  return url;
};

/**
 * Synthesized search URLs (per-service semantics deliberately asymmetric):
 *   - YouTube Music: trackTitle > albumTitle > artistName
 *   - Bandcamp:      albumTitle > artistName (album-leaning)
 *   - SoundCloud:    trackTitle > artistName (NO album fallback — album-only
 *                    SoundCloud queries surface unrelated DJ mixes)
 *
 * Must match `apps/backend/services/metadata/providers/search-urls.provider.ts`
 * exactly.
 */
export const synthesizeSearchUrls = (
  row: EnrichRow
): { youtube_music_url: string; bandcamp_url: string; soundcloud_url: string } => {
  const artist = row.artist_name;
  const album = row.album_title ?? undefined;
  const track = row.track_title ?? undefined;

  const youtubeQuery = track ? `${artist} ${track}` : album ? `${artist} ${album}` : artist;
  const bandcampQuery = album ? `${artist} ${album}` : artist;
  const soundcloudQuery = track ? `${artist} ${track}` : artist;

  return {
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
 * Finalize an enriching row with LML's response.
 *
 * Returns the outcome so the dispatcher can count it. The `_raced` variants
 * fire when `.returning({ id })` is empty: the WHERE no longer matches
 * because something else (the C6 cron's stranded-claim sweep, a manual
 * triage operator, or a hypothetical out-of-band writer) flipped
 * `metadata_status` off `'enriching'` between claim and finalize. Same data
 * outcome from the row's perspective; the metric separates "this consumer
 * finalized it" from "the row was finalized by someone."
 *
 * Errors propagate up — the dispatcher's catch arm decides whether to leave
 * the row stranded (transient LML failure → C6 sweep recovers) or to write
 * a terminal `failed_no_retry` (out of scope for PR-2; the filter ensures
 * every reachable row has the inputs LML needs).
 */
export const finalizeRow = async (row: EnrichRow, response: LookupResponse): Promise<FinalizeOutcome> => {
  const artwork = extractArtwork(response);
  const searchUrls = synthesizeSearchUrls(row);

  if (artwork) {
    const updated = await db
      .update(flowsheet)
      .set({
        artwork_url: filterSpacerGif(artwork.artwork_url),
        discogs_url: artwork.release_url ?? null,
        // Discogs returns 0 as "year unknown"; coerce to null so iOS doesn't
        // render literal "0". Mirrors metadata.service.ts (#1002).
        release_year: artwork.release_year || null,
        spotify_url: artwork.spotify_url ?? null,
        apple_music_url: artwork.apple_music_url ?? null,
        // Prefer LML-supplied streaming URLs; fall back to synthesized.
        youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url,
        bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url,
        soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url,
        artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
        artist_wikipedia_url: artwork.wikipedia_url ?? null,
        metadata_status: 'enriched_match',
      })
      .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
  }

  // No-match: synthesized search URLs only. The other 7 metadata columns are
  // left untouched — preserves any prior out-of-band values (e.g. recovery
  // writes from #686-era scripts). Mirrors the backfill's deliberate
  // divergence from the runtime path (see backfill enrich.ts header).
  const updated = await db
    .update(flowsheet)
    .set({
      youtube_music_url: searchUrls.youtube_music_url,
      bandcamp_url: searchUrls.bandcamp_url,
      soundcloud_url: searchUrls.soundcloud_url,
      metadata_status: 'enriched_no_match',
    })
    .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
};
