import WxycError from './error.js';

/** Width of the `varchar(128)` library text columns (`album_title`, `label`, `alternate_artist_name`, `album_artist`) and `labels.label_name`. */
export const MAX_ALBUM_TEXT_LENGTH = 128;

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
 * Normalize one optional, nullable free-text field (first callers: BS#2004's
 * `album_artist` and `alternate_artist_name`). Shared by POST and PATCH so the
 * two write verbs cannot disagree on trimming or bounds.
 *
 * - `undefined` means "not supplied": a create takes the column default, a
 *   PATCH leaves the stored value alone.
 * - `null`, `''` and whitespace-only all mean "clear it" and come back as `null`,
 *   so a client round-tripping a GET body can send back what it got.
 * - Anything else is trimmed and may be at most `maxLength` code points.
 *
 * Non-strings (other than `null`) are a 400.
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
