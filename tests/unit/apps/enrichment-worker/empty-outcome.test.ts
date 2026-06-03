/**
 * Unit tests for empty-outcome predicate + cause classifier (BS#969 / Epic G G7).
 *
 * The predicate is pure — wraps `extractArtwork` and looks at `artwork_url`.
 * These tests pin the failure-mode taxonomy from BS#969:
 *
 *   - `lml_no_match`  — `results: []` from LML (artwork === null after extract)
 *   - `lml_degraded`  — artwork object returned but `artwork_url` missing/null
 *                       (the LML#408 `_resolve_fallback_artwork` class)
 *   - `unknown`       — shouldn't be reachable if isEmptyOutcome() is true
 *
 * Plus regression-pinning for the "non-empty" cases (proper match, artwork_url
 * present) so a future change to extractArtwork doesn't silently start firing
 * the Sentry alert for every successful enrichment.
 */

import type { LookupResponse } from '@wxyc/lml-client';

import { classifyEmptyCause, isEmptyOutcome } from '../../../../apps/enrichment-worker/empty-outcome';

const makeMatchResponse = (artworkOverrides: Record<string, unknown> = {}) =>
  ({
    results: [
      {
        artwork: {
          artwork_url: 'https://i.discogs.com/abc/cover.jpg',
          release_url: 'https://discogs.com/release/123',
          release_year: 2022,
          spotify_url: 'https://open.spotify.com/album/x',
          apple_music_url: 'https://music.apple.com/album/y',
          ...artworkOverrides,
        },
      },
    ],
  }) as unknown as LookupResponse;

const NO_MATCH_RESPONSE = { results: [] } as unknown as LookupResponse;

describe('isEmptyOutcome (BS#969 G7)', () => {
  it('returns true for explicit no-match response (results: [])', () => {
    expect(isEmptyOutcome(NO_MATCH_RESPONSE)).toBe(true);
  });

  it('returns true when artwork object is returned but artwork_url is null', () => {
    expect(isEmptyOutcome(makeMatchResponse({ artwork_url: null }))).toBe(true);
  });

  it('returns true when artwork object is returned but artwork_url is undefined', () => {
    expect(isEmptyOutcome(makeMatchResponse({ artwork_url: undefined }))).toBe(true);
  });

  it('returns true when artwork object is returned but artwork_url is empty string', () => {
    // Empty string is the falsy edge — same user-facing blank tile.
    expect(isEmptyOutcome(makeMatchResponse({ artwork_url: '' }))).toBe(true);
  });

  it('returns false when artwork_url is populated (even if other fields are null)', () => {
    expect(
      isEmptyOutcome(
        makeMatchResponse({
          artwork_url: 'https://i.discogs.com/abc/cover.jpg',
          release_year: null,
          apple_music_url: null,
        })
      )
    ).toBe(false);
  });
});

describe('classifyEmptyCause (BS#969 G7)', () => {
  it('returns lml_no_match for an explicit no-match response', () => {
    expect(classifyEmptyCause(NO_MATCH_RESPONSE)).toBe('lml_no_match');
  });

  it('returns lml_degraded when artwork is returned but artwork_url is null', () => {
    expect(classifyEmptyCause(makeMatchResponse({ artwork_url: null }))).toBe('lml_degraded');
  });

  it('returns lml_degraded when artwork is returned but artwork_url is undefined', () => {
    expect(classifyEmptyCause(makeMatchResponse({ artwork_url: undefined }))).toBe('lml_degraded');
  });

  it('returns lml_degraded when artwork_url is empty string', () => {
    expect(classifyEmptyCause(makeMatchResponse({ artwork_url: '' }))).toBe('lml_degraded');
  });

  it('returns unknown when artwork_url is present (defensive fallback)', () => {
    // Caller should only invoke classify after isEmptyOutcome returns true,
    // but the function is defensive — if invoked on a non-empty response, the
    // 'unknown' tag surfaces the misuse without crashing.
    expect(classifyEmptyCause(makeMatchResponse())).toBe('unknown');
  });
});
