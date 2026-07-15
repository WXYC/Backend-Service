import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

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
