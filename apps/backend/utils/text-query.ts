/**
 * A query has at least one alphanumeric character. Pure punctuation skips both
 * search paths. Unicode-aware (`\p{L}`/`\p{N}`) on purpose: it answers "is this
 * worth running at all", not "which of two working paths should it take". Two
 * callers today: `apps/backend/services/library.service.ts`'s catalog search
 * gates (`searchLibraryBothMode`, `searchLibraryByCTARaw`), and
 * `buildPrefixTsquery` (`apps/backend/utils/tsquery.ts`), which uses it to
 * filter tokens.
 *
 * Deliberately NOT the same predicate as `shouldUseTsvector`
 * (`apps/backend/services/search.service.ts`), which is ASCII-only
 * (`/[a-zA-Z0-9]/`) and answers the second question for the flowsheet
 * surface — see that function's docstring for why the two stay unaligned
 * (WXYC/Backend-Service#2739). Do not "fix" the flowsheet function to match
 * this one; that is a live-surface behavior change, not a tidy-up.
 */
export function hasAlphanumeric(query: string): boolean {
  return /[\p{L}\p{N}]/u.test(query);
}
