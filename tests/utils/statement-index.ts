/**
 * Finds the index of a source-code STATEMENT within a file's text, anchored
 * at the start of a line (after optional leading whitespace) so it cannot
 * match the same text quoted inside a comment. A comment line's first
 * non-space characters are `//`, which the anchor excludes; a bare
 * `String#indexOf`/`String#search` scan has no such guard and will happily
 * report the offset of a comment that merely cites the statement (see
 * BS#2537 / PR #2593, and the mount-order test this was extracted from).
 *
 * `mountPattern` is a regex FRAGMENT, not a literal string — any regex
 * metacharacters it contains (`(`, `)`, `.`, `[`, …) must already be escaped
 * by the caller, typically via `String.raw` over the literal source text.
 *
 * Returns -1 when no line-anchored match exists, matching
 * `String#indexOf`'s not-found convention so callers can keep using
 * `toBeGreaterThan(-1)`/`toBe(-1)` assertions unchanged.
 */
export function statementIndex(source: string, mountPattern: string): number {
  return source.search(new RegExp(`^\\s*${mountPattern}`, 'm'));
}
