/**
 * Backfill-side LML resolve helper for jobs/rotation-lml-identity-backfill
 * (BS#1380).
 *
 * Delegates to `@wxyc/lml-client.resolveIdentity` (the wrapper introduced
 * alongside BS#1380; see shared/lml-client/src/index.ts) and injects:
 *   - a tighter per-call abort budget
 *     (`BACKFILL_LML_RESOLVE_TIMEOUT_MS`, default 8000 ms) so cold-tail
 *     identities that LML can't resolve quickly don't hold a serialized
 *     resolve slot for the runtime path's 2 s, and
 *   - the backfill's own concurrency + rate-limit gate via
 *     `defaultLmlLimiter` (BS#995 — strict BACKFILL_LML_* ceiling).
 *
 * `resolveIdentity` itself does NOT take a limiter today — it's a small,
 * single-purpose POST that the LML server caps internally. The limiter is
 * applied here at the wrapper layer so the BS-side back-pressure surfaces
 * at the same chokepoint shape as `lookupReleaseId` does in
 * `jobs/rotation-release-id-backfill/lml-fetch.ts`.
 *
 * Returns the LML identity_id (or null when LML's 422 rejected the input
 * — e.g. a sentinel `0` discogs id; the caller counts that as
 * `unresolved`). 4xx is the only "ran-cleanly-but-no-result" branch;
 * 5xx / timeout / network errors throw `LmlClientError` so the
 * orchestrator's catch arm bumps `lml_error` and leaves the row
 * untouched for next run.
 */

import { LmlClientError, resolveIdentity } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('BACKFILL_LML_RESOLVE_TIMEOUT_MS', 8000);

export const lookupIdentityId = async (discogsReleaseId: number): Promise<number | null> =>
  defaultLmlLimiter.run(async () => {
    try {
      const response = await resolveIdentity(
        {
          kind: 'release',
          source: 'discogs_release',
          external_id: String(discogsReleaseId),
        },
        { timeoutMs: TIMEOUT_MS }
      );
      return response.identity_id;
    } catch (err) {
      // LML's 422 sentinel rejection ("Discogs id <= 0", malformed Bandcamp
      // URL, etc.) is "ran cleanly, no row to point at" — surfaces to the
      // orchestrator as `unresolved`, not `lml_error`. Network / timeout /
      // 5xx all rethrow so the orchestrator's catch arm leaves the row
      // retryable.
      if (err instanceof LmlClientError && err.statusCode === 422) {
        return null;
      }
      throw err;
    }
  });
