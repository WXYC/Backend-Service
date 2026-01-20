/**
 * Ambiguous format detection for "X - Y" or "X. Y" patterns.
 *
 * Ported from request-parser core/matching.py
 */

/**
 * Result of detecting an ambiguous format.
 */
export interface AmbiguousParts {
  part1: string;
  part2: string;
}

/**
 * Detect if message has ambiguous 'X - Y' or 'X. Y' format.
 *
 * These formats are ambiguous because they could be interpreted as either:
 * - Artist: X, Title: Y
 * - Title: X, Artist: Y
 *
 * @param rawMessage - The original request message
 * @returns Object with part1 and part2 if ambiguous format detected, null otherwise
 */
export function detectAmbiguousFormat(rawMessage: string): AmbiguousParts | null {
  // Check for "X - Y" pattern (with spaces around dash)
  if (rawMessage.includes(' - ')) {
    const parts = rawMessage.split(' - ');
    if (parts.length >= 2) {
      const part1 = parts[0].trim();
      const part2 = parts.slice(1).join(' - ').trim();
      if (part1 && part2) {
        return { part1, part2 };
      }
    }
  }

  // Check for "X. Y" pattern (period followed by space)
  if (rawMessage.includes('. ')) {
    const parts = rawMessage.split('. ');
    if (parts.length >= 2) {
      const part1 = parts[0].trim();
      const part2 = parts.slice(1).join('. ').trim();
      if (part1 && part2) {
        return { part1, part2 };
      }
    }
  }

  return null;
}
