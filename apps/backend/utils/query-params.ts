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
