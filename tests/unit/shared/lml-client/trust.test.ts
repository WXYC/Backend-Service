/**
 * Unit tests for the shared search_type trust predicates (BS#1356).
 *
 * `isTrustedLmlAlbumMatch` is the single authority every album-context write
 * gate delegates to (the coordinator's `applyTrustGate`, plus the two offline
 * job gates in `jobs/rotation-release-id-backfill` and
 * `jobs/library-canonical-entity-backfill`). `isTrustedLmlTrackContextMatch`
 * is reserved for BS#1359 (PR 3) and not wired into any callsite yet — these
 * tests still pin its standalone contract so the reservation is verifiable
 * ahead of that wiring.
 */
import { isTrustedLmlAlbumMatch, isTrustedLmlTrackContextMatch } from '@wxyc/lml-client';

describe('isTrustedLmlAlbumMatch', () => {
  it('trusts a direct match', () => {
    expect(isTrustedLmlAlbumMatch({ search_type: 'direct' })).toBe(true);
  });

  it.each<string>(['fallback', 'alternative', 'compilation', 'song_as_artist', 'none'])(
    'rejects a %s match',
    (search_type) => {
      expect(isTrustedLmlAlbumMatch({ search_type: search_type as never })).toBe(false);
    }
  );

  it('fails closed on an absent search_type', () => {
    expect(isTrustedLmlAlbumMatch({})).toBe(false);
  });

  it('fails closed on an undefined search_type', () => {
    expect(isTrustedLmlAlbumMatch({ search_type: undefined })).toBe(false);
  });
});

describe('isTrustedLmlTrackContextMatch', () => {
  it('trusts a direct match', () => {
    expect(isTrustedLmlTrackContextMatch({ search_type: 'direct' })).toBe(true);
  });

  it('trusts a compilation match', () => {
    expect(isTrustedLmlTrackContextMatch({ search_type: 'compilation' })).toBe(true);
  });

  it.each<string>(['alternative', 'fallback', 'song_as_artist', 'none'])('rejects a %s match', (search_type) => {
    expect(isTrustedLmlTrackContextMatch({ search_type: search_type as never })).toBe(false);
  });

  it('fails closed on an absent search_type', () => {
    expect(isTrustedLmlTrackContextMatch({})).toBe(false);
  });

  it('fails closed on an undefined search_type', () => {
    expect(isTrustedLmlTrackContextMatch({ search_type: undefined })).toBe(false);
  });
});
