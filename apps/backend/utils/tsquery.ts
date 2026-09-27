/**
 * Prefix-matching `tsquery` construction for catalog search (BS#670).
 *
 * ## Why not `websearch_to_tsquery`
 *
 * `websearch_to_tsquery('simple', 'autec')` lexes to the lexeme `autec`, and
 * Autechre's `search_doc` holds `autechre`. Two different lexemes, no overlap,
 * zero rows — so every partially-typed token (which is *every* keystroke before
 * the last one) missed the tsvector path entirely and fell through to the
 * trigram fallback. Measured on production: 11-232 ms on the fallback against
 * 3-5 ms for the prefix form, and the fallback's cost swings with how common
 * the letter combination is, so the typing path was paying the worst case.
 *
 * `:*` is Postgres's prefix-match operator, so `'autec':*` matches `autechre`
 * through the same `library_search_doc_idx` GIN index that already exists.
 *
 * ## Why this has to be built by hand
 *
 * `to_tsquery` takes a tsquery *expression*, not user text — it is the one
 * `*_to_tsquery` variant that does no input forgiving. Raw input reaches it as
 * syntax, so `&`, `|`, `!`, `(`, `)`, `<`, `>`, `:` and `*` are operators and an
 * unbalanced one raises rather than returning no rows. This builder is the
 * sanitizing layer: it neutralizes those metacharacters, quotes each token so
 * anything left is read as a literal lexeme, and appends `:*` per token.
 *
 * Note that quoting does not suppress tokenization — `'chuquimamani-condori':*`
 * expands to `'chuquimamani-condori':* <-> 'chuquimamani':* <-> 'condori':*`,
 * the adjacency query that matches how the `simple` config actually lexed the
 * name. That is why punctuation *inside* a token is preserved rather than
 * stripped: `M.A.N.D.Y.` is the single lexeme `m.a.n.d.y`, and five one-letter
 * tokens would match something else entirely.
 *
 * Multi-token input keeps the AND semantics `websearch_to_tsquery` provided, so
 * `stereolab transient` still narrows to the one album rather than returning the
 * discography.
 */

/**
 * The tsquery operator set, plus the backslash escape character. Replaced with
 * whitespace rather than deleted, so they act as the token separators a user
 * typing `Belle & Sebastian` means them to be — deleting would splice the
 * operands into one nonexistent lexeme (`bellesebastian`).
 */
const TSQUERY_METACHARACTERS = /[&|!()<>:*\\]/g;

/** A token contributes a lexeme only if it holds a letter or a digit. */
const HAS_LEXEME_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Build a prefix-matching tsquery expression from raw user text, or `null` when
 * the input cannot produce one.
 *
 * `null` means "skip the tsvector path" — not "match nothing". An empty tsquery
 * is legal in Postgres: it raises a `NOTICE: text-search query doesn't contain
 * lexemes` and then matches no rows, which would spend a query and a log line to
 * learn what this function already knows. The caller should fall through to the
 * trigram path, which is the one that can serve a `!!!` or `$$$` query at all.
 *
 * @param query Raw user query text.
 * @returns A `to_tsquery('simple', …)` argument, e.g. `'stereolab':* & 'transient':*`.
 */
export function buildPrefixTsquery(query: string): string | null {
  const tokens = query
    .replace(TSQUERY_METACHARACTERS, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && HAS_LEXEME_CHARACTER.test(token));

  if (tokens.length === 0) return null;

  // Double any apostrophe to escape it inside the quoted lexeme. Deliberately
  // not stripped: `D'Angelo` lexes to `'angelo' 'd'`, so the apostrophe is a
  // token boundary the parser needs — dropping it yields `dangelo`, which
  // matches nothing.
  return tokens.map((token) => `'${token.replace(/'/g, "''")}':*`).join(' & ');
}
