/**
 * Discogs artwork provider.
 *
 * The search method routes through LML (library-metadata-lookup) for artwork
 * discovery. Track-search methods still delegate to DiscogsService directly
 * until LML gets track-search endpoints (Phase 4).
 */

import { ArtworkProvider } from './base.js';
import { ArtworkRequest, ArtworkSearchResult } from '../../requestLine/types.js';
import { DiscogsService, isDiscogsAvailable } from '../../discogs/index.js';
import { searchDiscogs } from '../../lml/lml.client.js';
import { calculateConfidence } from '../../requestLine/matching/index.js';

/**
 * Check whether the LML service is configured.
 */
function isLmlConfigured(): boolean {
  return !!process.env.LIBRARY_METADATA_URL;
}

/**
 * Artwork provider using LML for search, DiscogsService for track operations.
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

    let lmlResults;
    try {
      lmlResults = await searchDiscogs(request.artist || '', request.album || request.song || undefined);
    } catch (error) {
      console.warn('[DiscogsProvider] LML search failed:', error);
      return [];
    }

    const results: ArtworkSearchResult[] = [];
    for (const item of lmlResults.results) {
      if (!item.artwork_url || item.artwork_url.includes('spacer.gif')) {
        continue;
      }

      const confidence = calculateConfidence(request.artist, request.album, item.artist || '', item.album || '');

      results.push({
        artworkUrl: item.artwork_url,
        releaseUrl: item.release_url,
        album: item.album || '',
        artist: item.artist || '',
        source: this.name,
        confidence,
      });
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  /**
   * Search Discogs for a track and return the album name.
   */
  async searchTrack(track: string, artist?: string): Promise<string | null> {
    if (!isDiscogsAvailable()) {
      return null;
    }

    const result = await DiscogsService.searchTrack(track, artist);
    return result.album;
  }

  /**
   * Search Discogs for ALL releases containing a track.
   *
   * For Various Artists / compilation releases, validates the tracklist
   * to ensure the track by the artist actually exists on the release.
   *
   * @returns List of [artist, album] tuples for releases containing the track.
   */
  async searchReleasesByTrack(track: string, artist?: string, limit = 20): Promise<Array<[string, string]>> {
    if (!isDiscogsAvailable()) {
      return [];
    }

    const response = await DiscogsService.searchReleasesByTrack(track, artist, limit);

    // If searching with artist, validate compilation releases
    const releases: Array<[string, string]> = [];
    for (const releaseInfo of response.releases) {
      // For Various Artists / compilations, validate the tracklist
      if (artist && releaseInfo.isCompilation) {
        const isValid = await DiscogsService.validateTrackOnRelease(releaseInfo.releaseId, track, artist);
        if (!isValid) {
          console.log(`[DiscogsProvider] Skipping '${releaseInfo.album}' - track/artist not validated on release`);
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
    if (!isDiscogsAvailable()) {
      return false;
    }

    return DiscogsService.validateTrackOnRelease(releaseId, track, artist);
  }
}

// Singleton instance
export const discogsProvider = new DiscogsProvider();
