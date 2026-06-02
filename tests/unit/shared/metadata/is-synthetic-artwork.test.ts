import type { DiscogsMatchResult } from '@wxyc/lml-client';

import { isSyntheticArtwork } from '@wxyc/metadata';

const make = (overrides: Partial<DiscogsMatchResult>): DiscogsMatchResult => ({
  release_id: 0,
  release_url: '',
  confidence: 0,
  ...overrides,
});

describe('isSyntheticArtwork', () => {
  it('detects the LML#401 synth sentinel (release_id=0 + release_url="")', () => {
    expect(isSyntheticArtwork(make({}))).toBe(true);
  });

  it('returns false when release_id is non-zero', () => {
    expect(isSyntheticArtwork(make({ release_id: 12345 }))).toBe(false);
  });

  it('returns false when release_url is non-empty', () => {
    expect(isSyntheticArtwork(make({ release_url: 'https://www.discogs.com/release/12345' }))).toBe(false);
  });

  it('returns false when both fields are populated (a real match)', () => {
    expect(isSyntheticArtwork(make({ release_id: 12345, release_url: 'https://www.discogs.com/release/12345' }))).toBe(
      false
    );
  });
});
