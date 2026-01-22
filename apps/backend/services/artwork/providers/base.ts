/**
 * Base interface for artwork providers.
 *
 * Ported from request-parser artwork/providers/base.py
 */

import { ArtworkRequest, ArtworkSearchResult } from '../../requestLine/types.js';

/**
 * Interface for artwork providers.
 */
export interface ArtworkProvider {
  /** Provider name for attribution */
  readonly name: string;

  /**
   * Search for album artwork matching the request.
   *
   * @param request - The artwork request containing song/album/artist info
   * @returns List of search results, ordered by relevance. Empty list if no results found.
   */
  search(request: ArtworkRequest): Promise<ArtworkSearchResult[]>;
}
