/**
 * ArtworkFinder - Orchestrates artwork search across multiple providers.
 *
 * Ported from request-parser artwork/finder.py
 */

import { ArtworkProvider, discogsProvider, lastFmProvider, itunesProvider } from './providers/index.js';
import { ArtworkRequest, ArtworkResponse, ArtworkSearchResult, EnrichedLibraryResult } from '../requestLine/types.js';
import { isCompilationArtist } from '../requestLine/matching/index.js';
import { getConfig } from '../requestLine/config.js';

/**
 * Orchestrates artwork search across multiple providers.
 */
export class ArtworkFinder {
  private providers: ArtworkProvider[];

  constructor(providers?: ArtworkProvider[]) {
    // Default fallback chain: Discogs → Last.fm → iTunes (same order as iOS app)
    this.providers = providers || [discogsProvider, lastFmProvider, itunesProvider];
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
    // BS#1089: a provider that throws (LML timeout/5xx/network blip) hasn't
    // confirmed "no artwork" — it just failed to answer. Track that
    // separately from a provider that ran and genuinely found nothing, so a
    // request where no provider found anything doesn't look the same
    // whether every provider searched and came up empty or one of them
    // never got to answer. This only matters when nothing was found at all
    // — a later provider's real match still wins outright below, so a
    // transient Discogs failure followed by a Last.fm hit is "found," not
    // "errored" (don't infect a positive result from a partially-failing
    // fallback chain).
    let anyProviderErrored = false;

    for (const provider of this.providers) {
      try {
        const results = await provider.search(request);
        allResults.push(...results);
        console.log(`[ArtworkFinder] Provider ${provider.name} returned ${results.length} results`);
      } catch (error) {
        console.error(`[ArtworkFinder] Provider ${provider.name} failed:`, error);
        anyProviderErrored = true;
        continue;
      }
    }

    if (allResults.length === 0) {
      if (anyProviderErrored) {
        console.log('[ArtworkFinder] No artwork found and at least one provider errored — not a confirmed absence');
        return this.erroredResponse();
      }
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
   * Create an empty artwork response — a confirmed absence: every provider
   * that was asked ran to completion and found nothing.
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

  /**
   * Same empty shape as {@link emptyResponse}, tagged `errored: true`
   * (BS#1089). Returned when nothing was found AND at least one provider
   * never got to confirm an answer because it threw. Callers (the
   * `/proxy/artwork/search` negative cache) must not treat this the same as
   * a confirmed absence.
   */
  private erroredResponse(): ArtworkResponse {
    return { ...this.emptyResponse(), errored: true };
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
