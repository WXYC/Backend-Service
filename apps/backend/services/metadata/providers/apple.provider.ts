/**
 * Apple Music / iTunes Search API provider
 */
import { ITunesSearchResponse } from '../metadata.types.js';

const ITUNES_API_BASE = 'https://itunes.apple.com';

export class AppleMusicProvider {
  /**
   * Search for an album and return its Apple Music URL
   */
  async searchAlbum(artistName: string, albumTitle: string): Promise<string | null> {
    try {
      const query = encodeURIComponent(`${artistName} ${albumTitle}`);
      const response = await fetch(
        `${ITUNES_API_BASE}/search?term=${query}&entity=album&limit=1`
      );

      if (!response.ok) {
        console.error(`[AppleMusicProvider] Album search failed: ${response.status}`);
        return null;
      }

      const data: ITunesSearchResponse = await response.json();

      if (data.resultCount === 0 || !data.results[0]) {
        return null;
      }

      return data.results[0].collectionViewUrl || null;
    } catch (error) {
      console.error('[AppleMusicProvider] Album search error:', error);
      return null;
    }
  }

  /**
   * Search for a track and return its Apple Music URL
   */
  async searchTrack(artistName: string, trackTitle: string): Promise<string | null> {
    try {
      const query = encodeURIComponent(`${artistName} ${trackTitle}`);
      const response = await fetch(
        `${ITUNES_API_BASE}/search?term=${query}&entity=song&limit=1`
      );

      if (!response.ok) {
        console.error(`[AppleMusicProvider] Track search failed: ${response.status}`);
        return null;
      }

      const data: ITunesSearchResponse = await response.json();

      if (data.resultCount === 0 || !data.results[0]) {
        return null;
      }

      // Prefer collection (album) URL, fallback to track URL
      return data.results[0].collectionViewUrl || data.results[0].trackViewUrl || null;
    } catch (error) {
      console.error('[AppleMusicProvider] Track search error:', error);
      return null;
    }
  }

  /**
   * Get Apple Music URL for an album (preferred) or track
   */
  async getAppleMusicUrl(
    artistName: string,
    albumTitle?: string,
    trackTitle?: string
  ): Promise<string | null> {
    // Try album search first if we have an album title
    if (albumTitle) {
      const albumUrl = await this.searchAlbum(artistName, albumTitle);
      if (albumUrl) return albumUrl;
    }

    // Fallback to track search
    if (trackTitle) {
      return this.searchTrack(artistName, trackTitle);
    }

    return null;
  }
}
