/**
 * Confidence scoring for search result matching.
 *
 * Ported from request-parser core/matching.py
 */

/**
 * Normalize a string for comparison (lowercase, trimmed).
 */
function normalize(s: string | null | undefined): string {
  return s ? s.toLowerCase().trim() : '';
}

/**
 * Calculate confidence score for how well a search result matches a request.
 *
 * Scoring rules:
 * - Exact artist match: +0.4
 * - Partial artist match (substring): +0.3
 * - Exact album match: +0.4
 * - Partial album match (substring): +0.3
 * - Both fields match well (score >= 0.6): +0.2 bonus
 * - Minimum score for any result: 0.2
 *
 * @param requestArtist - Artist from the search request
 * @param requestAlbum - Album from the search request
 * @param resultArtist - Artist from the search result
 * @param resultAlbum - Album from the search result
 * @returns Confidence score between 0.2 and 1.0
 */
export function calculateConfidence(
  requestArtist: string | null | undefined,
  requestAlbum: string | null | undefined,
  resultArtist: string,
  resultAlbum: string
): number {
  let score = 0.0;

  const reqArtist = normalize(requestArtist);
  const reqAlbum = normalize(requestAlbum);
  const resArtist = normalize(resultArtist);
  const resAlbum = normalize(resultAlbum);

  // Artist match
  if (reqArtist && resArtist) {
    if (reqArtist === resArtist) {
      score += 0.4;
    } else if (reqArtist.includes(resArtist) || resArtist.includes(reqArtist)) {
      score += 0.3;
    }
  }

  // Album match
  if (reqAlbum && resAlbum) {
    if (reqAlbum === resAlbum) {
      score += 0.4;
    } else if (reqAlbum.includes(resAlbum) || resAlbum.includes(reqAlbum)) {
      score += 0.3;
    }
  }

  // Bonus for both matches
  if (score >= 0.6) {
    score += 0.2;
  }

  // Base score if we got any result
  if (score === 0) {
    score = 0.2;
  }

  return Math.min(score, 1.0);
}
