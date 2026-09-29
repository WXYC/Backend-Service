import { sql, type SQL } from 'drizzle-orm';

/**
 * Last-token prefix `tsquery` construction for catalog search (BS#670).
 *
 * ## Why not `websearch_to_tsquery`
 *
 * `websearch_to_tsquery('simple', 'autec')` lexes to the lexeme `autec`, and
 * Autechre's `search_doc` holds `autechre`. Two different lexemes, no
 * overlap, zero rows — so every partially-typed token (which is *every*
 * keystroke before the last one) missed the tsvector path entirely and fell
 * through to the trigram fallback. Measured on production: 11-232 ms on the
 * fallback against 3-5 ms for the prefix form, and the fallback's cost swings
 * with how common the letter combination is, so the typing path was paying
 * the worst case.
 *
 * `:*` is Postgres's prefix-match operator, so `'autec':*` matches
 * `autechre` through the same `library_search_doc_idx` GIN index that
 * already exists.
 *
 * ## Why only the LAST token is prefixed
 *
 * An earlier attempt (WXYC/Backend-Service#2709) suffixed `:*` on every
 * token. `ts_rank` is essentially constant under `:*` — it scores by
 * matching-lexeme count, and a prefix operand always "matches" — so
 * prefixing every token left the ranker with no text signal at all, and
 * `cat` ranked `Catherine Catapult / Cats` above `Cat Power`. Prefixing only
 * the token the DJ is *currently typing* — always the last one — keeps every
 * earlier, already-completed token an exact whole-lexeme match, so `ts_rank`
 * stays meaningful and a completed prefix (`stereolab`) still favors an exact
 * hit over a merely-prefixed one. See docs/adr/0015-catalog-search-query-operators.md
 * and `searchLibraryByTsvector`'s `match_tier` seam, which this builder feeds.
 *
 * ## Two tsqueries, one tokenization
 *
 * {@link buildPrefixTsquery} returns both halves of that seam from a single
 * pass over the input: `tsquery` (last token prefixed) drives the WHERE
 * predicate and the `ts_rank` score, and `exactTsquery` (no token prefixed —
 * every token an exact lexeme) drives only `match_tier`'s CASE, so a row that
 * matches on every token *exactly* outranks one that only matched the last
 * token as a prefix.
 *
 * ## Why this has to be built by hand
 *
 * `to_tsquery` takes a tsquery *expression*, not user text — it is the one
 * `*_to_tsquery` variant that does no input forgiving. Raw input reaches it
 * as syntax, so `&`, `|`, `!`, `(`, `)`, `<`, `>`, `:`, `*` and `"` are
 * operators and an unbalanced one raises rather than returning no rows. This
 * builder is the sanitizing layer: it neutralizes those metacharacters,
 * quotes each token so anything left is read as a literal lexeme, and
 * appends `:*` to the last token only.
 *
 * Note that quoting does not suppress tokenization — `'chuquimamani-condori':*`
 * expands to `'chuquimamani-condori':* <-> 'chuquimamani':* <-> 'condori':*`,
 * the adjacency query that matches how the `simple` config actually lexed the
 * name. That is why punctuation *inside* a token is preserved rather than
 * stripped: `M.A.N.D.Y.` is the single lexeme `m.a.n.d.y`, and five one-letter
 * tokens would match something else entirely.
 *
 * ## What this builder deliberately does NOT do (see ADR 0015)
 *
 * A leading `-` is not stripped and not treated as exclusion — quoting
 * already retires the operator (`to_tsquery` discards a leading `-` as a
 * blank when it re-lexes a quoted token), and stripping it is a no-op for a
 * letter-led token but *breaks* a digit-led one (`-3d` keeps its sign inside
 * a quoted lexeme and matching depends on that sign surviving). A bare `or`
 * is not disjunction — it is just another AND'd token. A `"quoted"` term is
 * not a tsquery phrase — the quote characters are sanitized away like any
 * other metacharacter, so `"cat power"` and `cat power` build identically.
 *
 * Multi-token input keeps the AND semantics `websearch_to_tsquery` provided,
 * so `stereolab transient` still narrows to the one album rather than
 * returning the discography.
 */

/**
 * The tsquery operator set, plus the backslash escape character and the
 * double quote. Replaced with whitespace rather than deleted, so they act as
 * the token separators a user typing `Belle & Sebastian` means them to be —
 * deleting would splice the operands into one nonexistent lexeme
 * (`bellesebastian`).
 *
 * `"` is included (ADR 0015): unstripped, an interior quote survives into the
 * quoted lexeme and the lexer treats it as its own separator, producing a
 * phrase adjacency (`'cat"power':*` → `'cat':* <-> 'power':*`) instead of the
 * AND `"cat power"` is supposed to build identically to `cat power`.
 *
 * `-` is deliberately NOT in this class. Splitting on every hyphen would
 * break interior compounds (`Chuquimamani-Condori`) that migration `0178`
 * bought a position gap specifically to keep matching — see ADR 0015.
 */
const TSQUERY_METACHARACTERS = /[&|!()<>:*\\"]/g;

/** A token contributes a lexeme only if it holds a letter or a digit. */
const HAS_LEXEME_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Ceiling on the number of whitespace-separated tokens AND'd together.
 *
 * This bounds the token count, not the query's cost. `to_tsquery` re-lexes
 * each quoted token, so one hyphen- or punctuation-joined token expands into
 * a `<->` chain of any length (`'a-b-c-d-e-f':*` is seven prefix operands).
 * A 1,500-part chain costs about 0.8 s on the 64,193-row clone, comparable to
 * `websearch_to_tsquery` on the same string, so the exposure predates this
 * builder. 16 tokens is generous for any real search phrase.
 */
const MAX_OPERANDS = 16;

/** The two tsqueries {@link buildPrefixTsquery} derives from one tokenization. */
export interface PrefixTsquery {
  /**
   * Every token an exact quoted lexeme except the last, which is suffixed
   * `:*`. Drives the WHERE predicate and the `ts_rank` score — it accepts
   * the row the DJ is still typing toward.
   */
  tsquery: SQL;
  /**
   * The same token list, quoted, with no `:*` anywhere. Drives only
   * `searchLibraryByTsvector`'s `match_tier` CASE — a row that matches this
   * matched every token as a complete word, not merely a prefix of one.
   */
  exactTsquery: SQL;
}

/**
 * Build a last-token prefix `tsquery` pair from raw user text, or `null`
 * when the input cannot produce one.
 *
 * `null` means "skip the tsvector path" — not "match nothing". An empty
 * tsquery is legal in Postgres: it raises a `NOTICE: text-search query
 * doesn't contain lexemes` and then matches no rows, which would spend a
 * query and a log line to learn what this function already knows. The
 * caller should fall through to the trigram path, which is the one that can
 * serve a `!!!` or `$$$` query at all.
 *
 * @param query Raw user query text.
 * @returns `{ tsquery, exactTsquery }`, or `null` if no token in `query`
 *   carries a letter or digit.
 */
export function buildPrefixTsquery(query: string): PrefixTsquery | null {
  const allTokens = query
    .replace(TSQUERY_METACHARACTERS, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && HAS_LEXEME_CHARACTER.test(token));

  if (allTokens.length === 0) return null;

  // Cap the operand count by dropping the EARLIEST tokens, never the latest.
  // The last token is always the one the DJ is currently typing and the only
  // one that gets `:*` — it must survive the cap, and keeping the most
  // recently typed tokens (over the earliest ones) is also the more useful
  // truncation for a query that has run on this long.
  const tokens = allTokens.length > MAX_OPERANDS ? allTokens.slice(allTokens.length - MAX_OPERANDS) : allTokens;

  // Double any apostrophe to escape it inside the quoted lexeme. Deliberately
  // not stripped: `D'Angelo` lexes to `'angelo' 'd'`, so the apostrophe is a
  // token boundary the parser needs — dropping it yields `dangelo`, which
  // matches nothing.
  const quote = (token: string) => `'${token.replace(/'/g, "''")}'`;

  const exactLexemes = tokens.map(quote);
  const prefixLexemes = exactLexemes.slice();
  prefixLexemes[prefixLexemes.length - 1] = `${prefixLexemes[prefixLexemes.length - 1]}:*`;

  const tsqueryExpr = prefixLexemes.join(' & ');
  const exactTsqueryExpr = exactLexemes.join(' & ');

  return {
    tsquery: sql`to_tsquery('simple', ${tsqueryExpr})`,
    exactTsquery: sql`to_tsquery('simple', ${exactTsqueryExpr})`,
  };
}
