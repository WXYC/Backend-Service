import { INT4_MAX } from './constants.js';
import WxycError from './error.js';

/**
 * Parse a positive-integer query param behind an all-digits guard.
 *
 * A bare `parseInt` would accept `'1abc'` → 1 and `'0x10'` → 16; requiring the
 * raw value to be all digits (and using an explicit radix) rejects both. The
 * `< 1` rejection makes the name honest — `'0'` is all-digits but not positive
 * — so **callers need no follow-up check**, which is the whole reason this
 * lives here rather than in a controller.
 *
 * It was previously a private const in `concerts.controller.ts`. The second
 * paginated read (`album-reviews.controller.ts`) copied it and dropped the
 * `< 1` branch, then re-added the bound at three call sites — leaving two
 * same-named helpers that disagreed about `'0'`. Shared so the third one
 * cannot fork it again.
 *
 * Throws `WxycError(400)` on malformed input; the message names the field so
 * the caller does not have to.
 */
export const parsePositiveInt = (raw: string, field: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new WxycError(`${field} must be a positive integer`, 400);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) {
    throw new WxycError(`${field} must be a positive integer`, 400);
  }
  return parsed;
};

/**
 * Parse a path-parameter id for an int4 `serial` column: a positive integer no
 * larger than `INT4_MAX`, else the 400 that keeps a malformed URL from reaching
 * Postgres (past int4 the lookup would be a 22003 → 500). The message is
 * neutral on purpose — "must be a positive integer" would be false for 2147483648.
 */
export const parseInt4PathId = (raw: string, resource: string): number => {
  if (!/^\d+$/.test(raw)) throw new WxycError(`Invalid ${resource} id`, 400);
  const id = Number.parseInt(raw, 10);
  if (id < 1 || id > INT4_MAX) throw new WxycError(`Invalid ${resource} id`, 400);
  return id;
};

/**
 * Parse an id from a JSON body for an int4 column: `undefined` (key not supplied) passes through, `null` passes
 * only when `nullable`, anything else must be an integer from 1 to `INT4_MAX` — no string coercion, so a JSON `"5"`
 * is a 400. Past int4 the write would be a 22003 → 500.
 */
export function parseInt4BodyId(value: unknown, field: string, opts: { nullable: true }): number | null | undefined;
export function parseInt4BodyId(value: unknown, field: string, opts?: { nullable?: false }): number | undefined;
export function parseInt4BodyId(
  value: unknown,
  field: string,
  opts?: { nullable?: boolean }
): number | null | undefined;
export function parseInt4BodyId(value: unknown, field: string, opts: { nullable?: boolean } = {}) {
  if (value === undefined) return undefined;
  if (value === null && opts.nullable) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > INT4_MAX) {
    throw new WxycError(`${field} must be a positive integer${opts.nullable ? ' or null' : ''}`, 400);
  }
  return value as number;
}

/**
 * Parse an int4 id from a query string: `undefined` passes through, a repeated key (Express hands over a
 * `string[]`) is a 400, otherwise all digits and 1..`INT4_MAX`. The message is neutral on purpose — "positive
 * integer" would be false for 2147483648. See `parsePositiveInt` for why a bare `parseInt` is not enough.
 */
export const parseInt4QueryParam = (raw: unknown, field: string): number | undefined => {
  if (raw === undefined) return undefined;
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!(id >= 1 && id <= INT4_MAX)) throw new WxycError(`${field} must be an integer from 1 to 2147483647`, 400);
  return id;
};

/**
 * Parse a strict boolean query param: absent or `'false'` is false, `'true'` is true, and anything else — `'TRUE'`,
 * `'1'`, `''`, or a repeated key (which arrives as an array) — is a 400 naming the field.
 */
export const parseBooleanQueryParam = (raw: unknown, field: string): boolean => {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new WxycError(`${field} must be true or false`, 400);
};

/**
 * Parse an optional non-negative-integer query parameter or path segment.
 * Returns `undefined` when absent, `null` when present but not a well-formed
 * non-negative integer (the caller turns that into a 400). Strict — unlike
 * `parseInt`, `'42abc'` and `'4.5'` are rejected rather than silently
 * truncated to `42` and `4`.
 */
export function parseNonNegativeInt(raw: unknown): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse the `:rotation_id` path segment: a strict (all-digits) positive integer no larger than `INT4_MAX`, else the
 * 400 that keeps a malformed URL from reaching Postgres. Strict, not `parseInt`: `parseInt('42abc', 10)` is 42, which
 * would let `/library/rotation/42abc/link` mutate rotation 42. Shared by every rotation_id route so a hardening
 * lands once.
 */
export const parseRotationIdParam = (raw: unknown): number => {
  const rotationId = parseNonNegativeInt(raw);
  if (rotationId == null || rotationId <= 0 || rotationId > INT4_MAX) {
    throw new WxycError('rotation_id must be a positive integer', 400);
  }
  return rotationId;
};

/**
 * Parse an optional `limit` (1…`maxLimit`) and `offset` (>= 0) pair, throwing the 400 for a malformed or
 * out-of-range value. Absent values come back `undefined` — the default is the query's, not the caller's.
 */
export const parseLimitOffset = (
  rawLimit: unknown,
  rawOffset: unknown,
  maxLimit: number
): { limit: number | undefined; offset: number | undefined } => {
  const limit = parseNonNegativeInt(rawLimit);
  if (limit === null || (limit !== undefined && (limit < 1 || limit > maxLimit))) {
    throw new WxycError(`Invalid Parameter: limit must be an integer between 1 and ${maxLimit}`, 400);
  }

  const offset = parseNonNegativeInt(rawOffset);
  if (offset === null) {
    throw new WxycError('Invalid Parameter: offset must be a non-negative integer', 400);
  }

  return { limit, offset };
};

/**
 * Parses one required integer query parameter, bounded on both ends. The
 * upper bound is the int4 guard described at `INT4_MAX`; the lower bound
 * differs per parameter, so it is passed in.
 *
 * Callers are not listed here: they include the controller's optional wrapper
 * (`parseOptionalCodeQueryInt`), which passes `undefined` through before
 * delegating here, so the absent-vs-blank contract (BS#2637) is shared by every
 * caller. Grep for the name before changing the `undefined` or blank handling.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, so a present-but-empty parameter
 * (`?code_number=`) would sail through `Number.isInteger` as a legitimate
 * zero — which matters now that 0 is a valid `code_number`. Blank is therefore
 * coerced to NaN so it folds into the single range check below.
 */
export const parseCodeQueryInt = (raw: string | undefined, name: string, min: number): number => {
  // Both `resolveArtistByCode` call sites reached this with a value already,
  // so the branch was historically unreachable for `undefined` -- but by two
  // different mechanisms, and only one is that handler's "Missing query
  // parameters" 400. `code_number` is deliberately excluded from that 400
  // (BS#2489: absent, it selects the browse), so what kept THAT call site
  // from passing `undefined` is the browse early return, not a required-
  // parameter check. Do not "align" the browse branch to throw. `peekArtistReleaseNumber`
  // has no such pre-check, so an omitted `genre_id` reaches this function
  // directly -- distinguish that from the repeated-key case below, or an
  // absent parameter misdiagnoses as a repeated one.
  if (raw === undefined) {
    throw new WxycError(`Missing query parameter: ${name}`, 400);
  }
  // Express's `simple` query parser yields string[] for repeated keys
  // (`?genre_id=1&genre_id=2`), which `Number()` would collapse to NaN with a
  // misleading message; name the real problem instead.
  if (typeof raw !== 'string') {
    throw new WxycError(`Invalid ${name}: must be a single value`, 400);
  }
  // Blank folds into the range check rather than throwing the identical
  // message from its own branch: `Number('')` and `Number(' ')` are both 0,
  // which would sail through `Number.isInteger` as a legitimate zero now that
  // 0 is a valid `code_number`. Coercing blank to NaN first makes one
  // comparison cover both cases.
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < min || value > INT4_MAX) {
    throw new WxycError(`Invalid ${name}: must be an integer between ${min} and ${INT4_MAX}`, 400);
  }
  return value;
};

/**
 * Parse a bounded positive-integer query parameter.
 *
 * Rejects anything that isn't a bare integer rather than letting `parseInt`'s
 * prefix parsing turn `"24h"` into `24` — an operator who mistypes the unit
 * should learn that, not silently get a different window than they asked for.
 * Out-of-range is a 400 too, never a silent clamp, for the same reason.
 */
export const parseBoundedInt = (raw: string | undefined, name: string, fallback: number, max: number): number => {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new WxycError(`Bad Request: ${name} must be a positive integer`, 400);
  }
  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > max) {
    throw new WxycError(`Bad Request: ${name} must be between 1 and ${max}`, 400);
  }
  return value;
};
