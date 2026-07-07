/**
 * Canonical artist-name normalization. TypeScript twin of the SQL function
 * `wxyc_schema.normalize_artist_name(text)` defined in migration 0092
 * (BS#1372).
 *
 * The single source-of-truth rule: lowercase, then strip a leading
 * "The " prefix (case-insensitive). The separator class is intentionally
 * narrow — ASCII space, tab, newline, carriage return, form feed,
 * vertical tab — matching POSIX `[ \t\n\r\f\v]`. Both JS `\s` and PG
 * `\s` would diverge on Unicode whitespace (NBSP U+00A0, narrow no-break
 * U+202F, etc.) because PG's POSIX `\s` only matches ASCII whitespace
 * while JS's `\s` matches the full Unicode whitespace class. We use the
 * explicit char class on both sides so the twin's contract is
 * byte-identical regardless of regex-engine differences.
 *
 * Upstream scrapers (`jobs/venue-events-scraper/parse.ts`) already
 * decode `&nbsp;` to ASCII space and `.trim()` raw names, so NBSP
 * separators don't reach this function in production. A `headlining_
 * artist_raw` that still carries non-ASCII whitespace (e.g. raw U+00A0
 * embedded in JSON-LD) won't get its "The " stripped — that's a known
 * limitation; document upstream rather than expand the class here.
 *
 * The SQL function is `IMMUTABLE PARALLEL SAFE` and uses
 * `coalesce(input, '')` so it is total over `NULL` input; this JS twin
 * mirrors that by collapsing `null` and `undefined` to `''`.
 *
 * Drift between this twin and the SQL function surfaces as silent
 * `headlining_artist_id IS NULL` rows that look like no-match but are
 * actually mismatch-on-normalization. The unit test at
 * `tests/unit/database/normalize-artist-name.test.ts` pins the table of
 * inputs and outputs; the SQL function must change with this file.
 */
export const normalizeArtistName = (input: string | null | undefined): string => {
  const coalesced = input ?? '';
  return coalesced.replace(/^the[ \t\n\r\f\v]+/i, '').toLowerCase();
};
