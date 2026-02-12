/**
 * Time utilities for tests involving timestamps and expiration.
 */

export const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Returns current time in Unix seconds (not milliseconds).
 */
export const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Returns a Unix timestamp N days from now.
 * Positive values = future, negative values = past.
 */
export const daysFromNow = (days: number): number => nowInSeconds() + days * SECONDS_PER_DAY;

/**
 * Returns a Unix timestamp N hours from now.
 */
export const hoursFromNow = (hours: number): number => nowInSeconds() + hours * 60 * 60;
