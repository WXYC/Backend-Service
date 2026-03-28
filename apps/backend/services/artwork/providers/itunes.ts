/**
 * iTunes Search API artwork provider.
 *
 * Uses the public iTunes Search API (no authentication required) to find
 * album artwork. Falls back to song search if album search returns no results.
 */

import { ArtworkProvider } from './base.js';
import { ArtworkRequest, ArtworkSearchResult } from '../../requestLine/types.js';

const ITUNES_SEARCH_BASE = 'https://itunes.apple.com/search';

interface ITunesResult {
  artistName: string;
  collectionName?: string;
  trackName?: string;
  artworkUrl100?: string;
  collectionViewUrl?: string;
}

interface ITunesResponse {
  resultCount: number;
  results: ITunesResult[];
}

/**
 * Scales an iTunes artwork URL to a larger size.
 * iTunes URLs end with /100x100bb.jpg — replace dimensions for higher res.
 */
function scaleArtworkUrl(url: string, size: number): string {
  return url.replace(/\/\d+x\d+bb/, `/${size}x${size}bb`);
}

/**
 * Artwork provider using the iTunes Search API.
 */
export class ITunesProvider implements ArtworkProvider {
  readonly name = 'itunes';

  async search(request: ArtworkRequest): Promise<ArtworkSearchResult[]> {
    if (!request.artist) return [];

    // Try album search first, then fall back to song search
    const album = request.album || request.song;
    if (album) {
      const results = await this.searchAlbum(request.artist, album);
      if (results.length > 0) return results;
    }

    if (request.song) {
      return this.searchSong(request.artist, request.song);
    }

    return [];
  }

  private async searchAlbum(artist: string, album: string): Promise<ArtworkSearchResult[]> {
    try {
      const params = new URLSearchParams({
        term: `${artist} ${album}`,
        media: 'music',
        entity: 'album',
        limit: '5',
      });

      const response = await fetch(`${ITUNES_SEARCH_BASE}?${params}`);
      if (!response.ok) return [];

      const data = (await response.json()) as ITunesResponse;

      return data.results
        .filter((r) => r.artworkUrl100)
        .map((r) => ({
          artworkUrl: scaleArtworkUrl(r.artworkUrl100!, 600),
          releaseUrl: r.collectionViewUrl || '',
          album: r.collectionName || album,
          artist: r.artistName,
          source: this.name,
          confidence: 0.5, // Lower than Discogs and Last.fm
        }));
    } catch (error) {
      console.error('[ITunesProvider] Album search error:', error);
      return [];
    }
  }

  private async searchSong(artist: string, song: string): Promise<ArtworkSearchResult[]> {
    try {
      const params = new URLSearchParams({
        term: `${artist} ${song}`,
        media: 'music',
        entity: 'song',
        limit: '5',
      });

      const response = await fetch(`${ITUNES_SEARCH_BASE}?${params}`);
      if (!response.ok) return [];

      const data = (await response.json()) as ITunesResponse;

      return data.results
        .filter((r) => r.artworkUrl100)
        .map((r) => ({
          artworkUrl: scaleArtworkUrl(r.artworkUrl100!, 600),
          releaseUrl: r.collectionViewUrl || '',
          album: r.collectionName || '',
          artist: r.artistName,
          source: this.name,
          confidence: 0.4,
        }));
    } catch (error) {
      console.error('[ITunesProvider] Song search error:', error);
      return [];
    }
  }
}

export const itunesProvider = new ITunesProvider();
