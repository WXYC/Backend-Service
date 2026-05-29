/**
 * Per-row repair writers for the BS#1209 drain.
 *
 * Free-form path UPDATEs `flowsheet` under an idempotent WHERE; linked
 * path UPSERTs `album_metadata` under `setWhere: updated_at < NOW()`.
 * `metadata_status` is read-only on both paths — the LML#400 follow-up
 * backfill (if filed) will revisit `still_null_after_lml` rows for
 * status correction.
 *
 * The 10-column payload, spacer.gif filter, and Discogs-bio cleanup
 * mirror `apps/enrichment-worker/enrich.ts:181-198`. Inlined for the
 * same build-graph isolation the sibling drains carry (no imports from
 * `apps/backend`); parity pinned via
 * `tests/unit/jobs/flowsheet-artwork-repair/filter-spacer-gif-parity.test.ts`
 * and `tests/unit/jobs/flowsheet-artwork-repair/synthesize-search-urls-parity.test.ts`.
 *
 * Streaming-URL fallback asymmetry (mirrors the canonical writers):
 *   - Free-form path has track_title available → synthesize search URLs
 *     and use `artwork.* ?? searchUrls.*` for youtube / bandcamp /
 *     soundcloud (same shape as enrichment-worker:171-174 and
 *     flowsheet-metadata-backfill/enrich.ts:172-174). Avoids regressing
 *     existing synthesized URLs when LML returns null on those columns.
 *   - Linked path has no track_title → fall back to `?? null` (same as
 *     album-level-backfill/job.ts:294-296). SoundCloud's track-leaning
 *     query would degrade to an album-only search that returns unrelated
 *     DJ mixes, so leave the column null rather than synthesizing
 *     against insufficient inputs.
 */

import { sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';

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

/**
 * `still_null_after_lml` covers all three "no usable artwork from LML"
 * shapes (empty results, `artwork: null`, `artwork.artwork_url: null`).
 * `raced` means the row was eligible at SELECT time but a concurrent
 * fresh enrichment landed first; the WHERE / setWhere correctly no-ops.
 * The orchestrator buckets `repaired` / `raced` per population.
 */
export type RepairOutcome = 'repaired' | 'raced' | 'still_null_after_lml';

export const cleanDiscogsBio = (bio: string): string =>
  bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');

/**
 * Returns `null` (not `undefined`) — repair writes to nullable DB columns.
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
 * build-graph isolation reason as the rest of `repair.ts`. Parity test at
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
  if (!first?.artwork) return null;
  return first.artwork;
};

type SearchUrls = { youtube_music_url: string; bandcamp_url: string; soundcloud_url: string };

/**
 * Free-form variant: streaming URLs fall back to synthesized queries so
 * we never regress a populated column to null. `searchUrls` is required.
 *
 * Linked-album variant (`searchUrls` omitted): streaming URLs fall back
 * to null — track_title isn't available, and SoundCloud's track-leaning
 * query would degrade poorly on artist+album only inputs.
 */
const buildPayload = (artwork: DiscogsMatchResult, searchUrls?: SearchUrls) => ({
  artwork_url: filterSpacerGif(artwork.artwork_url),
  discogs_url: artwork.release_url ?? null,
  // Discogs returns 0 as "year unknown"; null avoids the literal "0"
  // iOS would otherwise render. Matches `metadata.service.ts#extractAlbumMetadata` (#1002).
  release_year: artwork.release_year || null,
  spotify_url: artwork.spotify_url ?? null,
  apple_music_url: artwork.apple_music_url ?? null,
  youtube_music_url: artwork.youtube_music_url ?? searchUrls?.youtube_music_url ?? null,
  bandcamp_url: artwork.bandcamp_url ?? searchUrls?.bandcamp_url ?? null,
  soundcloud_url: artwork.soundcloud_url ?? searchUrls?.soundcloud_url ?? null,
  artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
  artist_wikipedia_url: artwork.wikipedia_url ?? null,
});

export const repairFreeFormRow = async (row: FreeFormRow, response: LookupResponse): Promise<RepairOutcome> => {
  const artwork = extractArtwork(response);
  if (!artwork || !artwork.artwork_url) return 'still_null_after_lml';

  const updated = await db
    .update(flowsheet)
    .set(buildPayload(artwork, synthesizeSearchUrls(row)))
    .where(sql`"id" = ${row.id} AND "artwork_url" IS NULL AND "metadata_status" = 'enriched_match'`)
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'raced' : 'repaired';
};

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
  return updated.length === 0 ? 'raced' : 'repaired';
};
