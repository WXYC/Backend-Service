/**
 * Song as Artist search strategy.
 *
 * Fallback strategy that tries using the parsed song title as an artist name.
 * This handles cases where the AI parser misinterpreted an artist name
 * as a song title (e.g., "Laid Back" parsed as song instead of artist).
 *
 * A failed Discogs/LML lookup degrades to no results rather than failing the
 * request, so it still reaches Slack (BS#2764).
 *
 * Ported from request-parser routers/request.py search_song_as_artist()
 */

import * as Sentry from '@sentry/node';
import { ParsedRequest, EnrichedLibraryResult, SearchState, SearchStrategyType } from '../../types.js';
import { searchLibrary, filterResultsByArtist, searchAlbumsByTitle } from '../../../library.service.js';
import { isCompilationArtist, MAX_SEARCH_RESULTS } from '../../matching/index.js';
import { shouldCaptureExpressError } from '../../../../middleware/sentryErrorFilter.js';

// Forward declaration - will be imported when Discogs service is ready
type DiscogsService = {
  searchReleasesByArtist: (artist: string, limit?: number) => Promise<Array<{ artist: string; album: string }>>;
};

/**
 * Check if this strategy should run.
 */
export function shouldRunSongAsArtist(parsed: ParsedRequest, state: SearchState, _rawMessage: string): boolean {
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
  let discogsReleases: Awaited<ReturnType<DiscogsService['searchReleasesByArtist']>>;
  try {
    discogsReleases = await discogsService.searchReleasesByArtist(songAsArtist, 10);
  } catch (e) {
    console.warn(`[Search] Discogs search by artist failed for '${songAsArtist}':`, e);
    // This catch used to be absent, so a bug here (e.g. a TypeError in the
    // mapping closure the caller wires up around `searchReleasesByArtist`)
    // reached the express error handler and got captured to Sentry there.
    // Re-run the same classifier (the capture predicate in app.ts) so that
    // stays true: an expected LML transport failure (`LmlClientError`,
    // including a BS#1748 `LimiterShedError`) is excluded -- it's already
    // quiet by design -- but anything else is still reported instead of
    // this catch becoming a silent sink for real defects.
    const error = e instanceof Error ? e : new Error(String(e));
    if (shouldCaptureExpressError(error)) {
      Sentry.captureException(error, { level: 'warning', tags: { subsystem: 'request-line' } });
    }
    return [];
  }

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
      if (itemArtist.startsWith(songAsArtist.toLowerCase()) || isCompilationArtist(item.artist)) {
        crossRefResults.push(item);
        seenIds.add(item.id);
        console.log(`[Search] Found '${item.artist} - ${item.title}' via Discogs cross-reference`);
      }
    }

    if (crossRefResults.length >= MAX_SEARCH_RESULTS) {
      break;
    }
  }

  if (crossRefResults.length > 0) {
    console.log(`[Search] Found ${crossRefResults.length} results via Discogs cross-reference for '${songAsArtist}'`);
  }

  return crossRefResults.slice(0, MAX_SEARCH_RESULTS);
}
