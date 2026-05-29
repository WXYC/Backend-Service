/**
 * Metadata Service - Fetches metadata from LML (library-metadata-lookup).
 *
 * Called fire-and-forget on every flowsheet insert. The caller persists the
 * returned metadata directly on the flowsheet row. Uses LML's /lookup endpoint
 * which provides artist correction, title normalization, fallback strategies,
 * artwork, streaming URLs, and artist metadata in a single call.
 */
import { MetadataRequest, AlbumMetadataResult, ArtistMetadataResult, FlowsheetMetadata } from './metadata.types.js';
import { lookupMetadata } from '@wxyc/lml-client';
import type { DiscogsMatchResult } from '@wxyc/lml-client';
import { SearchUrlProvider } from './providers/search-urls.provider.js';

const searchUrls = new SearchUrlProvider();

/**
 * Strip Discogs markup tags from bio text.
 *
 * Discogs profiles use custom markup like [a=Artist], [l=Label],
 * [url=...]...[/url]. This converts them to plain text.
 */
function cleanDiscogsBio(bio: string): string {
  return bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');
}

/**
 * Check whether the LML service is configured.
 */
function isLmlConfigured(): boolean {
  return !!process.env.LIBRARY_METADATA_URL;
}

/**
 * Fetch metadata for a single flowsheet entry from LML.
 *
 * Returns album and artist metadata, or `null` if LML is not configured.
 * On LML success-with-match, returns full metadata. On LML success-no-match,
 * returns metadata with synthesized search URLs only. On LML failure, the
 * underlying error is re-thrown — the caller is responsible for routing it
 * (`enrichment.service.ts` Sentry-reports under `subsystem='metadata'`;
 * #638's historical-drain job logs and skips). Swallowing the throw here
 * would defeat the `flowsheet.metadata_attempt_at` stamp in
 * `enrichment.service.ts`, which exists precisely to distinguish
 * "tried-and-no-match" from "tried-and-LML-failed". See #639.
 */
export async function fetchMetadata(request: MetadataRequest): Promise<FlowsheetMetadata | null> {
  if (!isLmlConfigured()) {
    console.warn('[MetadataService] LIBRARY_METADATA_URL not configured, skipping metadata fetch');
    return null;
  }

  const { artistName, albumTitle, trackTitle } = request;
  const result: FlowsheetMetadata = {};

  const lookupResponse = await lookupMetadata(artistName, albumTitle, trackTitle);
  const artwork: DiscogsMatchResult | null = lookupResponse.results?.[0]?.artwork ?? null;

  if (artwork) {
    result.album = extractAlbumMetadata(artwork);
    result.artist = extractArtistMetadata(artwork) ?? undefined;
  }

  // Fill missing search URLs (always available, no API calls). Four
  // streaming services have write-path search-URL fallbacks: Spotify,
  // YouTube Music, Bandcamp, SoundCloud. Apple Music is intentionally
  // omitted from the WRITE path (BS#1192) — LML's `apple_music_url=null`
  // is load-bearing signal that iTunes Search was either queried-and-empty
  // or queried-and-rejected by LML#390/#398's artist/album/track-floor
  // verification. Persisting a fabricated `music.apple.com/search?term=`
  // URL onto `flowsheet`/`album_metadata` reverses LML's `42a6c5d`
  // "missing-link strictly better than wrong-link" contract. The READ
  // path in `proxy.controller.ts` still mints the Apple search URL at
  // iOS runtime — that's where the BS#1184 Tragic Magic case lands
  // (no V2 metadata → proxy.getAlbumMetadata fallback).
  const urls = searchUrls.getAllSearchUrls(artistName, albumTitle, trackTitle);
  if (!result.album) {
    result.album = {
      spotifyUrl: urls.spotifyUrl,
      youtubeMusicUrl: urls.youtubeMusicUrl,
      bandcampUrl: urls.bandcampUrl,
      soundcloudUrl: urls.soundcloudUrl,
    };
  } else {
    if (!result.album.spotifyUrl) result.album.spotifyUrl = urls.spotifyUrl;
    if (!result.album.youtubeMusicUrl) result.album.youtubeMusicUrl = urls.youtubeMusicUrl;
    if (!result.album.bandcampUrl) result.album.bandcampUrl = urls.bandcampUrl;
    if (!result.album.soundcloudUrl) result.album.soundcloudUrl = urls.soundcloudUrl;
  }

  return result;
}

/**
 * Drop Discogs `spacer.gif` placeholder URLs.
 *
 * Discogs returns `spacer.gif` when a release has no real cover artwork.
 * Persisting that to `flowsheet.artwork_url` would trip the playlist-proxy
 * partial index ("has artwork") and result in a broken/blank image on iOS.
 * Filtering at this single chokepoint covers every caller of `fetchMetadata`
 * (runtime enrichment, iOS playcut detail, and the historical-drain job)
 * so callers don't have to remember. See #649.
 *
 * Exported as the canonical implementation of the filter (BS#890). All
 * `apps/backend/**` consumers import this; the inline copy in
 * `jobs/flowsheet-metadata-backfill/enrich.ts` is preserved for build-
 * graph isolation but pinned to this canonical via parity test +
 * `scripts/check-spacer-gif-callsites.sh` allowlist.
 */
export function filterSpacerGif(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return url.includes('spacer.gif') ? undefined : url;
}

/**
 * Detect LML's streaming-only synthesized result shape (LML#401).
 *
 * On a Discogs miss, LML's `enrich_artwork_results` synthesizes a
 * `DiscogsSearchResult(release_id=0, release_url="")` carrying only
 * streaming URLs — no real album-derived fields. BS keys off this
 * sentinel pair to skip persisting `release_id=0` / `discogs_url=""`
 * on the flowsheet (would otherwise pollute filtered queries like
 * `WHERE discogs_release_id IS NOT NULL`). Streaming URLs still flow.
 *
 * Exported as the canonical implementation so `proxy.controller.ts`
 * shares one check site — mirrors the cross-file pattern established
 * by `filterSpacerGif` above.
 */
export function isSyntheticArtwork(artwork: DiscogsMatchResult): boolean {
  return artwork.release_id === 0 && artwork.release_url === '';
}

/**
 * Extract album metadata from a DiscogsMatchResult.
 */
function extractAlbumMetadata(artwork: DiscogsMatchResult): AlbumMetadataResult {
  const synthetic = isSyntheticArtwork(artwork);
  return {
    discogsReleaseId: synthetic ? undefined : artwork.release_id,
    discogsUrl: synthetic ? undefined : artwork.release_url,
    artworkUrl: filterSpacerGif(artwork.artwork_url),
    // Discogs returns 0 as "year unknown"; coerce to undefined so it doesn't
    // leak to iOS as a literal "0" or persist as 0 in flowsheet.release_year.
    // #1002.
    releaseYear: artwork.release_year || undefined,
    spotifyUrl: artwork.spotify_url ?? undefined,
    appleMusicUrl: artwork.apple_music_url ?? undefined,
    youtubeMusicUrl: artwork.youtube_music_url ?? undefined,
    bandcampUrl: artwork.bandcamp_url ?? undefined,
    soundcloudUrl: artwork.soundcloud_url ?? undefined,
  };
}

/**
 * Extract artist metadata from a DiscogsMatchResult.
 */
function extractArtistMetadata(artwork: DiscogsMatchResult): ArtistMetadataResult | null {
  const bio = artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : undefined;
  const wikipediaUrl = artwork.wikipedia_url ?? undefined;
  if (bio || wikipediaUrl) {
    return { bio, wikipediaUrl };
  }
  return null;
}
