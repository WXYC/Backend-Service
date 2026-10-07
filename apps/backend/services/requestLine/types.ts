/**
 * Type definitions for the Request Line NLP + Library Search feature.
 *
 * These types are ported from the Python request-parser project
 * and adapted for TypeScript/Express.
 */

import type { ReconciledIdentity, TrackMatchHint } from '@wxyc/shared/dtos';

/**
 * Opaque source tag for an `artist_search_alias` row. Defined as an open string
 * union so search-side code stays tolerant of new sources LML may add without
 * a wire-format break (artist-search-alias plan §"Out of scope" / Source
 * agnostic). The closed cases here are the four sources composed by
 * `artist-search-alias-consumer` (PR 4).
 */
export type ArtistSearchAliasSource =
  'discogs_name_variation' | 'discogs_alias' | 'discogs_member' | 'wxyc_library_alt' | (string & {});

/**
 * Surfaced on a search result when the row matched via the alias cache
 * (artist-search-alias plan §PR 5). Sibling to `matched_via?: TrackMatchHint[]`
 * — kept distinct because alias hits carry a `matched_variant` (the searchable
 * string) and a `source`, whereas track hints carry `title` + `position` +
 * `artist_credit` which have no meaning for alias matches.
 */
export interface ArtistMatchHint {
  matched_variant: string;
  source: ArtistSearchAliasSource;
}

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
  /** Alphabetical sort name (e.g. "Beatles, The") */
  alphabeticalName?: string | null;
  /** Genre code letters (e.g., "RO" for Rock) */
  codeLetters: string | null;
  /** Artist number within genre */
  codeArtistNumber: number | null;
  /** Release number for this artist */
  codeNumber: number | null;
  /** Per-release volume letter of a multi-volume set (e.g., "B"); stored case varies */
  codeVolumeLetters: string | null;
  /** Compilation section letter of a Rock/Soundtracks V/A slot (`code_comp_letter`); null elsewhere */
  codeCompLetter: string | null;
  /** Genre name */
  genre: string | null;
  /** Format name (CD, Vinyl, etc.) */
  format: string | null;
  /** Whether this release is available on streaming services */
  onStreaming?: boolean | null;
  /**
   * Reconciled external identifiers for the artist (Discogs, MusicBrainz,
   * Wikidata, Spotify, Apple Music, Bandcamp). Null when the artist hasn't
   * been reconciled yet -- mirrors the `reconciled_identity` field on the
   * artist response.
   */
  reconciledIdentity?: ReconciledIdentity | null;
}

/**
 * Extended library result with computed fields.
 */
export interface EnrichedLibraryResult extends LibraryResult {
  /**
   * Full call number for shelf lookup: `<Genre> <Format> <Letters>
   * <ArtistNum>/<ReleaseNum>[-<VolumeLetter>]` for a named artist. A Various Artists
   * compilation (BS#2822) renders in its shelf form instead:
   * `<Genre> <Format> V/A-<ReleaseNum>` for a single-bin genre,
   * `Rock <Format> V/A <Bin>-<ReleaseNum>`, or
   * `Soundtracks <Format> <Bin>-<ReleaseNum>` -- see `computeCallNumber`.
   */
  callNumber: string;
  /** URL to view this release in the WXYC library */
  libraryUrl: string;
  /**
   * Populated when a track-title match drove this release into the results
   * (catalog-track-search plan §5.1). Sourced from LML's `LookupResultItem.matched_via`
   * (Track 2 / BS#823) or from `compilation_track_artist` rows (Track 1 / BS#817).
   * Empty or absent for releases that matched on artist / album normally.
   * Backward-compatible — existing consumers ignore the field.
   */
  matched_via?: TrackMatchHint[];
  /**
   * Populated when an `artist_search_alias` variant drove this release into
   * the results via the LATERAL JOIN path (artist-search-alias plan §PR 5).
   * Only set when `CATALOG_SEARCH_ALIAS_ENABLED=true`; absent otherwise.
   * Backward-compatible — existing consumers ignore the field.
   */
  matched_via_alias?: ArtistMatchHint[];
}

/**
 * The literal `codeLetters` the catalog import collapses every Various
 * Artists `Z-<letter>` code to (BS#2822). Matches dj-site's
 * `VARIOUS_ARTISTS_CODE_LETTERS` (`lib/features/catalog/libraryCode.ts`).
 */
const VARIOUS_ARTISTS_CODE_LETTERS = 'V/A';

/**
 * True for a Various Artists compilation row, detected structurally rather
 * than by artist name (BS#2822). Two spellings:
 *
 * - `V/A` -- what the catalog import actually writes, matched case- and
 *   whitespace-insensitively. This is the only form Backend-Service serves.
 * - `Z-<letter>` (or the single-bin `Z--`) -- the legacy tubafrenzy spelling,
 *   kept so a row that predates or bypasses the import's rewrite still reads
 *   as a compilation.
 *
 * It also guards a write: `refileArtistInGenre` refuses to re-file a bucket this matches (BS#3022), so a change made
 * for rendering would change which re-files are refused. The `Z-` arm is case-sensitive, as in the contract.
 *
 * Matches dj-site's `isVariousArtists` (`lib/features/catalog/libraryCode.ts`).
 */
export function isVariousArtists(codeLetters: string): boolean {
  const trimmed = codeLetters.trim();
  return trimmed.toUpperCase() === VARIOUS_ARTISTS_CODE_LETTERS || trimmed.startsWith('Z-');
}

/**
 * Recover the legacy `Z-<letter>` spelling's bin letter from `codeLetters`
 * itself, at index 2 (`Z--` has no letter there -- single-bin genres). Any
 * other character there is the bin, as tubafrenzy's `substring(2, 3)` takes
 * it. Returns undefined for any code that is not `Z-` shaped.
 */
function legacyCompilationBin(codeLetters: string): string | null | undefined {
  const trimmed = codeLetters.trim();
  if (!trimmed.startsWith('Z-')) return undefined;
  const letter = trimmed[2];
  return letter && letter !== '-' ? letter.toUpperCase() : null;
}

/**
 * The artist half of a compilation's shelf locator (BS#2822): `V/A M` for
 * Rock, the bare `M` for Soundtracks, and `V/A` for every other genre or
 * when the slot has no section letter. Only Rock and Soundtracks are split
 * into letter bins, so only they ever look for one -- the same genre gate
 * tubafrenzy's `ArtistLibraryCode` applies, kept here so the renderer does not
 * depend on which genres happen to carry a letter. The letter is the
 * structural `code_comp_letter` (BS#2837); the artist name is never read, so
 * a librarian rename cannot drop it. A legacy `Z-<letter>` code carries its
 * own letter and takes precedence.
 */
function compilationArtistHalf(codeLetters: string, compLetter: string | null, genre: string | null): string {
  if (genre !== 'Rock' && genre !== 'Soundtracks') return VARIOUS_ARTISTS_CODE_LETTERS;
  const legacy = legacyCompilationBin(codeLetters);
  const bin = legacy === undefined ? compLetter?.trim().toUpperCase() : legacy;
  if (!bin) return VARIOUS_ARTISTS_CODE_LETTERS;
  return genre === 'Soundtracks' ? bin : `${VARIOUS_ARTISTS_CODE_LETTERS} ${bin}`;
}

/**
 * The release half of a call number: `<ReleaseNum>`, plus `-<Letter>` when the
 * release carries a volume letter (BS#2827). Upper-cased at render time, as
 * tubafrenzy and dj-site do, so the stored case is irrelevant; a blank letter
 * renders no hyphen. Null when there is no release number -- a letter alone
 * names no shelf position.
 */
function releaseHalf(result: LibraryResult): string | null {
  if (result.codeNumber === null) return null;
  const volume = result.codeVolumeLetters?.trim().toUpperCase();
  return volume ? `${result.codeNumber}-${volume}` : String(result.codeNumber);
}

/**
 * Compute the call number from library result fields.
 *
 * A Various Artists compilation (BS#2822) renders in its shelf form,
 * matching LML#1427's `LibraryItem.call_number` character for character:
 * `<Genre> <Format> V/A-<ReleaseNum>` for a single-bin genre,
 * `Rock <Format> V/A <Bin>-<ReleaseNum>`, `Soundtracks <Format>
 * <Bin>-<ReleaseNum>`, and `V/A-<ReleaseNum>` when Rock/Soundtracks has no
 * recoverable bin -- never the `V/A 0/<n>` artist-number form. A null
 * `codeNumber` drops the release half and its hyphen.
 *
 * A named artist renders `<Letters> <ArtistNum>/<ReleaseNum>`. The release
 * half renders whether or not the artist number is present, matching LML
 * (BS#2827): `ST/3` with letters only, a bare `3` with neither. Either
 * shape takes the release's volume letter as a `-<Letter>` suffix.
 */
export function computeCallNumber(result: LibraryResult): string {
  const parts: string[] = [];
  if (result.genre) parts.push(result.genre);
  if (result.format) parts.push(result.format);
  const release = releaseHalf(result);
  if (result.codeLetters && isVariousArtists(result.codeLetters)) {
    const artistHalf = compilationArtistHalf(result.codeLetters, result.codeCompLetter, result.genre);
    parts.push(release !== null ? `${artistHalf}-${release}` : artistHalf);
    return parts.join(' ');
  }
  const artistHalf = [result.codeLetters?.toUpperCase(), result.codeArtistNumber]
    .filter((p) => p !== null && p !== '')
    .join(' ');
  if (release === null) {
    if (artistHalf) parts.push(artistHalf);
  } else {
    parts.push(artistHalf ? `${artistHalf}/${release}` : release);
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
  /**
   * BS#1089: true when every provider that came back with zero results did
   * so by throwing (LML timeout/5xx/network blip, or another provider-side
   * exception) rather than confirming an empty match. Distinguishes
   * "couldn't determine" from "confirmed no artwork" so a caller like the
   * `/proxy/artwork/search` negative cache doesn't treat a transient
   * upstream failure as a durable negative result. Absent (falsy) on a
   * genuine match or a confirmed-empty search — existing callers that don't
   * read this field see unchanged behavior.
   */
  errored?: boolean;
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
