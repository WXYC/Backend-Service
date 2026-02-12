/**
 * Artist + Album/Song search strategy.
 *
 * This is the primary search strategy that tries:
 * 1. Artist + each album (from Discogs lookup)
 * 2. Artist + song (song title might match album title)
 * 3. Artist only (fallback)
 *
 * Ported from request-parser routers/request.py search_library_with_fallback()
 */

import { ParsedRequest, EnrichedLibraryResult, SearchState, SearchStrategyType } from '../../types.js';
import { searchLibrary, filterResultsByArtist } from '../../../library.service.js';
import { MAX_SEARCH_RESULTS } from '../../matching/index.js';

/**
 * Check if this strategy should run.
 */
export function shouldRunArtistPlusAlbum(parsed: ParsedRequest, state: SearchState, _rawMessage: string): boolean {
  return !!(parsed.artist && (state.albumsForSearch.length > 0 || parsed.song));
}

/**
 * Execute the artist + album/song search strategy.
 *
 * @returns Tuple of [results, fallbackUsed]
 */
export async function executeArtistPlusAlbum(
  parsed: ParsedRequest,
  state: SearchState
): Promise<[EnrichedLibraryResult[], boolean]> {
  const allResults: EnrichedLibraryResult[] = [];
  const seenIds = new Set<number>();

  // Search for each album from Discogs
  if (parsed.artist && state.albumsForSearch.length > 0) {
    for (const album of state.albumsForSearch) {
      const query = `${parsed.artist} ${album}`;
      const results = await searchLibrary(query, undefined, undefined, MAX_SEARCH_RESULTS);
      const filtered = filterResultsByArtist(results, parsed.artist);

      // Add unique results
      for (const item of filtered) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allResults.push(item);
        }
      }
    }

    if (allResults.length > 0) {
      // Sort to prioritize results matching the first (primary) album
      const primaryAlbumLower = state.albumsForSearch[0].toLowerCase();
      allResults.sort((a, b) => {
        const aMatches = (a.title || '').toLowerCase().includes(primaryAlbumLower) ? 1 : 0;
        const bMatches = (b.title || '').toLowerCase().includes(primaryAlbumLower) ? 1 : 0;
        return bMatches - aMatches;
      });
      return [allResults.slice(0, MAX_SEARCH_RESULTS), false];
    }
  }

  // If no albums from Discogs, try artist + song
  if (parsed.artist && parsed.song) {
    const query = `${parsed.artist} ${parsed.song}`;
    const results = await searchLibrary(query, undefined, undefined, MAX_SEARCH_RESULTS);
    const filtered = filterResultsByArtist(results, parsed.artist);

    if (filtered.length > 0) {
      // Prioritize results where album title matches song title
      const songLower = parsed.song.toLowerCase();
      filtered.sort((a, b) => {
        const aMatches = (a.title || '').toLowerCase().includes(songLower) ? 1 : 0;
        const bMatches = (b.title || '').toLowerCase().includes(songLower) ? 1 : 0;
        return bMatches - aMatches;
      });
      return [filtered, false];
    }
  }

  // If still no results, try just artist (fallback)
  if (allResults.length === 0 && parsed.artist) {
    console.log(
      `[Search] No results for albums ${JSON.stringify(state.albumsForSearch)}, trying artist only: '${parsed.artist}'`
    );
    const results = await searchLibrary(parsed.artist, undefined, undefined, MAX_SEARCH_RESULTS);
    const filtered = filterResultsByArtist(results, parsed.artist);
    if (filtered.length > 0) {
      return [filtered, true]; // fallback was used
    }
  }

  return [allResults, false];
}
