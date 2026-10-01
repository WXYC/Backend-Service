/**
 * Parameterized unit tests for `isBudgetRelativeDegradation` (BS#2528).
 *
 * `LmlLookupCoordinator` (`apps/backend/services/lml/lookup-coordinator.ts`)
 * uses this predicate to decide whether a `LookupResponse`'s outcome depends
 * on the CALLING request's own budget -- a short-budget caller's deadline
 * exhausted, or LML's own hard cap firing mid-search -- as opposed to LML's
 * own load (`upstream_unavailable`, `cache_only`), which is equally true for
 * every caller and stays cacheable. These cases mirror the coordinator's
 * admission-rule table in `tests/unit/services/lml/lookup-coordinator.test.ts`,
 * verifying the predicate itself rather than its effect on the cache.
 */
import { isBudgetRelativeDegradation, type LookupResponse } from '@wxyc/lml-client';

function response(overrides: Partial<LookupResponse>): LookupResponse {
  return {
    results: [],
    search_type: 'none',
    song_not_found: false,
    found_on_compilation: false,
    timeout: false,
    degraded: false,
    ...overrides,
  };
}

const matchedResult: LookupResponse['results'][number] = {
  library_item: { id: 12345, title: 'DOGA', artist: 'Juana Molina', call_number: 'Rock CD JUA 1/2' },
};

describe('isBudgetRelativeDegradation (BS#2528)', () => {
  it.each<{ name: string; input: LookupResponse; expected: boolean }>([
    {
      name: 'degraded: true, degraded_reason: deadline_exceeded -- budget-relative',
      input: response({ degraded: true, degraded_reason: 'deadline_exceeded' }),
      expected: true,
    },
    {
      name: 'timeout: true, degraded: false -- budget-relative',
      input: response({ timeout: true }),
      expected: true,
    },
    {
      name: 'timeout: true with non-empty results -- still budget-relative regardless of results',
      input: response({ timeout: true, results: [matchedResult] }),
      expected: true,
    },
    {
      name: 'degraded_reason: upstream_unavailable -- allow-listed, not budget-relative',
      input: response({ degraded: true, degraded_reason: 'upstream_unavailable' }),
      expected: false,
    },
    {
      name: 'degraded_reason: cache_only -- allow-listed, not budget-relative',
      input: response({ degraded: true, degraded_reason: 'cache_only' }),
      expected: false,
    },
    {
      name: 'unrecognized degraded_reason outside the current union -- fail-safe, budget-relative',
      input: response({
        degraded: true,
        degraded_reason: 'future_reason' as unknown as LookupResponse['degraded_reason'],
      }),
      expected: true,
    },
    {
      name: 'plain non-degraded, non-timeout reply -- not budget-relative',
      input: response({}),
      expected: false,
    },
  ])('$name', ({ input, expected }) => {
    expect(isBudgetRelativeDegradation(input)).toBe(expected);
  });
});
