/**
 * Search pipeline executor.
 *
 * Orchestrates the execution of search strategies in order until results are found.
 * Ported from request-parser core/search.py execute_search_pipeline()
 */

import { ParsedRequest, SearchState, SearchStrategyType, createSearchState } from '../types.js';
import { MAX_SEARCH_RESULTS } from '../matching/index.js';
import {
  shouldRunArtistPlusAlbum,
  executeArtistPlusAlbum,
  shouldRunSwappedInterpretation,
  executeSwappedInterpretation,
  shouldRunTrackOnCompilation,
  executeTrackOnCompilation,
  shouldRunSongAsArtist,
  executeSongAsArtist,
} from './strategies/index.js';

// Forward declaration for Discogs service
interface DiscogsService {
  searchReleasesByTrack: (
    track: string,
    artist?: string,
    limit?: number
  ) => Promise<Array<{ artist: string; album: string; releaseId: number; isCompilation: boolean }>>;
  searchReleasesByArtist: (artist: string, limit?: number) => Promise<Array<{ artist: string; album: string }>>;
  validateTrackOnRelease: (releaseId: number, track: string, artist: string) => Promise<boolean>;
}

export interface PipelineOptions {
  /** Optional Discogs service for enhanced search */
  discogsService?: DiscogsService;
  /** Album names resolved from Discogs track lookup */
  albumsForSearch?: string[];
}

/**
 * Execute strategies in array order until results found.
 *
 * The pipeline tries strategies in this order:
 * 1. ARTIST_PLUS_ALBUM - search by artist + album/song
 * 2. SWAPPED_INTERPRETATION - try "X - Y" as both orderings
 * 3. TRACK_ON_COMPILATION - find song on compilations via Discogs
 * 4. SONG_AS_ARTIST - try parsed song as artist (parser misidentification)
 *
 * @param parsed - The parsed request with artist/song/album
 * @param rawMessage - Original request message (for ambiguous format detection)
 * @param options - Pipeline options including Discogs service
 * @returns SearchState with results and metadata about the search
 */
export async function executeSearchPipeline(
  parsed: ParsedRequest,
  rawMessage: string,
  options: PipelineOptions = {}
): Promise<SearchState> {
  const { discogsService, albumsForSearch = [] } = options;

  const state = createSearchState(albumsForSearch);

  // Strategy 1: Artist + Album/Song
  if (shouldRunArtistPlusAlbum(parsed, state, rawMessage)) {
    state.strategiesTried.push(SearchStrategyType.ARTIST_PLUS_ALBUM);
    const [results, fallbackUsed] = await executeArtistPlusAlbum(parsed, state);
    if (results.length > 0) {
      state.results = results;
    }
    if (fallbackUsed) {
      state.songNotFound = true;
    }
  }

  // Strategy 2: Swapped Interpretation (only if no results)
  if (shouldRunSwappedInterpretation(parsed, state, rawMessage)) {
    state.strategiesTried.push(SearchStrategyType.SWAPPED_INTERPRETATION);
    const results = await executeSwappedInterpretation(rawMessage);
    if (results.length > 0) {
      state.results = results;
      state.songNotFound = false;
    }
  }

  // Strategy 3: Track on Compilation (if song not found but we have artist and song)
  if (shouldRunTrackOnCompilation(parsed, state, rawMessage)) {
    state.strategiesTried.push(SearchStrategyType.TRACK_ON_COMPILATION);
    const [results, discogsTitles] = await executeTrackOnCompilation(parsed, discogsService);
    if (results.length > 0) {
      state.results = results;
      state.foundOnCompilation = true;
      state.songNotFound = false;
      state.discogsTitles = discogsTitles;
    }
  }

  // Strategy 4: Song as Artist (only if no results and song but no artist)
  if (shouldRunSongAsArtist(parsed, state, rawMessage)) {
    state.strategiesTried.push(SearchStrategyType.SONG_AS_ARTIST);
    const results = await executeSongAsArtist(parsed.song!, discogsService);
    if (results.length > 0) {
      state.results = results;
      state.songNotFound = false;
    }
  }

  // Limit final results
  state.results = state.results.slice(0, MAX_SEARCH_RESULTS);

  return state;
}
