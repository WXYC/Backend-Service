/**
 * Canonical artist-name normalization. TypeScript twin of the SQL function
 * `wxyc_schema.normalize_artist_name(text)` defined in migration 0092
 * (BS#1372).
 *
 * The single source-of-truth rule: lowercase, then strip a leading
 * "The " prefix (case-insensitive, any unicode whitespace separator).
 * This is the canonical form the concerts-artist-resolver uses to match
 * `concerts.headlining_artist_raw` against `artists.artist_name` and
 * `artist_search_alias.variant`. Any caller that wants to match a name
 * the same way the resolver does — iOS canonical-id matcher, dj-site
 * search, a sibling resolver — should normalize via this function (or
 * the SQL twin) rather than rolling its own rule.
 *
 * The SQL function is `IMMUTABLE PARALLEL SAFE` and uses
 * `coalesce(input, '')` so it is total over `NULL` input; this JS twin
 * mirrors that by collapsing `null` and `undefined` to `''`. The regex
 * `^the\s+` matches the SQL form `'^the\s+'` with the `'i'` flag, which
 * is case-insensitive POSIX regex behaviour in Postgres.
 *
 * Drift between this twin and the SQL function surfaces as silent
 * `headlining_artist_id IS NULL` rows that look like no-match but are
 * actually mismatch-on-normalization. The unit test at
 * `tests/unit/database/normalize-artist-name.test.ts` pins the table of
 * inputs and outputs; the SQL function must change with this file.
 */
export const normalizeArtistName = (input: string | null | undefined): string => {
  const coalesced = input ?? '';
  return coalesced.replace(/^the\s+/i, '').toLowerCase();
};
