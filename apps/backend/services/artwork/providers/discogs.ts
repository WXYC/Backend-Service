/**
 * Discogs artwork provider.
 *
 * All Discogs operations route through LML (library-metadata-lookup).
 */

import { ArtworkProvider } from './base.js';
import { ArtworkRequest, ArtworkSearchResult } from '../../requestLine/types.js';
import { lookupMetadata, searchTrackReleases, validateTrackOnRelease, isLmlConfigured } from '../../lml/lml.client.js';

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

    let lookupResponse;
    try {
      lookupResponse = await lookupMetadata(request.artist || '', request.album, request.song);
    } catch (error) {
      console.warn('[DiscogsProvider] LML lookup failed:', error);
      return [];
    }

    const results: ArtworkSearchResult[] = [];
    for (const item of lookupResponse.results ?? []) {
      const artwork = item.artwork;
      if (!artwork?.artwork_url || artwork.artwork_url.includes('spacer.gif')) {
        continue;
      }

      results.push({
        artworkUrl: artwork.artwork_url,
        releaseUrl: artwork.release_url,
        album: artwork.album || '',
        artist: artwork.artist || '',
        source: this.name,
        confidence: artwork.confidence ?? 0,
      });
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
