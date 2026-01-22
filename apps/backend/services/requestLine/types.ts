/**
 * Type definitions for the Request Line NLP + Library Search feature.
 *
 * These types are ported from the Python request-parser project
 * and adapted for TypeScript/Express.
 */

// =============================================================================
// Message Parsing Types
// =============================================================================

/**
 * Message type classification from AI parser.
 */
export enum MessageType {
  REQUEST = 'request',
  DJ_MESSAGE = 'dj_message',
  FEEDBACK = 'feedback',
  OTHER = 'other',
}

/**
 * Result of AI parsing a listener message.
 */
export interface ParsedRequest {
  /** The specific song title requested, or null if not specified */
  song: string | null;
  /** The album name, or null if not specified */
  album: string | null;
  /** The artist/band name, or null if not specified */
  artist: string | null;
  /** True if the listener wants the DJ to play something */
  isRequest: boolean;
  /** Classification of the message type */
  messageType: MessageType;
  /** The original unparsed message */
  rawMessage: string;
}

// =============================================================================
// Library Search Types
// =============================================================================

/**
 * A single item from the library catalog.
 */
export interface LibraryResult {
  /** Database ID */
  id: number;
  /** Album title */
  title: string | null;
  /** Artist name */
  artist: string | null;
  /** Genre code letters (e.g., "RO" for Rock) */
  codeLetters: string | null;
  /** Artist number within genre */
  codeArtistNumber: number | null;
  /** Release number for this artist */
  codeNumber: number | null;
  /** Genre name */
  genre: string | null;
  /** Format name (CD, Vinyl, etc.) */
  format: string | null;
}

/**
 * Extended library result with computed fields.
 */
export interface EnrichedLibraryResult extends LibraryResult {
  /** Full call number for shelf lookup: <Genre> <Format> <Letters> <ArtistNum>/<ReleaseNum> */
  callNumber: string;
  /** URL to view this release in the WXYC library */
  libraryUrl: string;
}

/**
 * Compute the call number from library result fields.
 */
export function computeCallNumber(result: LibraryResult): string {
  const parts: string[] = [];
  if (result.genre) parts.push(result.genre);
  if (result.format) parts.push(result.format);
  if (result.codeLetters) parts.push(result.codeLetters);
  if (result.codeArtistNumber !== null) {
    if (result.codeNumber !== null) {
      parts.push(`${result.codeArtistNumber}/${result.codeNumber}`);
    } else {
      parts.push(String(result.codeArtistNumber));
    }
  }
  return parts.join(' ');
}

/**
 * Compute the library URL from a result ID.
 */
export function computeLibraryUrl(id: number): string {
  return `http://www.wxyc.info/wxycdb/libraryRelease?id=${id}`;
}

/**
 * Enrich a library result with computed fields.
 */
export function enrichLibraryResult(result: LibraryResult): EnrichedLibraryResult {
  return {
    ...result,
    callNumber: computeCallNumber(result),
    libraryUrl: computeLibraryUrl(result.id),
  };
}

// =============================================================================
// Search Strategy Types
// =============================================================================

/**
 * Descriptive names for each search strategy.
 * Used in telemetry to track which strategy succeeded.
 */
export enum SearchStrategyType {
  /** Search by artist + album/song name */
  ARTIST_PLUS_ALBUM = 'artist_plus_album',
  /** Fallback to just artist name when album/song search fails */
  ARTIST_ONLY = 'artist_only',
  /** Try "X - Y" format as both artist/title orderings */
  SWAPPED_INTERPRETATION = 'swapped_interpretation',
  /** Find song on compilation albums via Discogs cross-reference */
  TRACK_ON_COMPILATION = 'track_on_compilation',
  /** Fallback: try parsed song as artist when no results and no artist parsed */
  SONG_AS_ARTIST = 'song_as_artist',
  /** Significant word extraction search */
  KEYWORD_MATCH = 'keyword_match',
}

/**
 * Tracks state across strategy execution.
 */
export interface SearchState {
  /** Current search results */
  results: EnrichedLibraryResult[];
  /** True if the exact song/album wasn't found (fell back to artist-only) */
  songNotFound: boolean;
  /** True if the song was found on a compilation album */
  foundOnCompilation: boolean;
  /** List of strategies that have been executed */
  strategiesTried: SearchStrategyType[];
  /** Map of library item ID to Discogs album title (for artwork lookup) */
  discogsTitles: Map<number, string>;
  /** Album names resolved from Discogs track lookup (may contain multiple) */
  albumsForSearch: string[];
}

/**
 * Create initial search state.
 */
export function createSearchState(albumsForSearch: string[] = []): SearchState {
  return {
    results: [],
    songNotFound: false,
    foundOnCompilation: false,
    strategiesTried: [],
    discogsTitles: new Map(),
    albumsForSearch,
  };
}

// =============================================================================
// Artwork Types
// =============================================================================

/**
 * Request to find album artwork.
 */
export interface ArtworkRequest {
  song?: string;
  album?: string;
  artist?: string;
}

/**
 * Response containing artwork URL and metadata.
 */
export interface ArtworkResponse {
  artworkUrl: string | null;
  releaseUrl: string | null;
  album: string | null;
  artist: string | null;
  source: string | null;
  confidence: number;
}

/**
 * A single search result from an artwork provider.
 */
export interface ArtworkSearchResult {
  artworkUrl: string;
  releaseUrl: string;
  album: string;
  artist: string;
  source: string;
  confidence: number;
}

// =============================================================================
// Discogs Types
// =============================================================================

/**
 * A single track on a release.
 */
export interface DiscogsTrackItem {
  position: string;
  title: string;
  duration?: string;
}

/**
 * Response for track-to-album lookup.
 */
export interface DiscogsTrackAlbumResponse {
  album: string | null;
  artist: string | null;
  releaseId: number | null;
  releaseUrl: string | null;
  cached: boolean;
}

/**
 * Information about a single release containing a track.
 */
export interface DiscogsReleaseInfo {
  album: string;
  artist: string;
  releaseId: number;
  releaseUrl: string;
  isCompilation: boolean;
}

/**
 * Response for finding all releases containing a track.
 */
export interface DiscogsTrackReleasesResponse {
  track: string;
  artist: string | null;
  releases: DiscogsReleaseInfo[];
  total: number;
  cached: boolean;
}

/**
 * Full release metadata from Discogs.
 */
export interface DiscogsReleaseMetadata {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  label: string | null;
  genres: string[];
  styles: string[];
  tracklist: DiscogsTrackItem[];
  artworkUrl: string | null;
  releaseUrl: string;
  cached: boolean;
}

/**
 * Request for general Discogs search.
 */
export interface DiscogsSearchRequest {
  artist?: string;
  album?: string;
  track?: string;
}

/**
 * A single result from Discogs search.
 */
export interface DiscogsSearchResult {
  album: string | null;
  artist: string | null;
  releaseId: number;
  releaseUrl: string;
  artworkUrl: string | null;
  confidence: number;
}

/**
 * Response for general Discogs search.
 */
export interface DiscogsSearchResponse {
  results: DiscogsSearchResult[];
  total: number;
  cached: boolean;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Combined response from parsing, artwork lookup, and library search.
 */
export interface UnifiedRequestResponse {
  /** Whether the operation was successful */
  success: boolean;
  /** Parsed request metadata */
  parsed: ParsedRequest;
  /** Artwork information (best match) */
  artwork: ArtworkResponse | null;
  /** Library search results */
  libraryResults: EnrichedLibraryResult[];
  /** Which search strategy succeeded */
  searchType: string;
  /** Result from Slack posting */
  result: { success: boolean; message?: string };
}

/**
 * Request body for song request parsing.
 */
export interface RequestLineRequestBody {
  message: string;
  skipSlack?: boolean;
  skipParsing?: boolean;
}

// =============================================================================
// Friendly Labels
// =============================================================================

/**
 * Human-readable labels for message types in Slack.
 */
export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  [MessageType.REQUEST]: 'Song Request',
  [MessageType.DJ_MESSAGE]: 'Message to DJ',
  [MessageType.FEEDBACK]: 'Feedback',
  [MessageType.OTHER]: 'Other',
};
