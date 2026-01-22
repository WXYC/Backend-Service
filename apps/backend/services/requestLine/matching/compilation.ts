/**
 * Compilation detection - keywords indicating compilation/soundtrack albums.
 *
 * Ported from request-parser core/matching.py
 */

/**
 * Keywords indicating a compilation/soundtrack album (case-insensitive substring match).
 */
export const COMPILATION_KEYWORDS = new Set([
  'various',
  'soundtrack',
  'compilation',
  'v/a',
  'v.a.',
]);

/**
 * Check if an artist name indicates a compilation/soundtrack album.
 *
 * @param artist - Artist name to check
 * @returns True if artist contains compilation keywords
 */
export function isCompilationArtist(artist: string | null | undefined): boolean {
  if (!artist) {
    return false;
  }
  const artistLower = artist.toLowerCase();
  for (const keyword of COMPILATION_KEYWORDS) {
    if (artistLower.includes(keyword)) {
      return true;
    }
  }
  return false;
}
