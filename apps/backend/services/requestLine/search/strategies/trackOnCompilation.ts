/**
 * Track on Compilation search strategy.
 *
 * Searches for track on compilation albums using Discogs and library keyword search.
 * This handles cases where a song exists in the library but on a compilation or
 * soundtrack rather than the artist's own album.
 *
 * Ported from request-parser routers/request.py search_compilations_for_track()
 */

import { ParsedRequest, EnrichedLibraryResult, SearchState, SearchStrategyType } from '../../types.js';
import { searchLibrary, searchAlbumsByTitle, filterResultsByArtist } from '../../../library.service.js';
import {
  extractSignificantWords,
  isCompilationArtist,
  STOPWORDS,
  MAX_SEARCH_RESULTS,
} from '../../matching/index.js';

// Forward declaration - will be imported when Discogs service is ready
type DiscogsService = {
  searchReleasesByTrack: (
    track: string,
    artist?: string,
    limit?: number
  ) => Promise<Array<{ artist: string; album: string; releaseId: number; isCompilation: boolean }>>;
  validateTrackOnRelease: (releaseId: number, track: string, artist: string) => Promise<boolean>;
};

/**
 * Check if this strategy should run.
 */
export function shouldRunTrackOnCompilation(
  parsed: ParsedRequest,
  state: SearchState,
  _rawMessage: string
): boolean {
  // Only run if song not found AND we have both artist and song
  return state.songNotFound && !!parsed.artist && !!parsed.song;
}

/**
 * Execute the track on compilation search strategy.
 *
 * @param parsed - Parsed request
 * @param discogsService - Optional Discogs service for cross-referencing
 * @returns Tuple of [results, discogsTitles map]
 */
export async function executeTrackOnCompilation(
  parsed: ParsedRequest,
  discogsService?: DiscogsService
): Promise<[EnrichedLibraryResult[], Map<number, string>]> {
  if (!parsed.song || !parsed.artist) {
    return [[], new Map()];
  }

  console.log(`[Search] Searching for '${parsed.song}' on other releases (compilations, etc.)`);

  const results: EnrichedLibraryResult[] = [];
  const seenIds = new Set<number>();
  const discogsTitles = new Map<number, string>();

  // First, try a direct library keyword search
  let keywordMatches: EnrichedLibraryResult[] = [];
  try {
    const artistWords = extractSignificantWords(parsed.artist);
    const songWords = extractSignificantWords(parsed.song);

    // Include both artist words (max 2) and song words (max 2) to find the right album
    const queryWords = [...artistWords.slice(0, 2), ...songWords.slice(0, 2)];

    if (queryWords.length > 0) {
      const keywordQuery = queryWords.join(' ');
      console.log(`[Search] Trying direct keyword search: '${keywordQuery}'`);
      const keywordResults = await searchLibrary(keywordQuery, undefined, undefined, MAX_SEARCH_RESULTS);

      if (keywordResults.length > 0) {
        // Filter by artist unless it's a compilation album
        const filtered: EnrichedLibraryResult[] = [];
        const artistLower = parsed.artist.toLowerCase();

        for (const item of keywordResults) {
          const itemArtist = (item.artist || '').toLowerCase();
          if (itemArtist.startsWith(artistLower)) {
            filtered.push(item);
          } else if (isCompilationArtist(item.artist)) {
            // Allow Various Artists/Soundtracks/Compilation albums
            filtered.push(item);
          }
        }

        if (filtered.length > 0) {
          console.log(
            `[Search] Found ${filtered.length} matches via keyword search (after artist filter)`
          );
          // Don't add to results yet - prefer Discogs results which know actual track listings
          keywordMatches = filtered;
        }
      }
    }
  } catch (e) {
    console.warn(`[Search] Keyword search failed:`, e);
    keywordMatches = [];
  }

  // If Discogs service is available, use it for more accurate results
  if (discogsService) {
    try {
      const releases = await discogsService.searchReleasesByTrack(
        parsed.song,
        parsed.artist,
        20
      );
      console.log(`[Search] Found ${releases.length} releases with '${parsed.song}' on Discogs`);

      // Check each release against our library
      for (const release of releases) {
        // Skip if the "album" is just the artist name (Discogs artifact)
        if (
          parsed.artist &&
          release.album.toLowerCase().trim() === parsed.artist.toLowerCase().trim()
        ) {
          console.log(`[Search] Skipping '${release.album}' - appears to be artist name, not album`);
          continue;
        }

        // Skip very short album titles (likely artifacts)
        if (release.album.trim().length < 3) {
          continue;
        }

        // For Various Artists / compilations, validate the tracklist
        if (release.isCompilation) {
          const isValid = await discogsService.validateTrackOnRelease(
            release.releaseId,
            parsed.song,
            parsed.artist
          );
          if (!isValid) {
            console.log(
              `[Search] Skipping '${release.album}' - track/artist not validated on release`
            );
            continue;
          }
        }

        const matches = await searchAlbumsByTitle(release.album, MAX_SEARCH_RESULTS);

        // Filter matches to only include albums by the requested artist OR compilations
        const filteredMatches: EnrichedLibraryResult[] = [];
        const artistLower = parsed.artist.toLowerCase();

        for (const match of matches) {
          const matchArtist = (match.artist || '').toLowerCase();

          // If Discogs says it's by the artist, only match artist albums
          // If Discogs says it's a compilation, allow compilation matches
          if (matchArtist.startsWith(artistLower)) {
            filteredMatches.push(match);
          } else if (release.isCompilation && isCompilationArtist(match.artist)) {
            filteredMatches.push(match);
          }
        }

        if (filteredMatches.length > 0) {
          console.log(
            `[Search] Found '${parsed.song}' in library on '${filteredMatches[0].title}' ` +
              `(matched from Discogs: '${release.album}')`
          );
          // Add matches, deduplicating by ID
          for (const match of filteredMatches) {
            if (!seenIds.has(match.id)) {
              results.push(match);
              seenIds.add(match.id);
              // Store the Discogs album title for artwork lookup
              discogsTitles.set(match.id, release.album);
            }
          }

          if (results.length >= MAX_SEARCH_RESULTS) {
            break;
          }
        }
      }
    } catch (e) {
      console.warn(`[Search] Failed to search for track on other releases:`, e);
    }
  }

  // If Discogs didn't find anything, fall back to keyword matches
  if (results.length === 0 && keywordMatches.length > 0) {
    console.log(`[Search] Discogs search found nothing, using keyword matches as fallback`);
    for (const item of keywordMatches.slice(0, 1)) {
      if (!seenIds.has(item.id)) {
        results.push(item);
        seenIds.add(item.id);
      }
    }
  }

  // Prioritize albums whose title matches the song title
  if (results.length > 0 && parsed.song) {
    const songLower = parsed.song.toLowerCase();
    results.sort((a, b) => {
      const aMatches = (a.title || '').toLowerCase().includes(songLower) ? 1 : 0;
      const bMatches = (b.title || '').toLowerCase().includes(songLower) ? 1 : 0;
      return bMatches - aMatches;
    });
  }

  return [results.slice(0, MAX_SEARCH_RESULTS), discogsTitles];
}
