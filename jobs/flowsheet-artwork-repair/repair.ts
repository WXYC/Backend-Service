/**
 * Per-row repair writers for the flowsheet-artwork-repair drain (BS#1209).
 *
 * Two populations stranded by LML#408 (fixed in LML#409, deployed prod
 * 2026-05-29):
 *
 *   1. Free-form rows  — `flowsheet.album_id IS NULL`,
 *                        `metadata_status = 'enriched_match'`,
 *                        `artwork_url IS NULL`. The enrichment-worker landed
 *                        a 10-col UPDATE with `artwork_url=NULL` and flipped
 *                        the status to `enriched_match`. We re-query LML and
 *                        write the same 10 cols (status untouched).
 *   2. Linked rows     — `album_metadata.artwork_url IS NULL`. The worker
 *                        UPSERTed `album_metadata` with `artwork_url=NULL`.
 *                        We re-query LML and UPSERT the same 10 cols. No
 *                        flowsheet write — the read-path COALESCE join over
 *                        `album_metadata` picks the fix up automatically.
 *
 * Hard contracts (from the ticket body):
 *
 *   - `metadata_status` is read-only. The drain MUST NOT flip it. The
 *     LML#400 follow-up backfill (if filed) will revisit `still_null_after_lml`
 *     rows for status correction.
 *   - Race-guarded WHERE on the free-form UPDATE: `id = $1 AND artwork_url
 *     IS NULL AND metadata_status = 'enriched_match'`. A concurrent fresh
 *     enrichment between the orchestrator's SELECT and our UPDATE would have
 *     flipped one of those two columns; either flip kicks the row out of
 *     the WHERE and we return `free_form_raced` instead of corrupting
 *     fresher data.
 *   - Race-guarded UPSERT on the linked path: `setWhere: album_metadata.
 *     updated_at < NOW()`, mirroring the enrichment-worker shape verbatim.
 *
 * The 10-column payload and the `release_year || null` coercion mirror
 * `apps/enrichment-worker/enrich.ts:159-175` (canonical writer) and
 * `jobs/flowsheet-metadata-backfill/enrich.ts` (sibling drain). The
 * duplication is the same build-graph isolation the other one-shot jobs
 * carry: no imports from `apps/backend` so the job's Docker image graph
 * is independent. The spacer.gif filter and Discogs-bio cleanup now come
 * from `@wxyc/metadata`, the build-graph-safe deep module that lifted
 * those two helpers out of every inline copy (#1242). The inline
 * `synthesizeSearchUrls` stays here for now — the shared helper omits
 * `spotify_url` per BS#1184/BS#1192 while every production writer
 * (worker + 4 jobs) actively persists a synthesized Spotify URL, so
 * collapsing it requires a separate cross-caller behavior decision.
 *
 * No-write early-return on still-null-after-LML: a fresh LML lookup that
 * returns `results: []`, `artwork: null`, or `artwork.artwork_url: null`
 * means the row is legitimate no-cover-anywhere territory (post-LML#409).
 * Writing null over null is a no-op at best and confuses the
 * `still_null_after_lml` counter at worst. Return early; let the LML#400
 * follow-up consume the bucket.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';

export type FreeFormRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
};

export type LinkedAlbum = {
  album_id: number;
  artist_name: string;
  album_title: string;
};

export type RepairOutcome =
  'free_form_repaired' | 'free_form_raced' | 'linked_repaired' | 'linked_raced' | 'still_null_after_lml';

/**
 * Synthesize the three search URLs the runtime path falls back to on
 * no-match. Must match `apps/backend/services/metadata/providers/search-urls.provider.ts`
 * exactly — inline copy duplicated for the same build-graph isolation
 * reason as the rest of `repair.ts`. Parity test at
 * `tests/unit/jobs/flowsheet-artwork-repair/synthesize-search-urls-parity.test.ts`
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
  row: FreeFormRow
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
  if (!first?.artwork) return null;
  return first.artwork;
};

type SearchUrls = ReturnType<typeof synthesizeSearchUrls>;

/**
 * 10-column payload. Mirrors `apps/enrichment-worker/enrich.ts:159-175`
 * (canonical writer).
 *
 * Streaming-URL fallback asymmetry:
 *   - Free-form path (`searchUrls` provided): fall back to synthesized
 *     queries via `artwork.* ?? searchUrls.*`, same shape as the
 *     enrichment-worker (lines 171-174) + flowsheet-metadata-backfill
 *     (enrich.ts:172-174). The drain target rows were originally enriched
 *     by the worker, which writes synthesized URLs on null. Writing null
 *     over those would regress dj-site + iOS streaming links — that's
 *     what BS#1209 was about.
 *   - Linked path (`searchUrls` omitted): fall back to `null` — no
 *     track_title available, and SoundCloud's track-leaning query would
 *     degrade to album-only mixes (same call as
 *     `album-level-backfill/job.ts:294-296`).
 */
const buildPayload = (artwork: DiscogsMatchResult, searchUrls?: SearchUrls) => ({
  artwork_url: filterSpacerGif(artwork.artwork_url),
  discogs_url: artwork.release_url ?? null,
  // Discogs returns 0 as "year unknown"; null avoids the literal "0"
  // iOS would otherwise render. Matches `metadata.service.ts#extractAlbumMetadata` (#1002).
  release_year: artwork.release_year || null,
  spotify_url: artwork.spotify_url ?? searchUrls?.spotify_url ?? null,
  // apple_music_url stays `?? null` — null is load-bearing per BS#1192
  // ("no verified iTunes match" signal; the read-path proxy synthesizes
  // its own search URL when needed).
  apple_music_url: artwork.apple_music_url ?? null,
  youtube_music_url: artwork.youtube_music_url ?? searchUrls?.youtube_music_url ?? null,
  bandcamp_url: artwork.bandcamp_url ?? searchUrls?.bandcamp_url ?? null,
  soundcloud_url: artwork.soundcloud_url ?? searchUrls?.soundcloud_url ?? null,
  artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
  artist_wikipedia_url: artwork.wikipedia_url ?? null,
});

/**
 * Repair one free-form flowsheet row. UPDATE `flowsheet` with the 10
 * metadata columns; idempotent WHERE narrows by `id`, `artwork_url IS NULL`,
 * `metadata_status = 'enriched_match'`. `metadata_status` is NOT in the
 * .set() block.
 *
 * Outcomes:
 *   - `still_null_after_lml` — LML returned no usable artwork; no DB write.
 *   - `free_form_raced` — UPDATE ran, 0 rows matched (artwork already
 *     non-null OR status flipped). Idempotent; correctness preserved.
 *   - `free_form_repaired` — UPDATE ran, 1 row matched. Done.
 */
export const repairFreeFormRow = async (row: FreeFormRow, response: LookupResponse): Promise<RepairOutcome> => {
  const artwork = extractArtwork(response);
  if (!artwork || !artwork.artwork_url) return 'still_null_after_lml';

  const updated = await db
    .update(flowsheet)
    .set(buildPayload(artwork, synthesizeSearchUrls(row)))
    .where(sql`"id" = ${row.id} AND "artwork_url" IS NULL AND "metadata_status" = 'enriched_match'`)
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'free_form_raced' : 'free_form_repaired';
};

/**
 * Repair one linked album. UPSERT `album_metadata` with the 10 metadata
 * columns + `updated_at = NOW()`. Race guard: `setWhere: album_metadata.
 * updated_at < NOW()` mirrors the enrichment-worker shape (BS#899)
 * verbatim. No flowsheet write — the read-path COALESCE join picks the
 * fix up automatically.
 *
 * Outcomes:
 *   - `still_null_after_lml` — LML returned no usable artwork; no DB write.
 *   - `linked_raced` — UPSERT's ON CONFLICT branch didn't fire (setWhere
 *     missed); a concurrent fresh enrichment landed first. RETURNING is
 *     empty.
 *   - `linked_repaired` — UPSERT wrote a row. RETURNING is non-empty.
 *
 * Note on race detection: the linked population's qualifying SELECT
 * (`album_metadata.artwork_url IS NULL`) guarantees a row already exists
 * for `album_id`, so we always take the UPDATE branch in practice. The
 * INSERT branch is unreachable but specified for correctness against
 * future schema changes (e.g., a partial unique index that lets the row
 * be deleted out from under us).
 */
export const repairLinkedAlbum = async (album: LinkedAlbum, response: LookupResponse): Promise<RepairOutcome> => {
  const artwork = extractArtwork(response);
  if (!artwork || !artwork.artwork_url) return 'still_null_after_lml';

  const payload = buildPayload(artwork);
  const updated = await db
    .insert(album_metadata)
    .values({ album_id: album.album_id, ...payload, updated_at: sql`NOW()` })
    .onConflictDoUpdate({
      target: album_metadata.album_id,
      set: { ...payload, updated_at: sql`NOW()` },
      setWhere: sql`${album_metadata.updated_at} < NOW()`,
    })
    .returning({ album_id: album_metadata.album_id });
  return updated.length === 0 ? 'linked_raced' : 'linked_repaired';
};

/**
 * Re-export the drizzle helper trio for tests + orchestrator. Keeps the
 * surface of imports stable across the package.
 */
export { and, eq, isNull };
