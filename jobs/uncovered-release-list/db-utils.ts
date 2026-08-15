/**
 * Tiny shared helper for uncovered-release-list's raw-SQL modules
 * (rotation.ts, antijoin.ts). Both issue `db.execute(sql\`...\`)` reads and
 * need the same driver-shape normalization `jobs/album-critic-reviews-etl/
 * antijoin.ts` documents inline — factored out here instead of duplicated
 * twice within this job, unlike the sibling (which only has one call site).
 */

/** Normalize `db.execute` results across drizzle driver shapes
 *  (postgres-js returns an array; node-postgres `{ rows }`). */
export const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error('uncovered-release-list: unrecognized db.execute() result shape');
};
