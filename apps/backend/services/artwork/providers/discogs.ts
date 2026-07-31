/**
 * Discogs artwork provider.
 *
 * All Discogs operations route through LML (library-metadata-lookup).
 */

import { ArtworkProvider } from './base.js';
import { ArtworkRequest, ArtworkSearchResult } from '../../requestLine/types.js';
import { searchTrackReleases, validateTrackOnRelease, isLmlConfigured } from '@wxyc/lml-client';
import { lmlLookupCoordinator } from '../../lml/index.js';
import { filterSpacerGif } from '../../metadata/metadata.service.js';

/**
 * Artwork provider backed by LML's Discogs endpoints.
 */
export class DiscogsProvider implements ArtworkProvider {
  readonly name = 'discogs';

  /**
   * Search for album artwork via LML.
   */
  async search(request: ArtworkRequest): Promise<ArtworkSearchResult[]> {
    if (!isLmlConfigured()) {
      console.warn('[DiscogsProvider] LIBRARY_METADATA_URL not configured');
      return [];
    }

    if (!request.artist && !request.album && !request.song) {
      console.warn('[DiscogsProvider] No searchable fields in request');
      return [];
    }

    // BS#1089: let a lookup failure propagate instead of swallowing it to
    // `[]`. `lmlLookupCoordinator.lookup` never caches errors and rethrows
    // whatever `lookupMetadata` threw — in practice always an
    // `LmlClientError` (timeout/5xx/network blip; see `@wxyc/lml-client`'s
    // `lmlFetch`). Swallowing it here made a transient LML outage
    // indistinguishable from "LML answered and found nothing," which is
    // exactly what let a brief LML degradation get cached as "confirmed no
    // artwork" for 24h. `ArtworkFinder.find` is the caller that now tells
    // the two apart (a thrown error vs. an empty array) and tags its
    // response accordingly.
    const lookupResponse = await lmlLookupCoordinator.lookup(request.artist || '', request.album, request.song, {
      caller: 'artwork-discogs-fallback',
    });

    const results: ArtworkSearchResult[] = [];
    for (const item of lookupResponse.results ?? []) {
      const artwork = item.artwork;
      if (!artwork) continue;
      const artworkUrl = filterSpacerGif(artwork.artwork_url);
      if (!artworkUrl) continue;

      results.push({
        artworkUrl,
        releaseUrl: artwork.release_url,
        album: artwork.album || '',
        artist: artwork.artist || '',
        source: this.name,
        confidence: artwork.confidence ?? 0,
      });
    }

    // BS#1890: BS#1089 only closed LML's *throw* path. LML has a second
    // transient mode that returns HTTP 200: `timeout: true` (server-side hard
    // cap fired mid-pipeline, LML#370) or `degraded: true` (deliberately shed
    // the enrichment tail — and `fetch_artwork` is one of those shed steps —
    // under a caller deadline / admission pressure / unavailable upstream,
    // LML#930). Either is "couldn't answer," not a confirmed absence. When such
    // a response yields no usable artwork, throw so the finder folds it into
    // BS#1089's `errored` tagging and the proxy skips the 24h negative cache —
    // same posture as a timeout/5xx. A degraded response that still carried
    // artwork (warm-cache hit) is a real result and falls through untouched.
    if (results.length === 0 && (lookupResponse.timeout === true || lookupResponse.degraded === true)) {
      const mode = lookupResponse.timeout === true ? 'timeout' : 'degraded';
      throw new Error(`[DiscogsProvider] LML returned a soft-degraded ${mode} 200 with no usable artwork`);
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  /**
   * Search for a track and return the album name.
   */
  async searchTrack(track: string, artist?: string): Promise<string | null> {
    if (!isLmlConfigured()) {
      return null;
    }

    try {
      const response = await searchTrackReleases(track, artist);
      if (response.releases.length > 0) {
        return response.releases[0].album;
      }
      return null;
    } catch (error) {
      console.warn('[DiscogsProvider] LML track search failed:', error);
      return null;
    }
  }

  /**
   * Search for ALL releases containing a track.
   *
   * For Various Artists / compilation releases, validates the tracklist
   * to ensure the track by the artist actually exists on the release.
   *
   * @returns List of [artist, album] tuples for releases containing the track.
   */
  async searchReleasesByTrack(track: string, artist?: string, limit = 20): Promise<Array<[string, string]>> {
    if (!isLmlConfigured()) {
      return [];
    }

    let response;
    try {
      response = await searchTrackReleases(track, artist, limit);
    } catch (error) {
      console.warn('[DiscogsProvider] LML track-releases search failed:', error);
      return [];
    }

    const releases: Array<[string, string]> = [];
    for (const releaseInfo of response.releases) {
      // For Various Artists / compilations, validate the tracklist
      if (artist && releaseInfo.is_compilation) {
        try {
          const isValid = await validateTrackOnRelease(releaseInfo.release_id, track, artist);
          if (!isValid) {
            console.log(`[DiscogsProvider] Skipping '${releaseInfo.album}' - track/artist not validated on release`);
            continue;
          }
        } catch (error) {
          console.warn(`[DiscogsProvider] Validation failed for release ${releaseInfo.release_id}:`, error);
          continue;
        }
      }

      releases.push([releaseInfo.artist, releaseInfo.album]);
    }

    return releases;
  }

  /**
   * Validate that a track by an artist exists on a release.
   */
  async validateTrackOnRelease(releaseId: number, track: string, artist: string): Promise<boolean> {
    if (!isLmlConfigured()) {
      return false;
    }

    try {
      return await validateTrackOnRelease(releaseId, track, artist);
    } catch (error) {
      console.warn(`[DiscogsProvider] Validation failed for release ${releaseId}:`, error);
      return false;
    }
  }
}

// Singleton instance
export const discogsProvider = new DiscogsProvider();
