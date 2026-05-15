/**
 * Per-row enrichment: turn an LML response into the 10-column flowsheet
 * UPDATE that mirrors the runtime path (#658, `enrichment.service.ts`).
 *
 * Result shape (matches the runtime fire-and-forget):
 *   - On success-with-match: write the 10 metadata columns from artwork,
 *     stamping `metadata_attempt_at = now()` in the same .set() block.
 *   - On success-no-match: write synthesized search URLs into
 *     youtube_music_url / bandcamp_url / soundcloud_url, leave the rest
 *     as NULL, still stamp the marker.
 *   - On LML throw: caller catches and DOES NOT call this. The row stays
 *     `metadata_attempt_at IS NULL` so the next sweep retries it.
 *
 * Idempotency: the WHERE narrows by `id = $row.id AND metadata_attempt_at
 * IS NULL`. A row that the runtime path stamped between the orchestrator's
 * SELECT and this UPDATE is left alone — both writers produce identical
 * data so this matters only as a guard against double-stamping a row
 * whose runtime stamp would otherwise be older. The benign race is
 * documented inline; no CAS pattern needed.
 *
 * Spacer.gif filter: applied inline. Discogs occasionally returns
 * `spacer.gif` placeholder images; persisting them would pollute 1.86M rows
 * for the historical drain alone. The runtime path filters at the chokepoint
 * in `metadata.service.ts:extractAlbumMetadata` (#649); this job carries
 * its own copy because `lml-fetch.ts` deliberately does not go through the
 * backend service (build-graph isolation, see file header). Applied only
 * to `artwork_url` — the other URL columns in the same `.set()` block come
 * from the `streaming_links` table or LML-constructed search URLs, never
 * Discogs image responses (verified against `lookup/orchestrator.py:855-970`,
 * see #679).
 */

import { sql } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import type { LmlArtwork, LmlLookupResponse } from './lml-types.js';

export type EnrichRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
};

export type EnrichOutcome = 'enriched_match' | 'enriched_match_raced' | 'enriched_no_match' | 'enriched_no_match_raced';

/**
 * Strip Discogs markup tags from bio text (mirrors metadata.service.ts).
 *
 * Exported for direct unit testing. Inlined into the job rather than
 * imported from the backend service for the same build-graph isolation
 * reason as `lml-fetch.ts` and `synthesizeSearchUrls`.
 */
export const cleanDiscogsBio = (bio: string): string =>
  bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');

/**
 * Drop Discogs spacer.gif placeholder URLs. Inline guard, duplicated for
 * build-graph isolation from `apps/backend` (see file header). Must stay
 * truthy/falsy-equivalent to the canonical
 * `apps/backend/services/metadata/metadata.service.ts#filterSpacerGif`
 * (BS#890). The job writes to DB columns that are nullable, so the inline
 * copy returns `null` while the canonical returns `undefined`; the parity
 * test at
 * `tests/unit/jobs/flowsheet-metadata-backfill/filter-spacer-gif-parity.test.ts`
 * pins truthy/falsy parity across the two for all the inputs the runtime
 * exercises.
 */
export const filterSpacerGif = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.includes('spacer.gif')) return null;
  return url;
};

/**
 * Synthesize the three search URLs the runtime path falls back to on
 * no-match. Must match `apps/backend/services/metadata/providers/search-urls.provider.ts`
 * exactly — the inline copy is duplicated rather than imported for the same
 * build-graph isolation reason as `lml-fetch.ts`. The parity test at
 * `tests/unit/jobs/flowsheet-metadata-backfill/synthesize-search-urls-parity.test.ts`
 * pins the equivalence so the two cannot drift (BS#889).
 *
 * Per-service semantics (deliberately asymmetric):
 *   - YouTube Music: trackTitle > albumTitle > artistName (3-tier).
 *   - Bandcamp:      albumTitle > artistName (album-leaning).
 *   - SoundCloud:    trackTitle > artistName (track-leaning, NO album
 *                    fallback — album-only SoundCloud queries return
 *                    unrelated DJ mixes more often than the album).
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

/**
 * Pick the first artwork from an LML response, or null on no-match.
 *
 * "No artwork" covers three LML response shapes that all mean the same
 * thing operationally: empty `results`, a `results[0]` with no `artwork`
 * field, or `artwork: null`. All three end up writing search URLs and
 * stamping the marker.
 */
export const extractArtwork = (response: LmlLookupResponse): LmlArtwork | null => {
  const first = response.results?.[0];
  if (!first) return null;
  if (!first.artwork) return null;
  return first.artwork;
};

/**
 * Apply a single LML response to a flowsheet row.
 *
 * Returns the outcome so the orchestrator can count it. Errors propagate
 * up — this function does not swallow.
 *
 * The `.returning({ id: ... })` call is the race detector: when the
 * orchestrator's SELECT and this UPDATE bracket a runtime-path stamp on
 * the same row, the WHERE's `metadata_attempt_at IS NULL` no longer
 * matches and Postgres updates 0 rows. Returning an empty array tells
 * the caller "the runtime path beat us" — `*_raced` outcome — so metrics
 * separate "I personally enriched this row" from "this row was enriched
 * by *someone* during the run." The data outcome is identical either way
 * (both writers produce the same payload).
 */
export const applyEnrichment = async (row: EnrichRow, response: LmlLookupResponse): Promise<EnrichOutcome> => {
  const artwork = extractArtwork(response);
  const searchUrls = synthesizeSearchUrls(row);

  if (artwork) {
    const updated = await db
      .update(flowsheet)
      .set({
        artwork_url: filterSpacerGif(artwork.artwork_url),
        discogs_url: artwork.release_url ?? null,
        release_year: artwork.release_year ?? null,
        spotify_url: artwork.spotify_url ?? null,
        apple_music_url: artwork.apple_music_url ?? null,
        // Streaming search URLs: prefer LML's, fall back to synthesized.
        // Matches the runtime path's behavior in `metadata.service.ts`.
        youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url,
        bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url,
        soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url,
        artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
        artist_wikipedia_url: artwork.wikipedia_url ?? null,
        // Stamp lives inside the same .set() so a partial UPDATE can't
        // mark a row as "attempted" without writing the data we just
        // fetched. #639 codified the same single-block contract for the
        // runtime path.
        metadata_attempt_at: sql`now()`,
      })
      // Idempotency guard: the WHERE narrows by `metadata_attempt_at IS
      // NULL`, so a row the runtime path stamped between the
      // orchestrator's SELECT and this UPDATE matches 0 rows. The
      // partial index from #659 makes the WHERE fast — the index is the
      // performance enabler, the WHERE itself is what filters.
      .where(sql`"id" = ${row.id} AND "metadata_attempt_at" IS NULL`)
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
  }

  // No-match: synthesize search URLs and stamp. Critically, the other 7
  // metadata columns are NOT touched. This diverges from the runtime path
  // (`apps/backend/services/metadata/enrichment.service.ts`) — the
  // runtime nulls all 10 columns on no-match because it runs at insert
  // time over fresh rows with nothing to lose.
  //
  // The backfill encounters rows that may already have prior values from
  // out-of-band paths: the 2026-04-28 inline recovery
  // (`scripts/backfill-metadata.ts`) wrote the full 10-column payload to
  // ~618 rows pre-#658, so their `metadata_attempt_at` is NULL even
  // though `artwork_url` / `discogs_url` / etc are populated. If LML now
  // returns no-match for such a row, the recovery's prior data is the
  // better signal and should be preserved. Nulling here would be silent
  // data loss.
  //
  // The divergence is intentional, not a bug. Future: if the runtime
  // path ever needs to run over rows with prior values (e.g., a
  // re-enrichment trigger), it should adopt the same preserve semantics.
  const updated = await db
    .update(flowsheet)
    .set({
      youtube_music_url: searchUrls.youtube_music_url,
      bandcamp_url: searchUrls.bandcamp_url,
      soundcloud_url: searchUrls.soundcloud_url,
      metadata_attempt_at: sql`now()`,
    })
    .where(sql`"id" = ${row.id} AND "metadata_attempt_at" IS NULL`)
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
};
