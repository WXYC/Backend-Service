/**
 * Discogs artwork provider.
 *
 * Delegates to DiscogsService for API calls to avoid code duplication.
 * Ported from request-parser artwork/providers/discogs.py
 */

import { ArtworkProvider } from './base.js';
import { ArtworkRequest, ArtworkSearchResult } from '../../requestLine/types.js';
import { DiscogsService, isDiscogsAvailable } from '../../discogs/index.js';
import { calculateConfidence } from '../../requestLine/matching/index.js';

/**
 * Artwork provider using the Discogs API.
 */
export class DiscogsProvider implements ArtworkProvider {
  readonly name = 'discogs';

  /**
   * Search Discogs for album artwork.
   */
  async search(request: ArtworkRequest): Promise<ArtworkSearchResult[]> {
    if (!isDiscogsAvailable()) {
      console.warn('[DiscogsProvider] Discogs token not configured');
      return [];
    }

    // Check if there's anything to search for
    if (!request.artist && !request.album && !request.song) {
      console.warn('[DiscogsProvider] No searchable fields in request');
      return [];
    }

    // Delegate to service
    const response = await DiscogsService.search({
      artist: request.artist,
      album: request.album,
      track: request.song,
    });

    // Convert results to ArtworkSearchResult format
    const results: ArtworkSearchResult[] = [];
    for (const item of response.results) {
      // Skip results without artwork
      if (!item.artworkUrl || item.artworkUrl.includes('spacer.gif')) {
        continue;
      }

      // Calculate confidence score for this result
      const confidence = calculateConfidence(request.artist, request.album, item.artist || '', item.album || '');

      results.push({
        artworkUrl: item.artworkUrl,
        releaseUrl: item.releaseUrl,
        album: item.album || '',
        artist: item.artist || '',
        source: this.name,
        confidence,
      });
    }

    // Sort by confidence
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
