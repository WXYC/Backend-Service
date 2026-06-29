/**
 * Finalize UPDATE for the enrichment consumer (BS#892 / Epic C C2).
 *
 * Mirrors `jobs/flowsheet-metadata-backfill/enrich.ts` in shape — the same
 * 10-column on-match payload, the same 4-column on-no-match payload, the
 * same spacer.gif filter, the same synthesized search URLs — but with a
 * different idempotency guard and a different terminal state.
 *
 * BS#1336 adds 8 LML-only enrichment columns to the *linked* (album_id
 * non-null) on-match album_metadata payload only — `discogs_artist_id`,
 * `label`, `full_release_date`, `genres`, `styles`, `tracklist`,
 * `artist_image_url`, `bio_tokens`. The unlinked inline-flowsheet path and
 * the no-match arms keep the original 10/4-column shapes (flowsheet carries
 * none of the 8 columns). Sourcing them requires `extended: true` on the LML
 * lookup, set in handler.ts.
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
 * Spacer.gif filter + Discogs bio cleanup: imported from `@wxyc/metadata`
 * (BS#1242 deep-module rollout — the last build-graph-safe consumer to
 * collapse onto the shared module). `synthesizeSearchUrls` stays inline
 * pending a cross-caller decision on the `spotify_url` divergence
 * (BS#1184 / BS#1192: shared `synthesizeSearchUrls` omits Spotify; the
 * inline version here persists a synthesized URL). Pinned by parity test:
 *   - tests/unit/apps/enrichment-worker/synthesize-search-urls-parity.test.ts (BS#889 / BS#1189)
 */

import { and, eq, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';

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

/**
 * BMI composer provenance (BS#1499). Enum-like text on the flowsheet row,
 * mirroring the `linkage_source` precedent in the same table — kept open as
 * text (not a pg enum) so a future source (e.g. `musicbrainz_work`, flagged
 * by LML#699) needs no enum migration. Const-asserted so every `.set({...})`
 * call below is type-checked against exactly these three values.
 */
export type ComposerSource = 'discogs_track' | 'discogs_release' | 'artist_proxy';
type ComposerResolution = { composer: string; composer_source: ComposerSource };

/**
 * Resolve the BMI composer for a playcut from LML's writer credits, with an
 * artist-as-proxy fallback when nothing resolved (the dominant ~79% case per
 * LML#699 — expected, not a regression; it mirrors tubafrenzy's existing
 * auto-fill-BMI_COMPOSER-from-Artist default).
 *
 * Names join with `'; '` because Discogs writer names can themselves contain
 * commas ("Last, First"), so a comma delimiter would be ambiguous; #1500's
 * BMI export owns the field/record delimiters.
 *
 * This ternary is the SOLE site mapping `writer_credits.provenance` →
 * `composer_source`; no other caller should invent a value.
 */
export const resolveComposer = (row: EnrichRow, artwork: DiscogsMatchResult | null): ComposerResolution => {
  const wc = artwork?.writer_credits;
  if (wc?.names?.length) {
    return {
      composer: wc.names.join('; '),
      composer_source: wc.provenance === 'track' ? 'discogs_track' : 'discogs_release',
    };
  }
  return { composer: row.artist_name, composer_source: 'artist_proxy' };
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
  // BS#1499: composer is a per-playcut property, so it rides the flowsheet
  // UPDATE in all four arms below (never the album-keyed album_metadata
  // UPSERT). Resolved once here; artist-as-proxy fallback on absent credit.
  const { composer, composer_source } = resolveComposer(row, artwork);

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
        // LML-only enrichment fields (BS#1336). Present on `artwork` only
        // because handler.ts now sets `extended: true`; without it these
        // would all write null. Persisting them lets the BS#1331 cache-first
        // read path emit the artist+release subtree on a hit instead of
        // shedding it. `profile_tokens` maps to the `bio_tokens` column
        // (iOS's `bioTokens`). No cleanup/synthesis here — raw passthroughs
        // of what LML resolved for the top-1 release match; the read side
        // (`buildLocalMetadataResponse`) projects + filters to match the
        // cold-fallthrough wire shape.
        discogs_artist_id: artwork.discogs_artist_id ?? null,
        label: artwork.label ?? null,
        full_release_date: artwork.full_release_date ?? null,
        genres: artwork.genres ?? null,
        styles: artwork.styles ?? null,
        tracklist: artwork.tracklist ?? null,
        artist_image_url: artwork.artist_image_url ?? null,
        bio_tokens: artwork.profile_tokens ?? null,
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
        // composer rides the flowsheet UPDATE, not the album_metadata UPSERT
        // above (per-playcut, not album-level — BS#1499).
        .set({ metadata_status: 'enriched_match', composer, composer_source })
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
        // BS#1499: per-playcut composer, alongside the inline metadata columns.
        composer,
        composer_source,
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
      // composer rides the flowsheet UPDATE, not the album_metadata UPSERT
      // above (per-playcut, not album-level — BS#1499). On no-match this is
      // the artist-as-proxy value.
      .set({ metadata_status: 'enriched_no_match', composer, composer_source })
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
      // BS#1499: per-playcut composer (artist-as-proxy on no-match).
      composer,
      composer_source,
    })
    .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
};
