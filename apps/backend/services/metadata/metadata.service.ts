/**
 * Metadata Service - Fetches metadata from LML (library-metadata-lookup).
 *
 * Called fire-and-forget on every flowsheet insert. The caller persists the
 * returned metadata directly on the flowsheet row. Uses LML's /lookup endpoint
 * which provides artist correction, title normalization, fallback strategies,
 * artwork, streaming URLs, and artist metadata in a single call.
 *
 * The pure response → metadata helpers live in `@wxyc/metadata` (deep module
 * shared with `apps/enrichment-worker` and the four enrichment jobs). This
 * file imports them and adds two backend-specific concerns:
 *   1. The fetch (`fetchMetadata`) — LML I/O + the camelCase response shape
 *      the proxy controller and enrichment service consume.
 *   2. Re-exports of `filterSpacerGif` and `isSyntheticArtwork` — backend
 *      callsites in `library.controller`, `proxy.controller`, `library.service`,
 *      and the artwork providers still import these from here. The re-exports
 *      keep those callsites stable; the underlying implementation now lives
 *      in `@wxyc/metadata`.
 */
import { MetadataRequest, AlbumMetadataResult, ArtistMetadataResult, FlowsheetMetadata } from './metadata.types.js';
import { lookupMetadata, envInt } from '@wxyc/lml-client';
import type { DiscogsMatchResult } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif, isSyntheticArtwork } from '@wxyc/metadata';
import { SearchUrlProvider } from './providers/search-urls.provider.js';

export { filterSpacerGif, isSyntheticArtwork } from '@wxyc/metadata';

const searchUrls = new SearchUrlProvider();

/**
 * Budget for the metadata-service fire-and-forget LML lookup on flowsheet
 * insert. 5 s matches the other runtime callers — short enough that LML
 * cuts off well before the BS-side 30 s `AbortController` ceiling. See
 * `LookupOptions.budgetMs` for mechanics.
 */
const METADATA_SERVICE_LML_BUDGET_MS = envInt('METADATA_SERVICE_LML_BUDGET_MS', 5000);

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

  const lookupResponse = await lookupMetadata(artistName, albumTitle, trackTitle, {
    caller: 'metadata-service',
    budgetMs: METADATA_SERVICE_LML_BUDGET_MS,
  });
  const artwork: DiscogsMatchResult | null = lookupResponse.results?.[0]?.artwork ?? null;

  if (artwork) {
    result.album = extractAlbumMetadata(artwork);
    result.artist = extractArtistMetadata(artwork) ?? undefined;
  }

  // Fill missing search URLs (always available, no API calls). Four of the
  // five streaming services have search-URL fallbacks here: Spotify, YT,
  // Bandcamp, SoundCloud. Apple Music is intentionally absent (BS#1192).
  //
  // LML's `_fetch_apple_music_url` enforces a verified iTunes match (80/80
  // fuzzy floor + album-collection check). A null return is load-bearing
  // signal — "we couldn't verify this release exists on Apple Music" —
  // and persisting a keyword-search URL on the write path launders that
  // signal into a clickable button that drops users on the in-app search
  // page. Worse, `album_metadata` is keyed by `album_id` but the search
  // query uses the enrichment-triggering `trackTitle`, so every linked
  // flowsheet row for that album reads back the same track-scoped URL —
  // wrong scope independent of the LML-signal issue.
  //
  // The read path (`proxy.controller.getAlbumMetadata`) still fills Apple
  // at request time for the iOS Tragic Magic surface, where there's no
  // persisted row to poison.
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
 * Extract album metadata from a DiscogsMatchResult into the camelCase shape
 * the backend `AlbumMetadataResult` consumers expect. The underlying field-
 * by-field derivation is the same as `@wxyc/metadata`'s `normalizeLookup`;
 * this wrapper coerces nulls to undefined to match the legacy optional shape.
 */
function extractAlbumMetadata(artwork: DiscogsMatchResult): AlbumMetadataResult {
  const synthetic = isSyntheticArtwork(artwork);
  return {
    discogsReleaseId: synthetic ? undefined : artwork.release_id,
    discogsUrl: synthetic ? undefined : artwork.release_url,
    artworkUrl: filterSpacerGif(artwork.artwork_url) ?? undefined,
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
