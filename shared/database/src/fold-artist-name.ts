/**
 * Unicode-form + diacritic + case fold for artist-name matching (BS#1897).
 *
 * TypeScript twin of the SQL function `wxyc_schema.fold_artist_name(text)`
 * defined in migration 0134. The catalog write-boundary matcher
 * (`artistIdFromName` in `apps/backend/services/library.service.ts`) and the
 * one-shot `jobs/artist-unicode-dedup` job both key on this fold, so this twin
 * MUST stay byte-identical to the SQL function. Drift surfaces as either a
 * missed match (a duplicate `artists` row inserted at add-album time) or a
 * mis-grouped dedup pass.
 *
 * The rule: normalize to NFD (canonical decomposition), strip the Combining
 * Diacritical Marks block (U+0300–U+036F), then lowercase. This collapses
 * three independent spellings of the same name onto one key:
 *
 *   1. Unicode composition form — `Nilüfer` NFC (`ü` = U+00FC) vs NFD
 *      (`u` + U+0308). PG `lower()` and JS `===` are collation-aware but NOT
 *      form-aware, so without this the two are byte-distinct and don't match.
 *   2. Diacritics — `Nilüfer` vs the ASCII-fold `Nilufer`. Decompose-then-strip
 *      removes the combining mark that distinguishes them.
 *   3. Case — via the trailing lowercase, preserving the existing matcher's
 *      case-insensitivity.
 *
 * Deliberately NARROWER than `normalizeArtistName`: it does NOT strip a leading
 * "The ". The fold is a strict superset of the pre-existing `lower()` matcher
 * (adds only form/diacritic insensitivity), so it must not newly collapse
 * "The Notwist" into "Notwist".
 *
 * The SQL function is `IMMUTABLE PARALLEL SAFE` and uses `coalesce(input, '')`
 * so it is total over NULL; this twin mirrors that by collapsing `null` /
 * `undefined` to `''`.
 *
 * Known engine-divergence caveat (documented, not reached by production data):
 * PG `lower()` is lc_ctype-dependent while JS `toLowerCase()` is locale-
 * independent Unicode default case folding. For the ASCII-after-strip output
 * this fold produces on Latin-script names, the two agree. Names that retain
 * non-ASCII letters with no combining-mark decomposition (e.g. dotless `ı`
 * U+0131, `ß`) could diverge between the twin and the SQL function — the
 * authoritative grouping key is always the SQL function; this twin is used for
 * in-memory dedup previews and unit tests over the canonical Latin names. The
 * unit test at `tests/unit/database/fold-artist-name.test.ts` pins the
 * contract; the SQL function must change with this file.
 */

// Combining Diacritical Marks block: U+0300–U+036F. Covers the accents in
// every WXYC-canonical diacritic name (diaeresis U+0308, acute U+0301, grave,
// tilde U+0303, cedilla U+0327, caron, etc.).
const COMBINING_DIACRITICAL_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export const foldArtistName = (input: string | null | undefined): string => {
  const coalesced = input ?? '';
  return coalesced.normalize('NFD').replace(COMBINING_DIACRITICAL_MARKS, '').toLowerCase();
};
