/**
 * Last.fm artwork provider.
 *
 * Uses the Last.fm album.getinfo API to fetch album artwork.
 * Requires LASTFM_API_KEY environment variable.
 */

import { ArtworkProvider } from './base.js';
import { ArtworkRequest, ArtworkSearchResult } from '../../requestLine/types.js';

const LASTFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';

interface LastFmImage {
  '#text': string;
  size: string;
}

interface LastFmAlbum {
  name: string;
  artist: string;
  image: LastFmImage[];
  url: string;
}

interface LastFmAlbumInfoResponse {
  album?: LastFmAlbum;
}

/**
 * Checks if Last.fm API is configured.
 */
export function isLastFmAvailable(): boolean {
  return !!process.env.LASTFM_API_KEY;
}

/**
 * Artwork provider using the Last.fm API.
 */
export class LastFmProvider implements ArtworkProvider {
  readonly name = 'lastfm';

  async search(request: ArtworkRequest): Promise<ArtworkSearchResult[]> {
    if (!isLastFmAvailable()) {
      return [];
    }

    if (!request.artist) return [];

    const album = request.album || request.song;
    if (!album) return [];

    try {
      const params = new URLSearchParams({
        method: 'album.getinfo',
        api_key: process.env.LASTFM_API_KEY!,
        artist: request.artist,
        album: album,
        format: 'json',
      });

      const response = await fetch(`${LASTFM_API_BASE}?${params}`);
      if (!response.ok) return [];

      const data = (await response.json()) as LastFmAlbumInfoResponse;
      if (!data.album?.image) return [];

      // Find the largest image (extralarge > large > medium > small)
      const sizeOrder = ['extralarge', 'large', 'medium', 'small'];
      let artworkUrl: string | null = null;
      for (const size of sizeOrder) {
        const img = data.album.image.find((i) => i.size === size);
        if (img?.['#text']) {
          artworkUrl = img['#text'];
          break;
        }
      }

      if (!artworkUrl) return [];

      return [
        {
          artworkUrl,
          releaseUrl: data.album.url || '',
          album: data.album.name,
          artist: data.album.artist,
          source: this.name,
          confidence: 0.7, // Lower than Discogs since match is less precise
        },
      ];
    } catch (error) {
      console.error('[LastFmProvider] Error fetching artwork:', error);
      return [];
    }
  }
}

export const lastFmProvider = new LastFmProvider();
