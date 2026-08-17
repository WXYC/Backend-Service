/**
 * Writer for jobs/flowsheet-no-match-recheck (BS#2176).
 *
 * Two write paths, chosen by `candidate.album_id`, both fill-null (never
 * overwrite a populated field with a null) and both race-guarded on
 * `metadata_status = 'enriched_no_match'` — a concurrent writer that already
 * moved the row off that status (another run of this job, or, in principle,
 * a future writer) makes the UPDATE affect 0 rows, which the caller reads as
 * `written: false` and rolls into its `raced` counter, exactly like
 * `rotation-release-id-backfill`'s `discogs_release_id IS NULL` guard.
 *
 * Linked (`album_id != null`): the fill-null COALESCE UPSERT into
 * `album_metadata` is lifted from `jobs/flowsheet-linked-reenrichment`'s
 * `upsertAlbumMatchFillNull` (COALESCE(existing, excluded) per column,
 * explicit `updated_at = NOW()`, `updated_at < NOW()` race guard so a
 * fresher worker/runtime enrichment can't be clobbered), then a
 * status-only flip on `flowsheet` — no inline metadata columns to write,
 * mirroring `apps/enrichment-worker/enrich.ts`'s linked-match arm.
 *
 * Unlinked (`album_id == null`, free-form entries): the same fill-null
 * shape applied directly to flowsheet's own 10 inline metadata columns in
 * one UPDATE, since there is no album_metadata row to UPSERT. Six of those
 * ten (artwork/discogs/year/apple/bio/wikipedia) are plain COALESCE. The
 * other four — spotify/youtube/bandcamp/soundcloud — are NOT plain COALESCE
 * (BS#2179 review HIGH 1): `apps/enrichment-worker/enrich.ts`'s unlinked
 * no-match write pre-populates those four with a synthesized search URL
 * unconditionally, so a plain COALESCE against them is a guaranteed no-op.
 * See `fillOrUpgradeSearchUrl` below.
 *
 * `markRecheckAttempted` stamps `no_match_recheck_attempted_at` alone (no
 * status change) for a no-match / trust-rejected outcome, under the same
 * race guard.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';

import type { Candidate } from './orchestrate.js';

/**
 * BS#2179 review HIGH 1. The exact search-URL prefixes
 * `apps/enrichment-worker/enrich.ts`'s local `synthesizeSearchUrls` writes
 * UNCONDITIONALLY onto every unlinked `enriched_no_match` row — the very
 * write that puts a row in this job's candidate set. Byte-identical to that
 * function, and to `jobs/streaming-url-upgrade/resolve.ts`'s narrower
 * `SERVICE_CONFIGS` (which covers only spotify/bandcamp, confirmed against
 * prod for its own one-shot scope); this arm needs all four columns the
 * unlinked no-match write touches. `@wxyc/metadata`'s shared
 * `synthesizeSearchUrls` is a DIFFERENT function scoped to 3 of these 4
 * columns (deliberately omits spotify — BS#1184/#1192) and is not the one
 * that landed on these rows, so it is not reused here.
 */
const SEARCH_URL_PREFIX = {
  spotify_url: 'https://open.spotify.com/search/',
  youtube_music_url: 'https://music.youtube.com/search?q=',
  bandcamp_url: 'https://bandcamp.com/search?q=',
  soundcloud_url: 'https://soundcloud.com/search?q=',
} as const;

/**
 * Fill-null PLUS upgrade-if-placeholder, for the four streaming-search
 * columns only (BS#2179 review HIGH 1). A plain `COALESCE(column, incoming)`
 * is a guaranteed no-op here: every unlinked candidate this job selects
 * already has these four columns populated with a synthesized search URL
 * (never NULL — see `SEARCH_URL_PREFIX`'s doc comment), so a real
 * Discogs-sourced link could never land. This CASE generalizes COALESCE:
 * it fills a NULL exactly like COALESCE does, AND additionally prefers
 * `incoming` when the STORED value is itself one of the exact synthesized
 * placeholders (detected by prefix) — which a genuinely verified URL never
 * is. A `null` incoming always falls through to the stored value, so a
 * verified link already in the column is never downgraded. Mirrors
 * `jobs/streaming-url-upgrade/resolve.ts`'s `isSearchShaped` never-downgrade
 * guard, generalized to a fill-null write instead of that job's
 * search-shaped-only write.
 */
const fillOrUpgradeSearchUrl = (column: AnyPgColumn, incoming: string | null, prefix: string) =>
  sql`CASE WHEN ${incoming} IS NOT NULL AND (${column} IS NULL OR ${column} LIKE ${prefix + '%'}) THEN ${incoming} ELSE ${column} END`;

export const markRecheckAttempted = async (rowId: number): Promise<{ written: boolean }> => {
  const updated = await db
    .update(flowsheet)
    .set({ no_match_recheck_attempted_at: sql`now()` })
    .where(and(eq(flowsheet.id, rowId), eq(flowsheet.metadata_status, 'enriched_no_match')))
    .returning({ id: flowsheet.id });
  return { written: updated.length === 1 };
};

/**
 * Fill-null UPSERT into `album_metadata`, verbatim shape from
 * `jobs/flowsheet-linked-reenrichment/job.ts`'s `upsertAlbumMatchFillNull`.
 * The 8 BS#1336 extended columns (discogs_artist_id, label, …) are
 * deliberately omitted from both `values` and `set` — this job's lookup
 * never sets `extended: true` (see `lml-fetch.ts`), so writing them here
 * would clobber a worker-enriched row's extended fields with nulls.
 */
const upsertLinkedMatch = async (albumId: number, artwork: DiscogsMatchResult): Promise<void> => {
  const payload = {
    artwork_url: filterSpacerGif(artwork.artwork_url),
    discogs_url: artwork.release_url ?? null,
    // Discogs returns 0 as "year unknown"; coerce to null.
    release_year: artwork.release_year || null,
    spotify_url: artwork.spotify_url ?? null,
    apple_music_url: artwork.apple_music_url ?? null,
    youtube_music_url: artwork.youtube_music_url ?? null,
    bandcamp_url: artwork.bandcamp_url ?? null,
    soundcloud_url: artwork.soundcloud_url ?? null,
    artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
    artist_wikipedia_url: artwork.wikipedia_url ?? null,
  };

  await db
    .insert(album_metadata)
    .values({ album_id: albumId, ...payload, updated_at: sql`NOW()` })
    .onConflictDoUpdate({
      target: album_metadata.album_id,
      set: {
        artwork_url: sql`COALESCE(${album_metadata.artwork_url}, excluded."artwork_url")`,
        discogs_url: sql`COALESCE(${album_metadata.discogs_url}, excluded."discogs_url")`,
        release_year: sql`COALESCE(${album_metadata.release_year}, excluded."release_year")`,
        spotify_url: sql`COALESCE(${album_metadata.spotify_url}, excluded."spotify_url")`,
        apple_music_url: sql`COALESCE(${album_metadata.apple_music_url}, excluded."apple_music_url")`,
        youtube_music_url: sql`COALESCE(${album_metadata.youtube_music_url}, excluded."youtube_music_url")`,
        bandcamp_url: sql`COALESCE(${album_metadata.bandcamp_url}, excluded."bandcamp_url")`,
        soundcloud_url: sql`COALESCE(${album_metadata.soundcloud_url}, excluded."soundcloud_url")`,
        artist_bio: sql`COALESCE(${album_metadata.artist_bio}, excluded."artist_bio")`,
        artist_wikipedia_url: sql`COALESCE(${album_metadata.artist_wikipedia_url}, excluded."artist_wikipedia_url")`,
        // Explicit NOW() — never COALESCE'd. Freezing updated_at would
        // defeat the race guard below.
        updated_at: sql`NOW()`,
      },
      // Race guard: never clobber a fresher worker/runtime enrichment.
      setWhere: sql`${album_metadata.updated_at} < NOW()`,
    });
};

/** Status-only flip for a linked row: the metadata itself lives on
 * `album_metadata`, keyed by `album_id`, shared across every flowsheet row
 * of that album. */
const flipLinkedStatus = async (rowId: number): Promise<{ written: boolean }> => {
  const updated = await db
    .update(flowsheet)
    .set({
      metadata_status: 'enriched_match',
      no_match_recheck_attempted_at: sql`now()`,
    })
    .where(and(eq(flowsheet.id, rowId), eq(flowsheet.metadata_status, 'enriched_no_match')))
    .returning({ id: flowsheet.id });
  return { written: updated.length === 1 };
};

/** Fill-null UPDATE of flowsheet's own 10 inline metadata columns for a
 * free-form (unlinked) row, plus the status flip, in one statement. Six
 * columns are plain COALESCE; the four streaming-search columns use
 * `fillOrUpgradeSearchUrl` instead (BS#2179 review HIGH 1). */
const writeUnlinkedMatch = async (rowId: number, artwork: DiscogsMatchResult): Promise<{ written: boolean }> => {
  const updated = await db
    .update(flowsheet)
    .set({
      artwork_url: sql`COALESCE(${flowsheet.artwork_url}, ${filterSpacerGif(artwork.artwork_url)})`,
      discogs_url: sql`COALESCE(${flowsheet.discogs_url}, ${artwork.release_url ?? null})`,
      release_year: sql`COALESCE(${flowsheet.release_year}, ${artwork.release_year || null})`,
      // BS#2179 review HIGH 1: fill-or-upgrade, not plain COALESCE — see
      // `fillOrUpgradeSearchUrl`'s doc comment above.
      spotify_url: fillOrUpgradeSearchUrl(
        flowsheet.spotify_url,
        artwork.spotify_url ?? null,
        SEARCH_URL_PREFIX.spotify_url
      ),
      apple_music_url: sql`COALESCE(${flowsheet.apple_music_url}, ${artwork.apple_music_url ?? null})`,
      youtube_music_url: fillOrUpgradeSearchUrl(
        flowsheet.youtube_music_url,
        artwork.youtube_music_url ?? null,
        SEARCH_URL_PREFIX.youtube_music_url
      ),
      bandcamp_url: fillOrUpgradeSearchUrl(
        flowsheet.bandcamp_url,
        artwork.bandcamp_url ?? null,
        SEARCH_URL_PREFIX.bandcamp_url
      ),
      soundcloud_url: fillOrUpgradeSearchUrl(
        flowsheet.soundcloud_url,
        artwork.soundcloud_url ?? null,
        SEARCH_URL_PREFIX.soundcloud_url
      ),
      artist_bio: sql`COALESCE(${flowsheet.artist_bio}, ${artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null})`,
      artist_wikipedia_url: sql`COALESCE(${flowsheet.artist_wikipedia_url}, ${artwork.wikipedia_url ?? null})`,
      metadata_status: 'enriched_match',
      no_match_recheck_attempted_at: sql`now()`,
    })
    .where(and(eq(flowsheet.id, rowId), eq(flowsheet.metadata_status, 'enriched_no_match')))
    .returning({ id: flowsheet.id });
  return { written: updated.length === 1 };
};

export const writeMatch = async (candidate: Candidate, artwork: DiscogsMatchResult): Promise<{ written: boolean }> => {
  if (candidate.album_id !== null) {
    await upsertLinkedMatch(candidate.album_id, artwork);
    return flipLinkedStatus(candidate.id);
  }
  return writeUnlinkedMatch(candidate.id, artwork);
};
