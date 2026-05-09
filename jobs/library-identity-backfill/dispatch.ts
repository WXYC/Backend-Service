/**
 * Pure dispatch helpers for the library-identity-backfill entrypoint.
 *
 * Lives in its own module so unit tests can import without triggering
 * `job.ts`'s top-level `void main()` side-effect.
 */

export type BackfillLeg = 'S1' | 'S2';

/**
 * Resolve the leg from the env var. Locked truthy values: `S1`, `S2`. Anything
 * else (including unset) defaults to `S1` to preserve sub-PR 2.0 behavior.
 *
 * Throws on malformed input rather than silently falling back so a typo
 * (e.g., `S3`, `s2`) doesn't accidentally run the wrong backfill against
 * prod. Operator gets a clear error at job start.
 */
export const resolveBackfillLeg = (raw: string | undefined = process.env.BACKFILL_LEG): BackfillLeg => {
  if (raw === undefined || raw === '') return 'S1';
  if (raw === 'S1' || raw === 'S2') return raw;
  throw new Error(`Invalid BACKFILL_LEG=${JSON.stringify(raw)}; must be 'S1' or 'S2'.`);
};
