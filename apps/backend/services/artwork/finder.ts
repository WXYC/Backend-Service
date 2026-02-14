/**
 * ArtworkFinder - Orchestrates artwork search across multiple providers.
 *
 * Ported from request-parser artwork/finder.py
 */

import { ArtworkProvider, discogsProvider } from './providers/index.js';
import { ArtworkRequest, ArtworkResponse, ArtworkSearchResult, EnrichedLibraryResult } from '../requestLine/types.js';
import { isCompilationArtist } from '../requestLine/matching/index.js';
import { getConfig } from '../requestLine/config.js';

/**
 * Orchestrates artwork search across multiple providers.
 */
export class ArtworkFinder {
  private providers: ArtworkProvider[];

  constructor(providers?: ArtworkProvider[]) {
    // Default to Discogs provider
    this.providers = providers || [discogsProvider];
  }

  /**
   * Find artwork for the given request.
   *
   * Tries each provider in order and returns the best result
   * based on confidence score.
   */
  async find(request: ArtworkRequest): Promise<ArtworkResponse> {
    if (!request.song && !request.album && !request.artist) {
      console.warn('[ArtworkFinder] Empty request - no fields to search');
      return this.emptyResponse();
    }

    const allResults: ArtworkSearchResult[] = [];

    for (const provider of this.providers) {
      try {
        const results = await provider.search(request);
        allResults.push(...results);
        console.log(`[ArtworkFinder] Provider ${provider.name} returned ${results.length} results`);
      } catch (error) {
        console.error(`[ArtworkFinder] Provider ${provider.name} failed:`, error);
        continue;
      }
    }

    if (allResults.length === 0) {
      console.log('[ArtworkFinder] No artwork found from any provider');
      return this.emptyResponse();
    }

    // Sort by confidence and return the best match
    allResults.sort((a, b) => b.confidence - a.confidence);
    const best = allResults[0];

    console.log(
      `[ArtworkFinder] Best match: ${best.artist} - ${best.album} ` +
        `(confidence: ${best.confidence.toFixed(2)}, source: ${best.source})`
    );

    return {
      artworkUrl: best.artworkUrl,
      releaseUrl: best.releaseUrl,
      album: best.album,
      artist: best.artist,
      source: best.source,
      confidence: best.confidence,
    };
  }

  /**
   * Create an empty artwork response.
   */
  private emptyResponse(): ArtworkResponse {
    return {
      artworkUrl: null,
      releaseUrl: null,
      album: null,
      artist: null,
      source: null,
      confidence: 0,
    };
  }
}

/**
 * Singleton finder instance.
 */
let _finder: ArtworkFinder | null = null;

/**
 * Get the artwork finder instance.
 */
export function getArtworkFinder(): ArtworkFinder {
  if (!_finder) {
    _finder = new ArtworkFinder();
  }
  return _finder;
}

/**
 * Reset the artwork finder (useful for testing).
 */
export function resetArtworkFinder(): void {
  _finder = null;
}

/**
 * Fetch artwork for multiple library items in parallel.
 *
 * @param items - List of library items
 * @param discogsTitles - Optional map of item ID to Discogs album title
 * @returns List of [item, artwork] tuples
 */
export async function fetchArtworkForItems(
  items: EnrichedLibraryResult[],
  discogsTitles?: Map<number, string>
): Promise<Array<[EnrichedLibraryResult, ArtworkResponse | null]>> {
  const config = getConfig();

  if (!config.enableArtworkLookup) {
    return items.map((item) => [item, null]);
  }

  const finder = getArtworkFinder();
  const discogsTitlesMap = discogsTitles || new Map<number, string>();

  const fetchOne = async (item: EnrichedLibraryResult): Promise<ArtworkResponse | null> => {
    try {
      // Use Discogs album title if we have it (from compilation search)
      const album = discogsTitlesMap.get(item.id) || item.title;

      // For compilations, simplify artist to "Various" for Discogs lookup
      // Library formats like "Various Artists - Rock - C" won't match Discogs
      let artist = item.artist;
      if (isCompilationArtist(artist)) {
        artist = 'Various';
      }

      const result = await finder.find({
        album: album || undefined,
        artist: artist || undefined,
      });

      return result;
    } catch (error) {
      console.warn(`[ArtworkFinder] Lookup failed for ${item.title}:`, error);
      return null;
    }
  };

  const artworkResults = await Promise.all(items.map(fetchOne));
  return items.map((item, index) => [item, artworkResults[index]]);
}
