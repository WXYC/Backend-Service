/**
 * Per-row enrichment: turn an LML response into either a flowsheet inline
 * UPDATE (free-form / unlinked rows) or an `album_metadata` UPSERT plus a
 * marker-only flowsheet UPDATE (linked rows). Mirrors the D3 worker pattern
 * in `apps/enrichment-worker/enrich.ts` (BS#899) and closes the historical
 * inline-only drain (BS#1027).
 *
 * Result shape:
 *   - Linked (album_id != null) + match: UPSERT `album_metadata` with the
 *     10-column payload (race-guarded by `updated_at < NOW()`), then
 *     UPDATE `flowsheet` to stamp `metadata_attempt_at = now()` only.
 *   - Linked + no-match: UPSERT just the 3 synthesized search URLs into
 *     `album_metadata`, then stamp the marker on `flowsheet`.
 *   - Unlinked (album_id IS NULL) + match: write the 10 metadata columns
 *     inline on `flowsheet`, stamping the marker in the same .set() block.
 *   - Unlinked + no-match: write the 3 synthesized search URLs inline on
 *     `flowsheet`, stamp the marker.
 *   - On LML throw: caller catches and DOES NOT call this. The row stays
 *     `metadata_attempt_at IS NULL` so the next sweep retries it.
 *
 * Idempotency guard: the flowsheet WHERE narrows by `id = $row.id AND
 * metadata_attempt_at IS NULL`. Critically different from the worker
 * (`apps/enrichment-worker/enrich.ts`), which guards on
 * `metadata_status='enriching'`: the backfill operates on rows the consumer
 * never claimed (no `enriching` transition), so the marker is the right
 * invariant. Borrow the album_metadata UPSERT shape from the worker; do
 * NOT borrow its status-based guard.
 *
 * Spacer.gif filter: applied inline. Discogs occasionally returns
 * `spacer.gif` placeholder images; persisting them would pollute the
 * historical drain. The runtime path filters at the chokepoint in
 * `metadata.service.ts:extractAlbumMetadata` (#649); this job carries its
 * own copy because `lml-fetch.ts` deliberately does not go through the
 * backend service (build-graph isolation, see file header).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';

export type EnrichRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
  // BS#1027 / Epic D: non-null → UPSERT album_metadata + flowsheet marker
  // stamp only; null → write the 10 metadata columns inline on flowsheet
  // (free-form entries, until their linkage resolves). Sourced from the
  // orchestrator's SELECT (`loadBatch` in orchestrate.ts).
  album_id: number | null;
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
export const extractArtwork = (response: LookupResponse): DiscogsMatchResult | null => {
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
export const applyEnrichment = async (row: EnrichRow, response: LookupResponse): Promise<EnrichOutcome> => {
  const artwork = extractArtwork(response);
  const searchUrls = synthesizeSearchUrls(row);

  // Marker-only flowsheet UPDATE used on the linked path. Stamp lives alone
  // in the .set() because the 10 metadata columns landed in album_metadata
  // a step earlier; the flowsheet write only records "we attempted this
  // row" so the next sweep skips it.
  const markerWhere = and(eq(flowsheet.id, row.id), isNull(flowsheet.metadata_attempt_at));

  if (artwork) {
    const payload = {
      artwork_url: filterSpacerGif(artwork.artwork_url),
      discogs_url: artwork.release_url ?? null,
      // Discogs returns 0 as "year unknown"; coerce to null so the column
      // doesn't carry a sentinel that iOS renders as literal "0". Mirrors
      // the runtime path in `metadata.service.ts#extractAlbumMetadata` (#1002).
      release_year: artwork.release_year || null,
      spotify_url: artwork.spotify_url ?? null,
      apple_music_url: artwork.apple_music_url ?? null,
      // Streaming search URLs: prefer LML's, fall back to synthesized.
      youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url,
      bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url,
      soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url,
      artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
      artist_wikipedia_url: artwork.wikipedia_url ?? null,
    };

    if (row.album_id !== null) {
      // Linked + match: 10-col payload lands in album_metadata; flowsheet
      // UPDATE only stamps the marker. The album_metadata UPSERT is
      // idempotent (same album_id → same row) and guarded by
      // `updated_at < NOW()` so a delayed backfill cycle can't overwrite
      // a fresher runtime or worker enrichment of the same album_id.
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
        .set({ metadata_attempt_at: sql`now()` })
        .where(markerWhere)
        .returning({ id: flowsheet.id });
      return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
    }

    // Unlinked + match: write the 10 columns inline on flowsheet — as
    // before BS#1027. These rows can't enrich into album_metadata until
    // linkage resolves; D4's column-drop is gated on no unlinked
    // enrichments remaining.
    const updated = await db
      .update(flowsheet)
      .set({
        ...payload,
        // Stamp lives inside the same .set() so a partial UPDATE can't
        // mark a row as "attempted" without writing the data we just
        // fetched (#639 codified this single-block contract).
        metadata_attempt_at: sql`now()`,
      })
      .where(sql`"id" = ${row.id} AND "metadata_attempt_at" IS NULL`)
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
  }

  // No-match: synthesize search URLs and stamp. The other 7 metadata
  // columns are NOT touched on either branch. The backfill encounters rows
  // that may already have prior values from out-of-band paths (e.g. the
  // 2026-04-28 inline recovery, `scripts/backfill-metadata.ts`), so nulling
  // them on a no-match would be silent data loss.
  if (row.album_id !== null) {
    // Linked + no-match: UPSERT just the 3 search URLs into album_metadata.
    // INSERT path leaves the other 7 columns NULL (no LML match to fill
    // them); UPDATE path leaves them untouched on existing rows
    // (preserves any prior out-of-band values, matching the unlinked
    // path's deliberate non-clobbering on no-match).
    await db
      .insert(album_metadata)
      .values({
        album_id: row.album_id,
        youtube_music_url: searchUrls.youtube_music_url,
        bandcamp_url: searchUrls.bandcamp_url,
        soundcloud_url: searchUrls.soundcloud_url,
        updated_at: sql`NOW()`,
      })
      .onConflictDoUpdate({
        target: album_metadata.album_id,
        set: {
          youtube_music_url: searchUrls.youtube_music_url,
          bandcamp_url: searchUrls.bandcamp_url,
          soundcloud_url: searchUrls.soundcloud_url,
          updated_at: sql`NOW()`,
        },
        setWhere: sql`${album_metadata.updated_at} < NOW()`,
      });
    const updated = await db
      .update(flowsheet)
      .set({ metadata_attempt_at: sql`now()` })
      .where(markerWhere)
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
  }

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
