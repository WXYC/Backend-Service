/**
 * Discogs API Service with caching.
 *
 * Provides track search, release lookup, and artwork discovery.
 * Ported from request-parser discogs/service.py
 */

import axios from 'axios';
import { getConfig } from '../requestLine/config.js';
import { getTrackCache, getReleaseCache, getSearchCache, makeCacheKey } from './cache.js';
import { calculateConfidence, isCompilationArtist } from '../requestLine/matching/index.js';
import {
  DiscogsTrackAlbumResponse,
  DiscogsReleaseInfo,
  DiscogsTrackReleasesResponse,
  DiscogsReleaseMetadata,
  DiscogsSearchRequest,
  DiscogsSearchResult,
  DiscogsSearchResponse,
  DiscogsTrackItem,
} from '../requestLine/types.js';
import {
  RawDiscogsSearchResult,
  RawDiscogsRelease,
  RawDiscogsSearchResponse,
  RawDiscogsMaster,
  RawDiscogsArtist,
} from './types.js';
import { discogsClient, parseTitle } from './client.js';

/**
 * Discogs API service singleton.
 *
 * Uses the shared discogsClient for rate-limited HTTP requests.
 */
class DiscogsServiceClass {
  /**
   * Search for a track and return the album that contains it.
   */
  async searchTrack(track: string, artist?: string): Promise<DiscogsTrackAlbumResponse> {
    const cache = getTrackCache();
    const cacheKey = makeCacheKey('searchTrack', [track, artist]);

    const cached = cache.get(cacheKey) as DiscogsTrackAlbumResponse | undefined;
    if (cached) {
      console.log(`[Discogs] Cache hit for searchTrack: ${track}`);
      return { ...cached, cached: true };
    }

    const params: Record<string, string | number> = {
      type: 'release',
      track: track,
      per_page: 5,
    };
    if (artist) {
      params.artist = artist;
    }

    console.log(`[Discogs] Searching for track: ${track}, artist: ${artist}`);

    try {
      const response = await discogsClient.get<RawDiscogsSearchResponse>('/database/search', { params });

      const results = response.data.results || [];
      if (results.length > 0) {
        const result = results[0];
        const { artist: resultArtist, album } = parseTitle(result.title);
        const releaseId = result.id;
        const releaseUrl = `https://www.discogs.com/release/${releaseId}`;

        console.log(`[Discogs] Found album '${album}' for track '${track}'`);
        const trackResponse: DiscogsTrackAlbumResponse = {
          album,
          artist: resultArtist,
          releaseId,
          releaseUrl,
          cached: false,
        };
        cache.set(cacheKey, trackResponse);
        return trackResponse;
      }

      return { album: null, artist: null, releaseId: null, releaseUrl: null, cached: false };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn('[Discogs] Rate limit hit');
      } else {
        console.error('[Discogs] Track search failed:', error);
      }
      return { album: null, artist: null, releaseId: null, releaseUrl: null, cached: false };
    }
  }

  /**
   * Search for ALL releases containing a track.
   */
  async searchReleasesByTrack(track: string, artist?: string, limit = 20): Promise<DiscogsTrackReleasesResponse> {
    const cache = getTrackCache();
    const cacheKey = makeCacheKey('searchReleasesByTrack', [track, artist, limit]);

    const cached = cache.get(cacheKey) as DiscogsTrackReleasesResponse | undefined;
    if (cached) {
      console.log(`[Discogs] Cache hit for searchReleasesByTrack: ${track}`);
      return { ...cached, cached: true };
    }

    const releases: DiscogsReleaseInfo[] = [];
    const seenAlbums = new Set<string>();

    // First search with track parameter
    const params: Record<string, string | number> = {
      type: 'release',
      track: track,
      per_page: limit,
    };
    if (artist) {
      params.artist = artist;
    }

    console.log(`[Discogs] Searching for releases with track: '${track}', artist: ${artist}`);

    try {
      const response = await discogsClient.get<RawDiscogsSearchResponse>('/database/search', { params });

      for (const result of response.data.results || []) {
        const releaseInfo = this.processSearchResult(result, seenAlbums);
        if (releaseInfo) {
          releases.push(releaseInfo);
        }
      }

      console.log(`[Discogs] Track search found ${releases.length} releases`);

      // Supplement with keyword search if few results
      if (releases.length < 3) {
        const queryParts = [track];
        if (artist) {
          queryParts.push(artist);
        }

        const keywordParams: Record<string, string | number> = {
          type: 'release',
          q: queryParts.join(' '),
          per_page: limit,
        };

        console.log(`[Discogs] Supplementing with keyword search: '${keywordParams.q}'`);
        const keywordResponse = await discogsClient.get<RawDiscogsSearchResponse>('/database/search', {
          params: keywordParams,
        });

        for (const result of keywordResponse.data.results || []) {
          const releaseInfo = this.processSearchResult(result, seenAlbums);
          if (releaseInfo) {
            releases.push(releaseInfo);
          }
        }

        console.log(`[Discogs] After keyword search: ${releases.length} total releases`);
      }

      const trackResponse: DiscogsTrackReleasesResponse = {
        track,
        artist: artist || null,
        releases: releases.slice(0, limit),
        total: releases.length,
        cached: false,
      };

      cache.set(cacheKey, trackResponse);
      return trackResponse;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn('[Discogs] Rate limit hit');
      } else {
        console.error('[Discogs] Search failed:', error);
      }
      return {
        track,
        artist: artist || null,
        releases: [],
        total: 0,
        cached: false,
      };
    }
  }

  /**
   * Process a single search result into a DiscogsReleaseInfo.
   */
  private processSearchResult(result: RawDiscogsSearchResult, seenAlbums: Set<string>): DiscogsReleaseInfo | null {
    const { artist, album } = parseTitle(result.title);

    if (!album) {
      return null;
    }

    const albumKey = album.toLowerCase();
    if (seenAlbums.has(albumKey)) {
      return null;
    }

    seenAlbums.add(albumKey);

    return {
      album,
      artist,
      releaseId: result.id,
      releaseUrl: `https://www.discogs.com/release/${result.id}`,
      isCompilation: isCompilationArtist(artist),
    };
  }

  /**
   * Get full release metadata by ID.
   */
  async getRelease(releaseId: number): Promise<DiscogsReleaseMetadata | null> {
    const cache = getReleaseCache();
    const cacheKey = makeCacheKey('getRelease', [releaseId]);

    const cached = cache.get(cacheKey) as DiscogsReleaseMetadata | undefined;
    if (cached) {
      console.log(`[Discogs] Cache hit for getRelease: ${releaseId}`);
      return { ...cached, cached: true };
    }

    try {
      const response = await discogsClient.get<RawDiscogsRelease>(`/releases/${releaseId}`);
      const data = response.data;

      // Extract artists
      const artistName = data.artists?.[0]?.name || '';

      // Extract labels
      const labelName = data.labels?.[0]?.name || null;

      // Extract tracklist
      const tracklist: DiscogsTrackItem[] = (data.tracklist || []).map((t) => ({
        position: t.position || '',
        title: t.title || '',
        duration: t.duration,
      }));

      // Extract artwork
      const artworkUrl = data.images?.[0]?.uri || null;

      const releaseMetadata: DiscogsReleaseMetadata = {
        releaseId,
        title: data.title || '',
        artist: artistName,
        year: data.year || null,
        label: labelName,
        genres: data.genres || [],
        styles: data.styles || [],
        tracklist,
        artworkUrl,
        releaseUrl: `https://www.discogs.com/release/${releaseId}`,
        cached: false,
      };

      cache.set(cacheKey, releaseMetadata);
      return releaseMetadata;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn('[Discogs] Rate limit hit');
      } else {
        console.error(`[Discogs] Failed to fetch release ${releaseId}:`, error);
      }
      return null;
    }
  }

  /**
   * General release search for artwork discovery.
   */
  async search(request: DiscogsSearchRequest, limit = 5): Promise<DiscogsSearchResponse> {
    const cache = getSearchCache();
    const cacheKey = makeCacheKey('search', [request, limit]);

    const cached = cache.get(cacheKey) as DiscogsSearchResponse | undefined;
    if (cached) {
      console.log(`[Discogs] Cache hit for search`);
      return { ...cached, cached: true };
    }

    const params = this.buildSearchParams(request, limit);
    if (Object.keys(params).length === 2) {
      // Only has type and per_page
      console.warn('[Discogs] No searchable fields in request');
      return { results: [], total: 0, cached: false };
    }

    console.log(`[Discogs] Searching with params:`, params);

    try {
      let response = await discogsClient.get<RawDiscogsSearchResponse>('/database/search', { params });

      // If strict search returned nothing, try fuzzy query
      if ((!response.data.results || response.data.results.length === 0) && (request.artist || request.album)) {
        const queryParts: string[] = [];
        if (request.artist) queryParts.push(request.artist);
        if (request.album) queryParts.push(request.album);

        const fallbackParams = {
          type: 'release',
          per_page: limit,
          q: queryParts.join(' '),
        };

        console.log(`[Discogs] Strict search empty, trying fuzzy query:`, fallbackParams);
        response = await discogsClient.get<RawDiscogsSearchResponse>('/database/search', {
          params: fallbackParams,
        });
      }

      const results: DiscogsSearchResult[] = [];
      for (const item of response.data.results || []) {
        let coverUrl = item.thumb || null;
        if (coverUrl && coverUrl.includes('spacer.gif')) {
          coverUrl = null;
        }

        const { artist, album } = parseTitle(item.title);

        const confidence = calculateConfidence(request.artist, request.album, artist, album);

        const releaseUrl = `https://www.discogs.com/release/${item.id}`;

        results.push({
          album: album || null,
          artist: artist || null,
          releaseId: item.id,
          releaseUrl,
          artworkUrl: coverUrl,
          confidence,
        });
      }

      // Sort by confidence
      results.sort((a, b) => b.confidence - a.confidence);

      const searchResponse: DiscogsSearchResponse = {
        results,
        total: results.length,
        cached: false,
      };

      cache.set(cacheKey, searchResponse);
      return searchResponse;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn('[Discogs] Rate limit hit');
      } else {
        console.error('[Discogs] Search failed:', error);
      }
      return { results: [], total: 0, cached: false };
    }
  }

  /**
   * Build search params using Discogs-specific fields.
   */
  private buildSearchParams(request: DiscogsSearchRequest, limit: number): Record<string, string | number> {
    const params: Record<string, string | number> = {
      type: 'release',
      per_page: limit,
    };

    if (request.artist) {
      params.artist = request.artist;
    }
    if (request.album) {
      params.release_title = request.album;
    } else if (request.track) {
      params.release_title = request.track;
    }

    return params;
  }

  /**
   * Validate that a track by an artist exists on a release.
   */
  async validateTrackOnRelease(releaseId: number, track: string, artist: string): Promise<boolean> {
    const release = await this.getRelease(releaseId);
    if (!release) {
      return false;
    }

    const trackLower = track.toLowerCase();
    const artistLower = artist.toLowerCase();

    for (const item of release.tracklist) {
      const itemTitle = item.title.toLowerCase();
      // Check if track title matches
      if (!trackLower.includes(itemTitle) && !itemTitle.includes(trackLower)) {
        continue;
      }

      // For single-artist releases, check release artist
      let releaseArtist = release.artist.toLowerCase();
      // Remove Discogs numbering like "(2)"
      releaseArtist = releaseArtist.split('(')[0].trim();

      if (artistLower.includes(releaseArtist) || releaseArtist.includes(artistLower)) {
        console.log(`[Discogs] Validated: '${track}' by '${artist}' found on release ${releaseId}`);
        return true;
      }
    }

    console.log(`[Discogs] Track '${track}' by '${artist}' NOT found on release ${releaseId}`);
    return false;
  }

  /**
   * Search for releases by artist (for song-as-artist fallback).
   */
  async searchReleasesByArtist(artist: string, limit = 10): Promise<Array<{ artist: string; album: string }>> {
    const params = {
      type: 'release',
      artist: artist,
      per_page: limit,
    };

    try {
      const response = await discogsClient.get<RawDiscogsSearchResponse>('/database/search', { params });

      const releases: Array<{ artist: string; album: string }> = [];
      for (const result of response.data.results || []) {
        const { artist: resultArtist, album } = parseTitle(result.title);
        if (album) {
          releases.push({ artist: resultArtist, album });
        }
      }

      return releases;
    } catch (error) {
      console.error('[Discogs] Artist releases search failed:', error);
      return [];
    }
  }

  /**
   * Get master release by ID.
   * Masters represent the canonical version of a release across all pressings.
   */
  async getMaster(masterId: number): Promise<RawDiscogsMaster | null> {
    const cache = getReleaseCache();
    const cacheKey = makeCacheKey('getMaster', [masterId]);

    const cached = cache.get(cacheKey) as RawDiscogsMaster | undefined;
    if (cached) {
      console.log(`[Discogs] Cache hit for getMaster: ${masterId}`);
      return cached;
    }

    try {
      const response = await discogsClient.get<RawDiscogsMaster>(`/masters/${masterId}`);
      const data = response.data;

      console.log(`[Discogs] Fetched master: ${data.title} (${masterId})`);
      cache.set(cacheKey, data);
      return data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn('[Discogs] Rate limit hit');
      } else if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log(`[Discogs] Master ${masterId} not found`);
      } else {
        console.error(`[Discogs] Failed to fetch master ${masterId}:`, error);
      }
      return null;
    }
  }

  /**
   * Get artist by ID.
   */
  async getArtist(artistId: number): Promise<RawDiscogsArtist | null> {
    const cache = getReleaseCache();
    const cacheKey = makeCacheKey('getArtist', [artistId]);

    const cached = cache.get(cacheKey) as RawDiscogsArtist | undefined;
    if (cached) {
      console.log(`[Discogs] Cache hit for getArtist: ${artistId}`);
      return cached;
    }

    try {
      const response = await discogsClient.get<RawDiscogsArtist>(`/artists/${artistId}`);
      const data = response.data;

      console.log(`[Discogs] Fetched artist: ${data.name} (${artistId})`);
      cache.set(cacheKey, data);
      return data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn('[Discogs] Rate limit hit');
      } else if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log(`[Discogs] Artist ${artistId} not found`);
      } else {
        console.error(`[Discogs] Failed to fetch artist ${artistId}:`, error);
      }
      return null;
    }
  }
}

// Singleton instance
export const DiscogsService = new DiscogsServiceClass();

/**
 * Check if Discogs service is available.
 */
export function isDiscogsAvailable(): boolean {
  const config = getConfig();
  return !!(config.discogsApiKey && config.discogsApiSecret);
}
