/**
 * Enhanced Request Line Service with AI parsing and library search.
 *
 * This is the main orchestration layer that:
 * 1. Parses messages with AI
 * 2. Searches the library
 * 3. Fetches artwork
 * 4. Posts to Slack with rich formatting
 */

import {
  ParsedRequest,
  EnrichedLibraryResult,
  ArtworkResponse,
  UnifiedRequestResponse,
  RequestLineRequestBody,
  MESSAGE_TYPE_LABELS,
  MessageType,
} from './types.js';
import { getConfig, isParsingEnabled, isDiscogsEnabled } from './config.js';
import { parseRequest, isParserAvailable } from '../ai/index.js';
import { executeSearchPipeline, getSearchTypeFromState } from './search/index.js';
import { findSimilarArtist } from '../library.service.js';
import { DiscogsService, isDiscogsAvailable } from '../discogs/index.js';
import { fetchArtworkForItems } from '../artwork/index.js';
import {
  buildSlackBlocks,
  buildSimpleSlackBlocks,
  postBlocksToSlack,
  postTextToSlack,
  SlackPostResult,
} from '../slack/index.js';
import { discogsProvider } from '../artwork/providers/index.js';
import { MAX_SEARCH_RESULTS } from './matching/index.js';

/**
 * Resolve album names for a track if not provided.
 *
 * Searches Discogs for ALL releases containing the track, not just the first one.
 */
async function resolveAlbumsForTrack(
  parsed: ParsedRequest
): Promise<{ albums: string[]; songNotFound: boolean }> {
  // Check if album is missing or if album == artist (parser error)
  const albumIsMissing = !parsed.album;
  const albumIsArtist =
    parsed.album &&
    parsed.artist &&
    parsed.album.toLowerCase().trim() === parsed.artist.toLowerCase().trim();

  // Only do track lookup if we have an artist
  if (parsed.song && parsed.artist && (albumIsMissing || albumIsArtist)) {
    if (albumIsArtist) {
      console.log(
        `[RequestLine] Album '${parsed.album}' appears to be artist name, looking up albums`
      );
    }

    if (!isDiscogsAvailable()) {
      console.log('[RequestLine] Discogs not available for album lookup');
      return { albums: [], songNotFound: true };
    }

    try {
      // Get ALL releases containing this track
      const releases = await discogsProvider.searchReleasesByTrack(
        parsed.song,
        parsed.artist,
        10
      );

      if (releases.length > 0) {
        // Extract unique album names, filtering to releases by this artist
        const albums: string[] = [];
        const artistLower = parsed.artist.toLowerCase();

        for (const [releaseArtist, album] of releases) {
          // Only include releases by the requested artist (not compilations)
          if (releaseArtist.toLowerCase().startsWith(artistLower)) {
            if (!albums.includes(album)) {
              albums.push(album);
            }
          }
        }

        if (albums.length > 0) {
          console.log(
            `[RequestLine] Found ${albums.length} albums for song '${parsed.song}': ${albums.join(', ')}`
          );
          return { albums, songNotFound: false };
        }
      }

      console.log(`[RequestLine] Could not find albums for song '${parsed.song}'`);
      return { albums: [], songNotFound: true };
    } catch (error) {
      console.warn(`[RequestLine] Track lookup failed:`, error);
      return { albums: [], songNotFound: true };
    }
  }

  return { albums: parsed.album ? [parsed.album] : [], songNotFound: false };
}

/**
 * Build context message for Slack based on search results.
 */
function buildContextMessage(
  parsed: ParsedRequest,
  foundOnCompilation: boolean,
  songNotFound: boolean,
  hasResults: boolean
): string | undefined {
  if (foundOnCompilation) {
    return `Found "${parsed.song}" by ${parsed.artist} on:`;
  }

  if (songNotFound && hasResults) {
    // Show "here are other albums" only if we have results to show
    if (parsed.song && parsed.album) {
      return `"${parsed.album}" not found in the library, but here are other albums by ${parsed.artist}:`;
    } else if (parsed.song) {
      return `"${parsed.song}" is not on any album in the library, but here are some albums by ${parsed.artist}:`;
    }
  } else if (songNotFound && !hasResults) {
    // No results at all after filtering
    if (parsed.song && parsed.artist) {
      return `"${parsed.song}" by ${parsed.artist} not found in library.`;
    }
  }

  return undefined;
}

/**
 * Post results to Slack with rich formatting.
 */
async function postResultsToSlack(
  message: string,
  parsed: ParsedRequest,
  itemsWithArtwork: Array<[EnrichedLibraryResult, ArtworkResponse | null]>,
  context?: string
): Promise<SlackPostResult> {
  if (itemsWithArtwork.length > 0) {
    const blocks = buildSlackBlocks(message, itemsWithArtwork, context);
    return postBlocksToSlack(blocks, message);
  } else if (!parsed.isRequest) {
    const label = MESSAGE_TYPE_LABELS[parsed.messageType] || 'Other';
    const blocks = buildSimpleSlackBlocks(message, `_${label}_`);
    return postBlocksToSlack(blocks, message);
  } else {
    // Request but no results found
    const contextParts: string[] = [];
    if (parsed.artist) contextParts.push(`Artist: ${parsed.artist}`);
    if (parsed.album) contextParts.push(`Album: ${parsed.album}`);
    if (parsed.song) contextParts.push(`Song: ${parsed.song}`);
    const ctx = contextParts.length > 0 ? contextParts.join(' | ') : undefined;
    const blocks = buildSimpleSlackBlocks(message, `_No results found_ ${ctx || ''}`);
    return postBlocksToSlack(blocks, message);
  }
}

/**
 * Process a song request through the full pipeline.
 *
 * This is the main entry point for the enhanced request line service.
 */
export async function processRequest(
  body: RequestLineRequestBody
): Promise<UnifiedRequestResponse> {
  const config = getConfig();
  const message = body.message.trim();

  if (!message) {
    throw new Error('Message cannot be empty');
  }

  let parsed: ParsedRequest;
  let libraryResults: EnrichedLibraryResult[] = [];
  let itemsWithArtwork: Array<[EnrichedLibraryResult, ArtworkResponse | null]> = [];
  let songNotFound = false;
  let foundOnCompilation = false;
  let discogsTitles = new Map<number, string>();
  let searchType = 'none';

  // Step 1: Parse the message
  if (!body.skipParsing && isParserAvailable()) {
    try {
      parsed = await parseRequest(message);
      console.log(
        `[RequestLine] Parsed request: is_request=${parsed.isRequest}, type=${parsed.messageType}`
      );
    } catch (error) {
      console.error('[RequestLine] Parsing failed:', error);
      // Per the plan: "Requests fail if Groq is unavailable"
      throw new Error(`AI parsing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (body.skipParsing) {
    // Create a minimal parsed request when parsing is skipped
    parsed = {
      song: null,
      album: null,
      artist: null,
      isRequest: true,
      messageType: MessageType.REQUEST,
      rawMessage: message,
    };
  } else {
    // AI parsing is required but not available
    throw new Error('GROQ_API_KEY is not configured - AI parsing is required');
  }

  // Step 1b: Correct artist spelling
  if (parsed.artist) {
    try {
      const correctedArtist = await findSimilarArtist(parsed.artist);
      if (correctedArtist) {
        console.log(`[RequestLine] Corrected artist: '${parsed.artist}' -> '${correctedArtist}'`);
        parsed = { ...parsed, artist: correctedArtist };
      }
    } catch (error) {
      console.warn('[RequestLine] Artist correction failed:', error);
    }
  }

  // Step 2: Look up albums from Discogs if we have a song but no album
  const { albums: albumsForSearch, songNotFound: initialSongNotFound } =
    await resolveAlbumsForTrack(parsed);
  songNotFound = initialSongNotFound;

  // Step 3: Execute search strategy pipeline
  if (config.enableLibrarySearch) {
    const searchState = await executeSearchPipeline(parsed, message, {
      discogsService: isDiscogsAvailable() ? DiscogsService : undefined,
      albumsForSearch,
    });

    libraryResults = searchState.results.slice(0, MAX_SEARCH_RESULTS);
    songNotFound = searchState.songNotFound;
    foundOnCompilation = searchState.foundOnCompilation;
    discogsTitles = searchState.discogsTitles;
    searchType = getSearchTypeFromState(searchState);
  }

  // Step 4: Fetch artwork for library items
  if (libraryResults.length > 0 && config.enableArtworkLookup) {
    try {
      itemsWithArtwork = await fetchArtworkForItems(libraryResults, discogsTitles);
    } catch (error) {
      console.warn('[RequestLine] Artwork fetch failed:', error);
      itemsWithArtwork = libraryResults.map((item) => [item, null]);
    }
  } else {
    itemsWithArtwork = libraryResults.map((item) => [item, null]);
  }

  // Step 5: Post to Slack (unless skipSlack is set)
  let slackResult: SlackPostResult = { success: true, message: 'Slack posting skipped' };

  if (!body.skipSlack) {
    const context = buildContextMessage(
      parsed,
      foundOnCompilation,
      songNotFound,
      libraryResults.length > 0
    );

    try {
      slackResult = await postResultsToSlack(message, parsed, itemsWithArtwork, context);
    } catch (error) {
      console.error('[RequestLine] Slack posting failed:', error);
      slackResult = {
        success: false,
        message: `Slack posting failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Extract main artwork from first result
  const artwork =
    itemsWithArtwork.find(([_, art]) => art !== null)?.[1] || null;

  return {
    success: true,
    parsed,
    artwork,
    libraryResults,
    searchType,
    result: slackResult,
  };
}

/**
 * Parse a message without searching or posting (for debugging).
 */
export async function parseOnly(message: string): Promise<ParsedRequest> {
  if (!isParserAvailable()) {
    throw new Error('GROQ_API_KEY is not configured');
  }
  return parseRequest(message);
}
