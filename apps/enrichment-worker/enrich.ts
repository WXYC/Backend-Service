/**
 * Finalize UPDATE for the enrichment consumer (BS#892 / Epic C C2).
 *
 * Mirrors `jobs/flowsheet-metadata-backfill/enrich.ts` in shape — the same
 * 10-column on-match payload, the same 4-column on-no-match payload, the
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
 * cleaner are inlined rather than imported from `apps/backend` so this package
 * can bundle independently. The canonical implementations are in
 * `apps/backend/services/metadata/metadata.service.ts` (spacer.gif filter,
 * the 4-URL write-path shape post-BS#1192) and
 * `apps/backend/services/metadata/providers/search-urls.provider.ts` (the
 * per-service search-URL formulas); divergence here would be a bug. Pinned
 * by parity tests:
 *   - tests/unit/apps/enrichment-worker/filter-spacer-gif-parity.test.ts (BS#890)
 *   - tests/unit/apps/enrichment-worker/synthesize-search-urls-parity.test.ts (BS#889 / BS#1189)
 * Also gated by scripts/check-spacer-gif-callsites.sh in CI.
 */

import { and, eq, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';

export type EnrichRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
  // Epic D / BS#899: non-null → UPSERT album_metadata + flowsheet status
  // flip only; null → write the 10 metadata columns inline on flowsheet
  // (free-form entries, until their linkage resolves). Source: CDC payload
  // via filterForEnrichment.
  album_id: number | null;
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
 *   - Spotify:       trackTitle > albumTitle > artistName. Path-style URL
 *                    matches LML's `_build_streaming_search_url` byte-for-byte
 *                    so iOS reads back the same URL whether LML surfaced it
 *                    or BS synthesized it (BS#1185 + LML#401).
 *   - YouTube Music: trackTitle > albumTitle > artistName
 *   - Bandcamp:      albumTitle > artistName (album-leaning)
 *   - SoundCloud:    trackTitle > artistName (NO album fallback — album-only
 *                    SoundCloud queries surface unrelated DJ mixes)
 *
 * Apple Music is intentionally absent (BS#1192): LML's null return on
 * `apple_music_url` is load-bearing ("no verified iTunes match"), and a
 * keyword-search fallback would launder that signal into a clickable
 * button. The read path proxy still fills Apple at request time.
 *
 * Must match the write-path shape of
 * `apps/backend/services/metadata/metadata.service.ts#fetchMetadata`.
 */
export const synthesizeSearchUrls = (
  row: EnrichRow
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
 * Finalize an enriching row with LML's response.
 *
 * Returns the outcome so the dispatcher can count it. The `_raced` variants
 * fire when the flowsheet UPDATE's `.returning({ id })` is empty: the WHERE
 * no longer matches because something else (the C6 cron's stranded-claim
 * sweep, a manual triage operator, or a hypothetical out-of-band writer)
 * flipped `metadata_status` off `'enriching'` between claim and finalize.
 * Same data outcome from the row's perspective; the metric separates "this
 * consumer finalized it" from "the row was finalized by someone."
 *
 * Linked vs unlinked (Epic D / BS#899): if `row.album_id` is non-null the
 * 10-column metadata payload goes into `album_metadata` keyed by album_id
 * (UPSERT), and the flowsheet UPDATE only flips `metadata_status`. If
 * `album_id` is null (free-form entries), the 10 columns are written
 * inline on `flowsheet` as before. The album_metadata UPSERT happens
 * *before* the flowsheet status flip — if either write fails the C6 sweep
 * recovers the stranded `enriching` row and a retry of the (idempotent)
 * UPSERT + flowsheet UPDATE finishes the work.
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
    if (row.album_id !== null) {
      // Linked + match: 10-col payload lands in album_metadata; flowsheet
      // UPDATE only flips status. The album_metadata UPSERT is idempotent
      // (same album_id → same row) and guarded by `updated_at < NOW()` so
      // a concurrent stale write (e.g. delayed drift-repair backfill)
      // can't overwrite a fresher enrichment.
      const payload = {
        artwork_url: filterSpacerGif(artwork.artwork_url),
        discogs_url: artwork.release_url ?? null,
        // Discogs returns 0 as "year unknown"; coerce to null so iOS doesn't
        // render literal "0". Mirrors metadata.service.ts (#1002).
        release_year: artwork.release_year || null,
        // Prefer LML-supplied streaming URLs; fall back to synthesized.
        // Apple Music has no fallback — null is load-bearing "no verified
        // iTunes match" signal (BS#1192).
        spotify_url: artwork.spotify_url ?? searchUrls.spotify_url,
        apple_music_url: artwork.apple_music_url ?? null,
        youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url,
        bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url,
        soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url,
        artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
        artist_wikipedia_url: artwork.wikipedia_url ?? null,
      };
      await db
        .insert(album_metadata)
        .values({ album_id: row.album_id, ...payload, updated_at: sql`NOW()` })
        .onConflictDoUpdate({
          target: album_metadata.album_id,
          set: { ...payload, updated_at: sql`NOW()` },
          setWhere: sql`${album_metadata.updated_at} < NOW()`,
        });
      const updated = await db
        .update(flowsheet)
        .set({ metadata_status: 'enriched_match' })
        .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
        .returning({ id: flowsheet.id });
      return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
    }

    // Unlinked + match: write the 10 columns inline on flowsheet, as before
    // D3. These rows can't enrich into album_metadata until linkage
    // resolves; D4's column-drop is gated on no unlinked enrichments
    // remaining (see #1012 + the broader linkage-completion gate).
    const updated = await db
      .update(flowsheet)
      .set({
        artwork_url: filterSpacerGif(artwork.artwork_url),
        discogs_url: artwork.release_url ?? null,
        release_year: artwork.release_year || null,
        // Apple Music has no fallback — null is load-bearing (BS#1192).
        spotify_url: artwork.spotify_url ?? searchUrls.spotify_url,
        apple_music_url: artwork.apple_music_url ?? null,
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
  if (row.album_id !== null) {
    // Linked + no-match: UPSERT just the 4 search URLs into album_metadata
    // (Apple stays out per BS#1192). INSERT path leaves the other 6 columns
    // NULL (no LML match to fill them); UPDATE path leaves them untouched
    // on existing rows (preserves any prior out-of-band values, same
    // semantics as the unlinked path).
    await db
      .insert(album_metadata)
      .values({
        album_id: row.album_id,
        spotify_url: searchUrls.spotify_url,
        youtube_music_url: searchUrls.youtube_music_url,
        bandcamp_url: searchUrls.bandcamp_url,
        soundcloud_url: searchUrls.soundcloud_url,
        updated_at: sql`NOW()`,
      })
      .onConflictDoUpdate({
        target: album_metadata.album_id,
        set: {
          spotify_url: searchUrls.spotify_url,
          youtube_music_url: searchUrls.youtube_music_url,
          bandcamp_url: searchUrls.bandcamp_url,
          soundcloud_url: searchUrls.soundcloud_url,
          updated_at: sql`NOW()`,
        },
        setWhere: sql`${album_metadata.updated_at} < NOW()`,
      });
    const updated = await db
      .update(flowsheet)
      .set({ metadata_status: 'enriched_no_match' })
      .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
  }

  const updated = await db
    .update(flowsheet)
    .set({
      spotify_url: searchUrls.spotify_url,
      youtube_music_url: searchUrls.youtube_music_url,
      bandcamp_url: searchUrls.bandcamp_url,
      soundcloud_url: searchUrls.soundcloud_url,
      metadata_status: 'enriched_no_match',
    })
    .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
};
