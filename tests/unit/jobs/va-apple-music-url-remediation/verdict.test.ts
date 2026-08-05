/**
 * BS#2000 verdict classification.
 *
 * The three-way split is the job's safety story: `none` writes a permanent
 * NULL over a possibly-correct link, so every response shape that is merely
 * "no evidence" must land in `indeterminate` instead.
 */

import { classifyResponse, extractAppleMusicUrl } from '../../../../jobs/va-apple-music-url-remediation/verdict';
import type { GatedLookupResponse } from '@wxyc/lml-client';

const withResults = (appleUrl?: string | null): GatedLookupResponse =>
  ({
    results: [{ artwork: appleUrl === undefined ? {} : { apple_music_url: appleUrl } }],
  }) as unknown;

describe('extractAppleMusicUrl', () => {
  it('reads the top-1 result’s apple_music_url', () => {
    expect(extractAppleMusicUrl(withResults('https://music.apple.com/us/song/x/1'))).toBe(
      'https://music.apple.com/us/song/x/1'
    );
  });

  it('coerces an empty string to null so a blank is never persisted', () => {
    expect(extractAppleMusicUrl(withResults(''))).toBeNull();
  });

  it('ignores lower-ranked results', () => {
    // A URL on a different-release result is not evidence about THIS row.
    const response = {
      results: [{ artwork: {} }, { artwork: { apple_music_url: 'https://music.apple.com/us/song/y/2' } }],
    } as unknown as GatedLookupResponse;
    expect(extractAppleMusicUrl(response)).toBeNull();
  });
});

describe('classifyResponse', () => {
  it('returns url when LML re-adjudicated a match', () => {
    expect(classifyResponse(withResults('https://music.apple.com/us/song/x/1'))).toEqual({
      kind: 'url',
      url: 'https://music.apple.com/us/song/x/1',
    });
  });

  it('returns none when the row was found and carries no Apple match', () => {
    expect(classifyResponse(withResults(null))).toEqual({ kind: 'none' });
    expect(classifyResponse(withResults(undefined))).toEqual({ kind: 'none' });
  });

  it('treats EMPTY results as indeterminate, not as a no-match', () => {
    // "the library row wasn't found on this attempt" is not evidence that the
    // stored URL is wrong. Collapsing this into `none` would null correct URLs
    // whenever LML's search leg had a bad moment.
    expect(classifyResponse({ results: [] } as unknown)).toEqual({
      kind: 'indeterminate',
      reason: 'empty_results',
    });
    expect(classifyResponse({})).toEqual({
      kind: 'indeterminate',
      reason: 'empty_results',
    });
  });

  it('treats a BS#1293 discogs-unavailable skip as indeterminate', () => {
    const response = { results: [], outcome: 'skipped_discogs_unavailable' } as unknown as GatedLookupResponse;
    expect(classifyResponse(response)).toEqual({
      kind: 'indeterminate',
      reason: 'skipped_discogs_unavailable',
    });
  });

  describe('shed outcomes (forward-compat pins)', () => {
    // These CANNOT fire through this job's limiter today: a job-owned
    // `createLmlLimiter` passes neither `breaker` nor `queueWaitMs`, so the
    // client never throws LimiterShedError ("job limiters keep the unbounded
    // shape"). Pinned anyway so that reconfiguring the limiter later cannot
    // silently turn a shed into a data-destroying `none`.
    it.each(['shed_limiter_saturated', 'shed_breaker_open'] as const)('treats %s as indeterminate', (outcome) => {
      const response = { results: [], outcome } as unknown as GatedLookupResponse;
      expect(classifyResponse(response)).toEqual({ kind: 'indeterminate', reason: outcome });
    });

    it('prefers the shed reason over the empty-results reason', () => {
      const response = { results: [], outcome: 'shed_breaker_open' } as unknown as GatedLookupResponse;
      expect(classifyResponse(response)).toEqual({ kind: 'indeterminate', reason: 'shed_breaker_open' });
    });
  });
});
