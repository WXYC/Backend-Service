/**
 * Parameterized unit tests for `isCallerRelativeDegradation` (BS#2528).
 *
 * `LmlLookupCoordinator` (`apps/backend/services/lml/lookup-coordinator.ts`)
 * uses this predicate to decide whether a `LookupResponse`'s outcome depends
 * on the CALLING request itself -- its own budget (`deadline_exceeded`, and
 * the caller-budget / spine-deadline sources of `timeout`), or which caller
 * class it belongs to (`cache_only`, which LML's admission shed returns only
 * to low-priority callers) -- as opposed to LML's own load
 * (`upstream_unavailable`), which is equally true for every caller and stays
 * cacheable. These cases mirror the coordinator's admission-rule table in
 * `tests/unit/services/lml/lookup-coordinator.test.ts`, verifying the
 * predicate itself rather than its effect on the cache.
 */
import { isCallerRelativeDegradation, type GatedLookupResponse, type LookupResponse } from '@wxyc/lml-client';

// `GatedLookupResponse extends LookupResponse`, so a `GatedLookupResponse`
// value is always assignable where `LookupResponse` is expected -- `it.each`
// below is typed with the narrower `LookupResponse` only (not a
// `LookupResponse | GatedLookupResponse` union) to avoid a redundant-union
// lint finding; the one row that needs the wider shape (the `outcome` field)
// casts through `asGated` instead.
function asGated(input: GatedLookupResponse): LookupResponse {
  return input;
}

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

describe('isCallerRelativeDegradation (BS#2528)', () => {
  it.each<{ name: string; input: LookupResponse; expected: boolean }>([
    {
      name: 'degraded: true, degraded_reason: deadline_exceeded -- caller-relative',
      input: response({ degraded: true, degraded_reason: 'deadline_exceeded' }),
      expected: true,
    },
    {
      name: 'timeout: true, degraded: false, empty results -- caller-relative',
      input: response({ timeout: true }),
      expected: true,
    },
    {
      name: 'timeout: true with non-empty results -- still caller-relative regardless of results',
      input: response({ timeout: true, results: [matchedResult] }),
      expected: true,
    },
    {
      name: 'timeout: true + degraded: true, degraded_reason: upstream_unavailable -- caller-relative (timeout wins)',
      input: response({ timeout: true, degraded: true, degraded_reason: 'upstream_unavailable' }),
      expected: true,
    },
    {
      name: 'degraded: true with degraded_reason undefined -- caller-relative (fail-safe)',
      input: response({ degraded: true, degraded_reason: undefined }),
      expected: true,
    },
    {
      name: 'degraded_reason: upstream_unavailable -- allow-listed, not caller-relative',
      input: response({ degraded: true, degraded_reason: 'upstream_unavailable' }),
      expected: false,
    },
    {
      name: 'degraded_reason: cache_only -- NOT allow-listed, caller-relative (LML shows it only to low-priority callers)',
      input: response({ degraded: true, degraded_reason: 'cache_only' }),
      expected: true,
    },
    {
      name: 'unrecognized degraded_reason outside the current union -- fail-safe, caller-relative',
      input: response({
        degraded: true,
        degraded_reason: 'future_reason' as unknown as LookupResponse['degraded_reason'],
      }),
      expected: true,
    },
    {
      name: 'plain non-degraded, non-timeout reply -- not caller-relative',
      input: response({}),
      expected: false,
    },
    {
      name: 'client-side shed-shaped reply (timeout: false, degraded: false, outcome: shed_breaker_open) -- not caller-relative; a cache-admission caller must check shedReasonOf first',
      input: asGated({ ...response({}), outcome: 'shed_breaker_open' }),
      expected: false,
    },
  ])('$name', ({ input, expected }) => {
    expect(isCallerRelativeDegradation(input)).toBe(expected);
  });
});
