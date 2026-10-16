import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { foldArtistName } from '@wxyc/database';

// Schema-qualified reference to the `fold_artist_name(text)` SQL function
// (migration 0134 / BS#1897). Derived from `WXYC_SCHEMA_NAME` the same way the
// `@wxyc/database` `pgSchema` object and the job SQL builders are, so the
// per-worker test-isolation schema resolves correctly. `""`-escaped for the
// (theoretical) quoted-identifier case, mirroring `worklist.ts`.
const FOLD_SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
export const FOLD_ARTIST_NAME_FN = sql.raw(`"${FOLD_SCHEMA}"."fold_artist_name"`);

/**
 * Escape the LIKE/ILIKE metacharacters (`%`, `_`) and the escape character
 * itself (`\`) in user-supplied text so that it is matched literally rather
 * than being silently reinterpreted as a wildcard pattern.
 *
 * This is a correctness fix, not an injection fix — Drizzle's `sql` tag already
 * parameterizes the value, so `%`/`_` can never break out of the string. But an
 * unescaped `%` still turns `suggestArtists("a%")` into "every artist starting
 * with a", and an unescaped `_` turns a short label query into a table scan.
 *
 * The backslash is escaped first (implicitly, by including it in the character
 * class) so that a literal `\` in the input can't combine with a following
 * metacharacter. Pair the result with an explicit `ESCAPE '\'` clause on the
 * ILIKE — see {@link ilikeEscaped}. (Postgres already defaults the LIKE escape
 * character to backslash, but stating it keeps the intent legible.)
 */
export const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Wildcard placement for {@link ilikeEscaped}. */
export type LikeWrap =
  /** `value%` — starts-with (autocomplete prefix). */
  | 'prefix'
  /** `%value` — ends-with. */
  | 'suffix'
  /** `%value%` — substring search (default). */
  | 'contains'
  /** `value` — whole-value match, still case-insensitive. */
  | 'exact';

/**
 * Build a case-insensitive `ILIKE` predicate whose right-hand pattern treats
 * the caller's user-supplied `value` literally: metacharacters are escaped
 * (see {@link escapeLikePattern}) and an explicit `ESCAPE '\'` clause is
 * attached so the escaping is honored regardless of server defaults.
 *
 * `column` may be a Drizzle column or any `sql` fragment.
 */
export function ilikeEscaped(column: SQLWrapper, value: string, wrap: LikeWrap = 'contains'): SQL {
  const escaped = escapeLikePattern(value);
  const pattern =
    wrap === 'prefix'
      ? `${escaped}%`
      : wrap === 'suffix'
        ? `%${escaped}`
        : wrap === 'contains'
          ? `%${escaped}%`
          : escaped;
  return sql`${column} ILIKE ${pattern} ESCAPE '\\'`;
}

/**
 * Build a case-, diacritic-, and Unicode-form-insensitive starts-with predicate
 * on an artist-name `column` (BS#2023): `fold_artist_name(column) LIKE
 * (fold_artist_name(<value>) || '%')`. The fold is the one the write boundary
 * keys on (`artistIdFromName`), so `Nilufer` finds `Nilüfer Yanya` and read and
 * write agree on artist identity.
 *
 * The value is folded in SQL, by the same function that folds the column, not
 * with the TypeScript twin: the twin's `toLowerCase` applies the Greek
 * final-sigma rule (`'ΑΣ'` -> `'ας'`) while PG `lower()` maps each `Σ` to `σ`,
 * so a TS-folded pattern would never match the stored fold of `Αστρονομία`.
 * The value is LIKE-escaped BEFORE the SQL fold, which is safe because the fold
 * (NFD, mark strip, `lower()`) never changes `\`, `%` or `_`; they stay literal.
 * The pattern is an immutable function of a bound parameter, so the planner
 * folds it to a constant in a custom plan and the index below is still used.
 *
 * The left side must stay the bare fold call: that exact expression is what the
 * `text_pattern_ops` index `artists_fold_name_prefix_idx` (migration 0195)
 * serves for prefix LIKE. `column` should be `artists.artist_name`.
 */
export function foldedPrefixLike(column: SQLWrapper, value: string): SQL {
  const escaped = escapeLikePattern(value);
  return sql`${FOLD_ARTIST_NAME_FN}(${column}) LIKE (${FOLD_ARTIST_NAME_FN}(${escaped}::text) || '%') ESCAPE '\\'`;
}

/**
 * Length of `value` after the artist-name fold ({@link foldedPrefixLike}'s
 * pattern body, computed here with the TypeScript twin; the final-sigma
 * divergence never changes the length). Callers enforce their minimum-query-length floor on THIS, not
 * on the raw string: the fold strips combining marks, so a query of only marks
 * folds to `''` (which would become the match-everything pattern `%`) and
 * `e` + U+0301 folds from length 2 to 1.
 */
export function foldedQueryLength(value: string): number {
  return foldArtistName(value).length;
}
