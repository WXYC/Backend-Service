/** A query has at least one alphanumeric character. Pure punctuation skips both search paths. */
export function hasAlphanumeric(query: string): boolean {
  return /[\p{L}\p{N}]/u.test(query);
}
