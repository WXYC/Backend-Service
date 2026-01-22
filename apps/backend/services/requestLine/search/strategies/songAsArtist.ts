/**
 * Song as Artist search strategy.
 *
 * Fallback strategy that tries using the parsed song title as an artist name.
 * This handles cases where the AI parser misinterpreted an artist name
 * as a song title (e.g., "Laid Back" parsed as song instead of artist).
 *
 * Ported from request-parser routers/request.py search_song_as_artist()
 */

import { ParsedRequest, EnrichedLibraryResult, SearchState, SearchStrategyType } from '../../types.js';
import { searchLibrary, filterResultsByArtist, searchAlbumsByTitle } from '../../../library.service.js';
import { isCompilationArtist, MAX_SEARCH_RESULTS } from '../../matching/index.js';

// Forward declaration - will be imported when Discogs service is ready
type DiscogsService = {
  searchReleasesByArtist: (
    artist: string,
    limit?: number
  ) => Promise<Array<{ artist: string; album: string }>>;
};

/**
 * Check if this strategy should run.
 */
export function shouldRunSongAsArtist(
  parsed: ParsedRequest,
  state: SearchState,
  _rawMessage: string
): boolean {
  // Only run if no results AND parsed song but no artist
  return state.results.length === 0 && !!parsed.song && !parsed.artist;
}

/**
 * Execute the song as artist search strategy.
 *
 * Strategy:
 * 1. Search library for direct artist match
 * 2. If no results and Discogs available, search Discogs for releases by that artist
 * 3. Cross-reference Discogs album titles with library (for compilations)
 *
 * @param songAsArtist - The song title to try as an artist name
 * @param discogsService - Optional Discogs service for cross-referencing
 */
export async function executeSongAsArtist(
  songAsArtist: string,
  discogsService?: DiscogsService
): Promise<EnrichedLibraryResult[]> {
  console.log(`[Search] Trying song '${songAsArtist}' as artist name`);

  // Step 1: Direct library search for artist
  const results = await searchLibrary(songAsArtist, undefined, undefined, MAX_SEARCH_RESULTS);
  const filtered = filterResultsByArtist(results, songAsArtist);
  if (filtered.length > 0) {
    console.log(`[Search] Found ${filtered.length} results treating '${songAsArtist}' as artist`);
    return filtered;
  }

  // Step 2: Search Discogs for releases by this artist (if available)
  if (!discogsService) {
    return [];
  }

  console.log(`[Search] No direct matches, searching Discogs for releases by '${songAsArtist}'`);
  const discogsReleases = await discogsService.searchReleasesByArtist(songAsArtist, 10);

  if (discogsReleases.length === 0) {
    console.log(`[Search] No Discogs releases found for '${songAsArtist}'`);
    return [];
  }

  console.log(`[Search] Found ${discogsReleases.length} Discogs releases for '${songAsArtist}'`);

  // Step 3: Cross-reference album titles with library
  const crossRefResults: EnrichedLibraryResult[] = [];
  const seenIds = new Set<number>();

  for (const { artist: discogsArtist, album: albumTitle } of discogsReleases) {
    if (!albumTitle) {
      continue;
    }

    // Search library for this album title
    const albumResults = await searchAlbumsByTitle(albumTitle, MAX_SEARCH_RESULTS);

    for (const item of albumResults) {
      if (seenIds.has(item.id)) {
        continue;
      }

      // Accept if it's the actual artist or a compilation
      const itemArtist = (item.artist || '').toLowerCase();
      if (
        itemArtist.startsWith(songAsArtist.toLowerCase()) ||
        isCompilationArtist(item.artist)
      ) {
        crossRefResults.push(item);
        seenIds.add(item.id);
        console.log(
          `[Search] Found '${item.artist} - ${item.title}' via Discogs cross-reference`
        );
      }
    }

    if (crossRefResults.length >= MAX_SEARCH_RESULTS) {
      break;
    }
  }

  if (crossRefResults.length > 0) {
    console.log(
      `[Search] Found ${crossRefResults.length} results via Discogs cross-reference for '${songAsArtist}'`
    );
  }

  return crossRefResults.slice(0, MAX_SEARCH_RESULTS);
}
