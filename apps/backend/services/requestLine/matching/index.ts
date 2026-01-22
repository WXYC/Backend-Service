/**
 * Barrel export for matching utilities.
 */

export { STOPWORDS, extractSignificantWords } from './stopwords.js';
export { COMPILATION_KEYWORDS, isCompilationArtist } from './compilation.js';
export { calculateConfidence } from './confidence.js';
export { detectAmbiguousFormat, type AmbiguousParts } from './ambiguous.js';

/**
 * Maximum number of results to return from search operations.
 */
export const MAX_SEARCH_RESULTS = 5;
