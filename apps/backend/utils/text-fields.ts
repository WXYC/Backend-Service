import WxycError from './error.js';

/** Unicode-code-point length, matching OpenAPI `maxLength` semantics (a UTF-16 `.length` over-counts astral characters). */
export function codePointLength(value: string): number {
  return [...value].length;
}

/** `true` only for a string with at least one non-whitespace character. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate one optional free-text body field: must be a string, must not be
 * blank after trimming, must fit the column. Returns the trimmed value.
 *
 * The three `rotation` snapshot columns and `updateAlbum`'s `album_title`
 * all sit on `varchar(128)` and all want the identical trim / non-empty /
 * max-length shape; over-length input is rejected as a 400 here rather than
 * reaching the UPDATE and tripping PG 22001 ("value too long") → 500.
 * Callers pass their own limit so a future wider column doesn't have to
 * fork the helper.
 */
export const validateTextField = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WxycError(`${field} must be a non-empty string`, 400);
  }
  const trimmed = value.trim();
  // Code points, not UTF-16 units — `codePointLength`, not `.length`. Postgres
  // measures `varchar(n)` in characters, so a bare `.length` counts every
  // astral character (emoji, CJK Ext-B) twice and rejects values PG would
  // store happily. `addRotation` already measures these same three columns
  // that way; using `.length` here made a 128-code-point `album_title`
  // creatable via POST and un-editable via PATCH — a row you cannot fix a
  // typo in without first shortening a legal title.
  if (codePointLength(trimmed) > maxLength) {
    throw new WxycError(`${field} must be ${maxLength} characters or fewer`, 400);
  }
  return trimmed;
};

/**
 * BS#2004: `album_artist` is the credited artist on a compilation card
 * ("Kruder & Dorfmeister" on a DJ-Kicks release filed under Various Artists).
 * Nullable, optional, `varchar(128)`. Shared by POST and PATCH so the two
 * write verbs cannot disagree on trimming or bounds.
 *
 * Also backs `alternate_artist_name`'s PATCH bound (BS#2004 review): that
 * field measured length with `.length` (UTF-16 units) while the rest of this
 * file uses `codePointLength` — the unit Postgres `varchar(n)` actually counts
 * — so an astral-heavy value Postgres would store was wrongly rejected.
 * Routing it here removes the divergence. (POST still writes
 * `alternate_artist_name` raw; that pre-existing gap is separate.)
 *
 * `undefined` means "not supplied": on a create the column takes its default,
 * on a PATCH the stored value is left alone (`updateAlbumInDB` only SETs keys
 * `!== undefined`). `null` and `''` both mean "clear it" and normalize to
 * `null`, so a client round-tripping a GET body can send back what it got.
 */
export const normalizeOptionalText = (value: unknown, field: string, maxLength: number): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value !== null && typeof value !== 'string') {
    throw new WxycError(`${field} must be a string or null`, 400);
  }
  const trimmed = value?.trim() || null;
  if (trimmed !== null && codePointLength(trimmed) > maxLength) {
    throw new WxycError(`${field} must be ${maxLength} characters or fewer`, 400);
  }
  return trimmed;
};
