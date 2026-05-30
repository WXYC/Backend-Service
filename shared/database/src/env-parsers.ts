/**
 * Shared integer-env parsers for jobs and services. Lifted from
 * `jobs/album-level-backfill/job.ts` so the throw-variant pattern
 * duplicated across `flowsheet-metadata-backfill` and
 * `flowsheet-artwork-repair` resolvers can collapse to one-liners.
 *
 * Both helpers treat `undefined` and the empty string as "unset" and
 * return the caller-supplied fallback. Anything else is validated as
 * an integer and either returned or thrown.
 */

export interface IntParserOptions {
  /** Bracketed context prepended to the error: `[ctx] Invalid ...`. */
  context?: string;
  /** Parenthesized unit appended after `integer`: `... integer (ms).`. */
  unit?: string;
  /** Trailing note appended after the period: `... integer. Use 0 to disable.`. */
  note?: string;
}

const formatIntError = (
  envName: string,
  raw: string,
  kind: 'positive' | 'non-negative',
  { context, unit, note }: IntParserOptions
): string => {
  const prefix = context ? `[${context}] ` : '';
  const unitPart = unit ? ` (${unit})` : '';
  const notePart = note ? ` ${note}` : '';
  return `${prefix}Invalid ${envName}=${JSON.stringify(raw)}: must be a ${kind} integer${unitPart}.${notePart}`;
};

export const requirePositiveInt = (
  raw: string | undefined,
  envName: string,
  fallback: number,
  opts: IntParserOptions = {}
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(formatIntError(envName, raw, 'positive', opts));
  }
  return n;
};

export const requireNonNegativeInt = (
  raw: string | undefined,
  envName: string,
  fallback: number,
  opts: IntParserOptions = {}
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(formatIntError(envName, raw, 'non-negative', opts));
  }
  return n;
};
