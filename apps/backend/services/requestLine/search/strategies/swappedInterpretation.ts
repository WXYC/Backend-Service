/**
 * Swapped Interpretation search strategy.
 *
 * For ambiguous "X - Y" formats, tries both:
 * - X as artist, Y as title
 * - Y as artist, X as title
 *
 * Ported from request-parser routers/request.py search_with_alternative_interpretation()
 */

import { ParsedRequest, EnrichedLibraryResult, SearchState, SearchStrategyType } from '../../types.js';
import { searchLibrary, filterResultsByArtist } from '../../../library.service.js';
import { detectAmbiguousFormat, MAX_SEARCH_RESULTS } from '../../matching/index.js';

/**
 * Check if this strategy should run.
 */
export function shouldRunSwappedInterpretation(
  _parsed: ParsedRequest,
  state: SearchState,
  rawMessage: string
): boolean {
  // Only run if no results yet AND message has ambiguous X - Y format
  if (state.results.length > 0) {
    return false;
  }
  return detectAmbiguousFormat(rawMessage) !== null;
}

/**
 * Execute the swapped interpretation search strategy.
 */
export async function executeSwappedInterpretation(
  rawMessage: string
): Promise<EnrichedLibraryResult[]> {
  const parts = detectAmbiguousFormat(rawMessage);
  if (!parts) {
    return [];
  }

  const { part1, part2 } = parts;

  // Try interpretation 1: part1 = artist
  const query1 = `${part1} ${part2}`;
  const results1 = await searchLibrary(query1, undefined, undefined, MAX_SEARCH_RESULTS);
  const filtered1 = filterResultsByArtist(results1, part1);

  // Try interpretation 2: part2 = artist
  const query2 = `${part2} ${part1}`;
  const results2 = await searchLibrary(query2, undefined, undefined, MAX_SEARCH_RESULTS);
  const filtered2 = filterResultsByArtist(results2, part2);

  // Return whichever has results (prefer the one with more/better matches)
  if (filtered1.length > 0 && filtered2.length === 0) {
    console.log(`[Search] Alternative search matched with '${part1}' as artist`);
    return filtered1;
  } else if (filtered2.length > 0 && filtered1.length === 0) {
    console.log(`[Search] Alternative search matched with '${part2}' as artist`);
    return filtered2;
  } else if (filtered1.length > 0 && filtered2.length > 0) {
    // Both have results - combine and dedupe by id
    console.log(`[Search] Alternative search matched both interpretations, combining results`);
    const seenIds = new Set<number>();
    const combined: EnrichedLibraryResult[] = [];
    for (const item of [...filtered1, ...filtered2]) {
      if (!seenIds.has(item.id)) {
        combined.push(item);
        seenIds.add(item.id);
      }
    }
    return combined.slice(0, MAX_SEARCH_RESULTS);
  }

  return [];
}
