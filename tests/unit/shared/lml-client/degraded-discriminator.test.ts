/**
 * Contract test for the LookupResponse degraded/cache-only discriminator
 * (BS#943; gates library-metadata-lookup#930 PR1).
 *
 * getAlbumMetadata (apps/backend/controllers/proxy.controller.ts) returns 200
 * on an LML timeout and falls through to synthesized search-only metadata — a
 * silent-200 that, before this field, only latency could distinguish from a
 * real result. `@wxyc/shared@2.4.0` adds a machine-readable `degraded` boolean
 * (plus a `degraded_reason` enum) to LookupResponse so Backend can tell an
 * intentionally shed-the-tail cache-only/partial result apart from a full
 * success and from a genuine no-match. These pins prove the field is present
 * on the type Backend consumes (via `@wxyc/lml-client` → `@wxyc/shared/dtos`)
 * and that the three outcomes are distinguishable.
 */
import type { LookupResponse } from '@wxyc/lml-client';

describe('LookupResponse degraded discriminator (BS#943)', () => {
  const fullSuccess: LookupResponse = {
    results: [
      {
        library_item: {
          id: 12345,
          title: 'DOGA',
          artist: 'Juana Molina',
          call_number: 'Rock CD JUA 1/2',
        },
      },
    ],
    degraded: false,
  };

  const noMatch: LookupResponse = {
    results: [],
    timeout: false,
    degraded: false,
  };

  const degraded: LookupResponse = {
    results: [],
    degraded: true,
    degraded_reason: 'cache_only',
  };

  it('distinguishes a degraded/cache-only response from a full success', () => {
    expect(fullSuccess.degraded).toBe(false);
    expect(degraded.degraded).toBe(true);
    expect(degraded.degraded).not.toBe(fullSuccess.degraded);
  });

  it('distinguishes degraded from a genuine no-match even though both carry empty results', () => {
    // The silent-200 gap this field closes: results alone cannot tell an
    // over-budget/cache-only response apart from an honest no-match — `degraded`
    // can, without the caller having to infer it from latency.
    expect(noMatch.results).toHaveLength(0);
    expect(degraded.results).toHaveLength(0);
    expect(noMatch.degraded).toBe(false);
    expect(degraded.degraded).toBe(true);
  });

  it('carries a degraded_reason only on a degraded response', () => {
    expect(degraded.degraded_reason).toBe('cache_only');
    expect(fullSuccess.degraded_reason).toBeUndefined();
    expect(noMatch.degraded_reason).toBeUndefined();
  });

  it('accepts each documented degraded_reason value', () => {
    const reasons: NonNullable<LookupResponse['degraded_reason']>[] = [
      'deadline_exceeded',
      'cache_only',
      'upstream_unavailable',
    ];
    for (const reason of reasons) {
      const response: LookupResponse = {
        results: [],
        degraded: true,
        degraded_reason: reason,
      };
      expect(response.degraded_reason).toBe(reason);
    }
  });
});
