/**
 * Data transformers for the rotation ETL.
 *
 * Maps tubafrenzy rotation release data to Backend-Service schema.
 * All functions are pure (no side effects) for easy testing.
 */

import { epochMsToDate } from '@wxyc/database';

const VALID_ROTATION_BINS = new Set(['S', 'L', 'M', 'H', 'N']);

/**
 * Validate and normalize a tubafrenzy ROTATION_TYPE value.
 * Returns the value if valid, or 'N' (New) as a fallback for unknown types.
 */
export const mapRotationType = (rotationType: string): 'S' | 'L' | 'M' | 'H' | 'N' => {
  const normalized = rotationType.trim().toUpperCase();
  return VALID_ROTATION_BINS.has(normalized) ? (normalized as 'S' | 'L' | 'M' | 'H' | 'N') : 'N';
};

/**
 * Convert an epoch milliseconds value to a YYYY-MM-DD date string.
 * Returns null for 0 (tubafrenzy uses 0 for "not set") or invalid values.
 */
export const epochMsToDateString = (epochMs: number): string | null => {
  const date = epochMsToDate(epochMs);
  if (!date) return null;
  return date.toISOString().split('T')[0];
};
