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
