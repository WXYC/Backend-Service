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
 * `tests/unit/jobs/flowsheet-artwork-repair/filter-spacer-gif-parity.test.ts`.
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

export const extractArtwork = (response: LookupResponse): DiscogsMatchResult | null => {
  const first = response.results?.[0];
  if (!first?.artwork) return null;
  return first.artwork;
};

const buildPayload = (artwork: DiscogsMatchResult) => ({
  artwork_url: filterSpacerGif(artwork.artwork_url),
  discogs_url: artwork.release_url ?? null,
  // Discogs returns 0 as "year unknown"; null avoids the literal "0"
  // iOS would otherwise render. Matches `metadata.service.ts#extractAlbumMetadata` (#1002).
  release_year: artwork.release_year || null,
  spotify_url: artwork.spotify_url ?? null,
  apple_music_url: artwork.apple_music_url ?? null,
  youtube_music_url: artwork.youtube_music_url ?? null,
  bandcamp_url: artwork.bandcamp_url ?? null,
  soundcloud_url: artwork.soundcloud_url ?? null,
  artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
  artist_wikipedia_url: artwork.wikipedia_url ?? null,
});

export const repairFreeFormRow = async (row: FreeFormRow, response: LookupResponse): Promise<RepairOutcome> => {
  const artwork = extractArtwork(response);
  if (!artwork || !artwork.artwork_url) return 'still_null_after_lml';

  const updated = await db
    .update(flowsheet)
    .set(buildPayload(artwork))
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
