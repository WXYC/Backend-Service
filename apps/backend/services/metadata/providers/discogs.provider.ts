/**
 * Discogs API provider for fetching album and artist metadata
 */
import {
  DiscogsSearchResponse,
  DiscogsSearchResult,
  DiscogsRelease,
  DiscogsMaster,
  DiscogsArtist,
  AlbumMetadataResult,
  ArtistMetadataResult,
} from '../metadata.types.js';

const DISCOGS_API_BASE = 'https://api.discogs.com';
const DISCOGS_WEB_BASE = 'https://www.discogs.com';

// Rate limiting: Discogs allows 60 requests/minute for authenticated requests
const RATE_LIMIT_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Simple token bucket rate limiter
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = requestsPerMinute / (60 * 1000);
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens < 1) {
      // Wait until we have a token
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.refill();
    }

    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export class DiscogsProvider {
  private apiKey: string;
  private apiSecret: string;
  private userAgent: string;
  private rateLimiter: RateLimiter;

  constructor() {
    this.apiKey = process.env.DISCOGS_API_KEY || '';
    this.apiSecret = process.env.DISCOGS_API_SECRET || '';
    this.userAgent = 'WXYCBackend/1.0 +https://wxyc.org';
    this.rateLimiter = new RateLimiter(RATE_LIMIT_REQUESTS);

    if (!this.apiKey || !this.apiSecret) {
      console.warn('[DiscogsProvider] API credentials not configured');
    }
  }

  /**
   * Search for a release by artist and album title
   */
  async searchRelease(
    artistName: string,
    albumTitle: string
  ): Promise<DiscogsSearchResult | null> {
    if (!this.apiKey) return null;

    // Handle self-titled albums
    const searchQuery =
      albumTitle.toLowerCase() === 's/t' || albumTitle.toLowerCase() === 'self-titled'
        ? artistName
        : `${artistName} ${albumTitle}`;

    const params = new URLSearchParams({
      q: searchQuery,
      type: 'release,master',
      key: this.apiKey,
      secret: this.apiSecret,
    });

    try {
      const response = await this.throttledFetch(
        `${DISCOGS_API_BASE}/database/search?${params}`
      );

      if (!response.ok) {
        console.error(`[DiscogsProvider] Search failed: ${response.status}`);
        return null;
      }

      const data: DiscogsSearchResponse = await response.json();

      if (data.results.length === 0) {
        return null;
      }

      // Prefer master releases over individual releases
      const master = data.results.find((r) => r.type === 'master');
      return master || data.results[0];
    } catch (error) {
      console.error('[DiscogsProvider] Search error:', error);
      return null;
    }
  }

  /**
   * Get release details by ID
   */
  async getReleaseDetails(releaseId: number): Promise<DiscogsRelease | null> {
    if (!this.apiKey) return null;

    try {
      const response = await this.throttledFetch(
        `${DISCOGS_API_BASE}/releases/${releaseId}?key=${this.apiKey}&secret=${this.apiSecret}`
      );

      if (!response.ok) {
        console.error(`[DiscogsProvider] Get release failed: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[DiscogsProvider] Get release error:', error);
      return null;
    }
  }

  /**
   * Get master release details by ID
   */
  async getMasterDetails(masterId: number): Promise<DiscogsMaster | null> {
    if (!this.apiKey) return null;

    try {
      const response = await this.throttledFetch(
        `${DISCOGS_API_BASE}/masters/${masterId}?key=${this.apiKey}&secret=${this.apiSecret}`
      );

      if (!response.ok) {
        console.error(`[DiscogsProvider] Get master failed: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[DiscogsProvider] Get master error:', error);
      return null;
    }
  }

  /**
   * Get artist details by ID
   */
  async getArtistDetails(artistId: number): Promise<DiscogsArtist | null> {
    if (!this.apiKey) return null;

    try {
      const response = await this.throttledFetch(
        `${DISCOGS_API_BASE}/artists/${artistId}?key=${this.apiKey}&secret=${this.apiSecret}`
      );

      if (!response.ok) {
        console.error(`[DiscogsProvider] Get artist failed: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[DiscogsProvider] Get artist error:', error);
      return null;
    }
  }

  /**
   * Fetch full album metadata for a given artist and album
   */
  async fetchAlbumMetadata(
    artistName: string,
    albumTitle: string
  ): Promise<AlbumMetadataResult | null> {
    const searchResult = await this.searchRelease(artistName, albumTitle);
    if (!searchResult) return null;

    let releaseYear: number | undefined;
    let artworkUrl: string | undefined;
    let discogsUrl: string | undefined;
    let artistId: number | undefined;

    // Get artwork from search result (cover_image)
    if (searchResult.cover_image && !searchResult.cover_image.includes('spacer.gif')) {
      artworkUrl = searchResult.cover_image;
    }

    // Build Discogs URL
    if (searchResult.uri) {
      discogsUrl = `${DISCOGS_WEB_BASE}${searchResult.uri}`;
    }

    // Get details based on result type
    if (searchResult.type === 'master' || searchResult.master_id) {
      const masterId = searchResult.master_id || searchResult.id;
      const master = await this.getMasterDetails(masterId);
      if (master) {
        releaseYear = master.year;
        if (master.artists?.[0]?.id) {
          artistId = master.artists[0].id;
        }
        // Better quality image from master if available
        const primaryImage = master.images?.find((img) => img.type === 'primary');
        if (primaryImage?.uri) {
          artworkUrl = primaryImage.uri;
        }
      }
    } else if (searchResult.type === 'release') {
      const release = await this.getReleaseDetails(searchResult.id);
      if (release) {
        releaseYear = release.year;
        if (release.artists?.[0]?.id) {
          artistId = release.artists[0].id;
        }
        // Better quality image from release if available
        const primaryImage = release.images?.find((img) => img.type === 'primary');
        if (primaryImage?.uri) {
          artworkUrl = primaryImage.uri;
        }
      }
    }

    return {
      discogsReleaseId: searchResult.id,
      discogsUrl,
      releaseYear,
      artworkUrl,
    };
  }

  /**
   * Fetch artist metadata including bio and Wikipedia URL
   */
  async fetchArtistMetadata(artistName: string): Promise<ArtistMetadataResult | null> {
    // First, search for the artist
    const params = new URLSearchParams({
      q: artistName,
      type: 'artist',
      key: this.apiKey,
      secret: this.apiSecret,
    });

    try {
      const searchResponse = await this.throttledFetch(
        `${DISCOGS_API_BASE}/database/search?${params}`
      );

      if (!searchResponse.ok) {
        return null;
      }

      const searchData: DiscogsSearchResponse = await searchResponse.json();
      const artistResult = searchData.results.find((r) => r.type === 'artist');

      if (!artistResult) {
        return null;
      }

      // Get full artist details
      const artistDetails = await this.getArtistDetails(artistResult.id);
      if (!artistDetails) {
        return null;
      }

      // Extract Wikipedia URL from artist URLs
      let wikipediaUrl: string | undefined;
      if (artistDetails.urls) {
        const wikiUrl = artistDetails.urls.find(
          (url) => url.includes('wikipedia.org') || url.includes('en.wikipedia.org')
        );
        wikipediaUrl = wikiUrl;
      }

      // Clean up bio - remove Discogs markup if needed
      let bio = artistDetails.profile;
      if (bio) {
        // Simple cleanup: remove [a=Artist], [l=Label], etc. tags
        bio = bio.replace(/\[a=([^\]]+)\]/g, '$1');
        bio = bio.replace(/\[l=([^\]]+)\]/g, '$1');
        bio = bio.replace(/\[r=([^\]]+)\]/g, '$1');
        bio = bio.replace(/\[m=([^\]]+)\]/g, '$1');
        bio = bio.replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');
      }

      return {
        discogsArtistId: artistDetails.id,
        bio,
        wikipediaUrl,
      };
    } catch (error) {
      console.error('[DiscogsProvider] Fetch artist metadata error:', error);
      return null;
    }
  }

  /**
   * Fetch artist metadata by Discogs artist ID (faster if we already know the ID)
   */
  async fetchArtistMetadataById(artistId: number): Promise<ArtistMetadataResult | null> {
    const artistDetails = await this.getArtistDetails(artistId);
    if (!artistDetails) {
      return null;
    }

    // Extract Wikipedia URL from artist URLs
    let wikipediaUrl: string | undefined;
    if (artistDetails.urls) {
      const wikiUrl = artistDetails.urls.find(
        (url) => url.includes('wikipedia.org') || url.includes('en.wikipedia.org')
      );
      wikipediaUrl = wikiUrl;
    }

    // Clean up bio
    let bio = artistDetails.profile;
    if (bio) {
      bio = bio.replace(/\[a=([^\]]+)\]/g, '$1');
      bio = bio.replace(/\[l=([^\]]+)\]/g, '$1');
      bio = bio.replace(/\[r=([^\]]+)\]/g, '$1');
      bio = bio.replace(/\[m=([^\]]+)\]/g, '$1');
      bio = bio.replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');
    }

    return {
      discogsArtistId: artistDetails.id,
      bio,
      wikipediaUrl,
    };
  }

  /**
   * Rate-limited fetch
   */
  private async throttledFetch(url: string): Promise<Response> {
    await this.rateLimiter.acquire();
    return fetch(url, {
      headers: {
        'User-Agent': this.userAgent,
      },
    });
  }
}
