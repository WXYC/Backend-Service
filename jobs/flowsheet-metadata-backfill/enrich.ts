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
 *   - Linked + no-match: UPSERT just the 4 synthesized search URLs into
 *     `album_metadata`, then stamp the marker on `flowsheet`.
 *   - Unlinked (album_id IS NULL) + match: write the 10 metadata columns
 *     inline on `flowsheet`, stamping the marker in the same .set() block.
 *   - Unlinked + no-match: write the 4 synthesized search URLs inline on
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
 * BS#1336 NOTE: the worker now writes 8 additional LML-only columns
 * (discogs_artist_id, label, full_release_date, genres, styles, tracklist,
 * artist_image_url, bio_tokens) on its linked+match UPSERT. This job stays at
 * the 10-column shape for now (extending it needs `extended: true` on the
 * lookup; tracked in BS#1442). SAFE because the `set` clause omits those 8
 * columns → a backfill UPSERT preserves any worker-written values, never
 * clobbers. DO NOT add them to `set` as nulls without sourcing them via
 * `extended: true`, or the backfill would clobber the worker's writes.
 *
 * Spacer.gif filter + Discogs bio cleanup: imported from `@wxyc/metadata`
 * (BS#1242 deep-module rollout). The shared module is build-graph-safe for
 * jobs; replaces the inline duplicates previously pinned by parity tests.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';

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
 * Synthesize the four search URLs the runtime path falls back to on
 * no-match. Must match the write-path shape of
 * `apps/backend/services/metadata/metadata.service.ts#fetchMetadata`
 * exactly — the inline copy is duplicated rather than imported for the
 * same build-graph isolation reason as `lml-fetch.ts`. The parity test at
 * `tests/unit/jobs/flowsheet-metadata-backfill/synthesize-search-urls-parity.test.ts`
 * pins the equivalence so the two cannot drift (BS#889 / BS#1189).
 *
 * Apple Music is intentionally absent (BS#1192): LML's `apple_music_url`
 * is load-bearing — null means "no verified iTunes match" — and persisting
 * a `music.apple.com/search?term=…` URL on the write path launders that
 * signal into a clickable button that drops users on the in-app search
 * page. The read path (`proxy.controller.getAlbumMetadata`) still fills
 * Apple at request time for the iOS Tragic Magic surface, where there's
 * no persisted row to poison.
 *
 * Per-service semantics (deliberately asymmetric):
 *   - Spotify:       trackTitle > albumTitle > artistName. Path-style URL
 *                    (`https://open.spotify.com/search/<query>`) matches
 *                    LML's `_build_streaming_search_url` byte-for-byte so
 *                    iOS reads back the same URL whether LML surfaced it
 *                    or BS synthesized it (BS#1185 + LML#401).
 *   - YouTube Music: trackTitle > albumTitle > artistName (3-tier).
 *   - Bandcamp:      albumTitle > artistName (album-leaning).
 *   - SoundCloud:    trackTitle > artistName (track-leaning, NO album
 *                    fallback — album-only SoundCloud queries return
 *                    unrelated DJ mixes more often than the album).
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
      // Streaming search URLs: prefer LML's, fall back to synthesized.
      // Apple Music has no fallback — null is load-bearing "no verified
      // iTunes match" signal (BS#1192).
      //
      // All five track-aware URL columns use a conditional spread on the
      // `'<field>' in artwork` witness to preserve R1's verified value on
      // cache hits (BS#1338). The run-scoped LookupCache deletes each of
      // the five keys from the artwork object on hit
      // (lookup-cache.ts:TRACK_AWARE_URL_FIELDS) because LML returns them
      // per-track and the row that populated the cache wasn't necessarily
      // the same track. Without the witness, the `??` fallback would
      // synthesize a search URL (or write null, for apple_music_url) on
      // R2, then the album_metadata UPSERT's `setWhere updated_at < NOW()`
      // guard would happily apply it — that predicate always passes
      // within a single batch (R1's updated_at is microseconds in the
      // past), so R2's per-row write clobbers R1's verified deep-link
      // (apple_music_url: BS#1192 destructive null; the four search URLs:
      // BS#1338 verified→synthesized degradation). The conditional spread
      // OMITS the column from both the album_metadata UPSERT
      // (INSERT + onConflictDoUpdate.set) and the inline unlinked UPDATE
      // on cache-stripped hits, so the prior value survives untouched.
      // Present-in-artwork still records LML's decision (string for the
      // four search URLs; string or null for apple_music_url) on misses.
      // Mirrors the strip-deletes-keys contract documented at
      // lookup-cache.ts:62-73.
      ...('spotify_url' in artwork ? { spotify_url: artwork.spotify_url ?? searchUrls.spotify_url } : {}),
      ...('apple_music_url' in artwork ? { apple_music_url: artwork.apple_music_url ?? null } : {}),
      ...('youtube_music_url' in artwork
        ? { youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url }
        : {}),
      ...('bandcamp_url' in artwork ? { bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url } : {}),
      ...('soundcloud_url' in artwork ? { soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url } : {}),
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
    // Linked + no-match: UPSERT just the 4 search URLs into album_metadata
    // (Apple stays out per BS#1192). INSERT path leaves the other 6 columns
    // NULL (no LML match to fill them); UPDATE path leaves them untouched
    // on existing rows (preserves any prior out-of-band values, matching
    // the unlinked path's deliberate non-clobbering on no-match).
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
      .set({ metadata_attempt_at: sql`now()` })
      .where(markerWhere)
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
      metadata_attempt_at: sql`now()`,
    })
    .where(sql`"id" = ${row.id} AND "metadata_attempt_at" IS NULL`)
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
};

/**
 * Best-effort marker-only stamp for a *permanently*-failing row (BS#1562).
 *
 * When `applyEnrichment` throws with an SQLSTATE that re-running the same row
 * would always reproduce (e.g. a mojibake title whose synthesized Bandcamp
 * URL overflows `flowsheet.bandcamp_url varchar(512)` — SQLSTATE 22001), the
 * row never got its `metadata_attempt_at` marker, so the id-cursor re-selects
 * it every nightly run and the pending cohort never reaches literal 0 — which
 * breaks BS#1011's "cohort COUNT == 0 → retire the cron" completion criterion.
 *
 * This dead-letters the row: it stamps `metadata_attempt_at = now()` alone
 * (writing none of the URLs that overflowed) so the row leaves the
 * `metadata_attempt_at IS NULL` cohort while staying distinguishable from a
 * successful enrichment (its metadata columns stay NULL). The WHERE mirrors
 * `applyEnrichment`'s marker-IS-NULL race guard so a concurrent runtime stamp
 * still wins.
 *
 * MUST be best-effort: any throw from the stamp itself is swallowed so it can
 * never re-wedge the drain the way the original poison-pill jam did (BS#1561).
 * The orchestrator's id-cursor advances regardless, so at worst a stamp that
 * fails to land leaves the row for a future sweep — never a stall.
 */
export const stampDeadLetter = async (rowId: number): Promise<void> => {
  try {
    await db
      .update(flowsheet)
      .set({ metadata_attempt_at: sql`now()` })
      // Raw `id AND metadata_attempt_at IS NULL` predicate, mirroring the
      // unlinked-path UPDATE above — the marker-IS-NULL race guard means a
      // concurrent runtime stamp still wins, and there's nothing to write but
      // the marker itself.
      .where(sql`"id" = ${rowId} AND "metadata_attempt_at" IS NULL`);
  } catch {
    // Swallow: the marker is a drain-hygiene optimization, not a correctness
    // requirement. Re-throwing here would defeat the whole purpose (isolating
    // the poison row so the cursor advances). The enrich failure was already
    // logged and captured by the caller.
  }
};
