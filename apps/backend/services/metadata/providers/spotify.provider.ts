/**
 * Spotify API provider for fetching track/album URLs
 * Uses OAuth2 client credentials flow
 */
import { SpotifyTokenResponse, SpotifySearchResponse } from '../metadata.types.js';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

export class SpotifyProvider {
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    this.clientId = process.env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';

    if (!this.clientId || !this.clientSecret) {
      console.warn('[SpotifyProvider] API credentials not configured');
    }
  }

  /**
   * Authenticate using client credentials flow
   */
  private async authenticate(): Promise<void> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Spotify credentials not configured');
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await fetch(SPOTIFY_AUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`Spotify auth failed: ${response.status}`);
    }

    const data: SpotifyTokenResponse = await response.json();
    this.accessToken = data.access_token;
    // Set expiry with 60 second buffer
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  }

  /**
   * Ensure we have a valid access token
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      await this.authenticate();
    }
  }

  /**
   * Search for a track and return its Spotify URL
   */
  async searchTrack(artistName: string, trackTitle: string): Promise<string | null> {
    if (!this.clientId) return null;

    try {
      await this.ensureAuthenticated();

      const query = encodeURIComponent(`track:${trackTitle} artist:${artistName}`);
      const response = await fetch(`${SPOTIFY_API_BASE}/search?q=${query}&type=track&limit=1`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!response.ok) {
        console.error(`[SpotifyProvider] Search failed: ${response.status}`);
        return null;
      }

      const data: SpotifySearchResponse = await response.json();

      if (data.tracks.items.length === 0) {
        return null;
      }

      return data.tracks.items[0].external_urls.spotify;
    } catch (error) {
      console.error('[SpotifyProvider] Search error:', error);
      return null;
    }
  }

  /**
   * Search for an album and return its Spotify URL
   */
  async searchAlbum(artistName: string, albumTitle: string): Promise<string | null> {
    if (!this.clientId) return null;

    try {
      await this.ensureAuthenticated();

      const query = encodeURIComponent(`album:${albumTitle} artist:${artistName}`);
      const response = await fetch(`${SPOTIFY_API_BASE}/search?q=${query}&type=album&limit=1`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!response.ok) {
        console.error(`[SpotifyProvider] Album search failed: ${response.status}`);
        return null;
      }

      const data = await response.json();

      if (!data.albums?.items?.length) {
        // Fallback: try track search and get album URL from track
        return this.searchTrackForAlbum(artistName, albumTitle);
      }

      return data.albums.items[0].external_urls?.spotify || null;
    } catch (error) {
      console.error('[SpotifyProvider] Album search error:', error);
      return null;
    }
  }

  /**
   * Search for a track and return its album's Spotify URL
   */
  private async searchTrackForAlbum(artistName: string, albumTitle: string): Promise<string | null> {
    try {
      await this.ensureAuthenticated();

      // Search using album name as part of query
      const query = encodeURIComponent(`${albumTitle} artist:${artistName}`);
      const response = await fetch(`${SPOTIFY_API_BASE}/search?q=${query}&type=track&limit=1`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      const data: SpotifySearchResponse = await response.json();

      if (data.tracks.items.length === 0) {
        return null;
      }

      return data.tracks.items[0].album.external_urls.spotify;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get Spotify URL for an album (preferred) or track
   */
  async getSpotifyUrl(artistName: string, albumTitle?: string, trackTitle?: string): Promise<string | null> {
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
