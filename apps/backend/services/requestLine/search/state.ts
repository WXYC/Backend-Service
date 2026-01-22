/**
 * Search state management for the search pipeline.
 *
 * Ported from request-parser core/search.py
 */

import { EnrichedLibraryResult, SearchState, SearchStrategyType, createSearchState } from '../types.js';

/**
 * Get the search type string for telemetry from state.
 */
export function getSearchTypeFromState(state: SearchState): string {
  if (state.foundOnCompilation) {
    return 'compilation';
  }

  if (state.strategiesTried.length === 0) {
    return 'none';
  }

  const lastStrategy = state.strategiesTried[state.strategiesTried.length - 1];

  switch (lastStrategy) {
    case SearchStrategyType.ARTIST_PLUS_ALBUM:
      return state.songNotFound ? 'fallback' : 'direct';
    case SearchStrategyType.SWAPPED_INTERPRETATION:
      return 'alternative';
    case SearchStrategyType.TRACK_ON_COMPILATION:
      return 'compilation';
    case SearchStrategyType.SONG_AS_ARTIST:
      return 'song_as_artist';
    default:
      return 'none';
  }
}

export { createSearchState };
export type { SearchState };
