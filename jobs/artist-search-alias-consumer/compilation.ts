/**
 * V/A compilation-artist detection.
 *
 * Vendored from `apps/backend/services/requestLine/matching/compilation.ts`
 * so this cron job's build graph stays decoupled from the long-running
 * @wxyc/backend Express app. Same isolation rationale as `logger.ts`,
 * `lml-fetch.ts`, and `lml-types.ts` — the Dockerfile only copies the
 * job directory + @wxyc/database; pulling in `apps/backend/services/...`
 * would either inflate the build context or fail to resolve in the
 * production stage.
 *
 * Keep in lockstep with the apps/backend source — both files must agree
 * on the keyword set or the orchestrator's V/A filter drifts from the
 * runtime catalog-search filter (`searchLibraryBothMode` and friends).
 */

/**
 * Keywords indicating a compilation/soundtrack album (case-insensitive substring match).
 */
export const COMPILATION_KEYWORDS = new Set(['various', 'soundtrack', 'compilation', 'v/a', 'v.a.']);

/**
 * Check if an artist name indicates a compilation/soundtrack album.
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
