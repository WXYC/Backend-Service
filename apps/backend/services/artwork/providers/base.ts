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
   * @returns List of search results, ordered by relevance. An empty list
   *   means the search ran to completion and confirmed no match — a
   *   provider backed by an external service that could not answer (e.g.
   *   an upstream timeout/5xx) must throw rather than resolve empty, so
   *   `ArtworkFinder.find` can tell "confirmed no artwork" apart from
   *   "couldn't determine" (BS#1089). `DiscogsProvider.search` is the
   *   reference implementation of this contract.
   */
  search(request: ArtworkRequest): Promise<ArtworkSearchResult[]>;
}
