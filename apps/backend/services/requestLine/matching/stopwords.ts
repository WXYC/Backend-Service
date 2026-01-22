/**
 * Stopwords - words to exclude when extracting significant keywords from search queries.
 *
 * Ported from request-parser core/matching.py
 */

export const STOPWORDS = new Set([
  // Articles
  'the',
  'a',
  'an',
  // Conjunctions/prepositions
  'and',
  'with',
  'from',
  // Demonstratives
  'that',
  'this',
  // Request-specific noise
  'play',
  'song',
  'remix',
  // Label/format noise
  'story',
  'records',
]);

/**
 * Extract significant words from a query string.
 * Removes stopwords and words with length <= 1.
 */
export function extractSignificantWords(query: string, minLength = 2): string[] {
  // Normalize: remove special chars, keep only alphanumeric and spaces
  const normalized = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = normalized.split(/\s+/).filter((w) => w.length > 0);

  // Remove stopwords that might cause mismatches
  const significant = words.filter((w) => !STOPWORDS.has(w) && w.length >= minLength);

  // If we removed all words, use original words
  if (significant.length === 0) {
    return words.filter((w) => w.length >= minLength);
  }

  return significant;
}
