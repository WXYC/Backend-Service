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

describe('isTrustedLmlTrackContextMatch — request/result correspondence (BS#2217)', () => {
  /**
   * BS#2217: an `alternative` search_type is provenance telemetry (LML's
   * last-strategy label), not a confidence signal — a row-less result
   * (`library_item.id === 0`) can only ever be minted from the request's
   * own artist and song, so it can never be a same-artist substitution.
   * These pin the five acceptance-criteria shapes from the ticket
   * (prod evidence: Agriculture/The Spiritual Sound, Bim Sherman/Ghetto
   * Dub — both wrongly rejected before this fix; Vladislav Delay/Entain,
   * Mei Semones/Kurage — real substitutions that must keep rejecting).
   */
  it('trusts an alternative row-less match whose title matches the requested album', () => {
    expect(
      isTrustedLmlTrackContextMatch(
        { search_type: 'alternative', results: [{ library_item: { id: 0, title: 'The Spiritual Sound' } }] },
        'The Spiritual Sound'
      )
    ).toBe(true);
  });

  it('rejects an alternative match with a real library_item.id even when the title differs (the Vantaa/Animaru shape)', () => {
    expect(
      isTrustedLmlTrackContextMatch(
        { search_type: 'alternative', results: [{ library_item: { id: 64288, title: 'Vantaa' } }] },
        'Entain'
      )
    ).toBe(false);
  });

  it('rejects a real library_item.id even when the title happens to match the requested album', () => {
    expect(
      isTrustedLmlTrackContextMatch(
        { search_type: 'alternative', results: [{ library_item: { id: 64288, title: 'Entain' } }] },
        'Entain'
      )
    ).toBe(false);
  });

  it('rejects an alternative row-less match whose title does not match the requested album', () => {
    expect(
      isTrustedLmlTrackContextMatch(
        { search_type: 'alternative', results: [{ library_item: { id: 0, title: 'Some Other Album' } }] },
        'The Spiritual Sound'
      )
    ).toBe(false);
  });

  it('rejects song_as_artist even with a row-less id and a matching title (explicit lane exclusion)', () => {
    expect(
      isTrustedLmlTrackContextMatch(
        { search_type: 'song_as_artist', results: [{ library_item: { id: 0, title: 'The Spiritual Sound' } }] },
        'The Spiritual Sound'
      )
    ).toBe(false);
  });

  it.each([undefined, null])(
    "keeps the carve-out inactive when requestedAlbum is %s — identical to today's behavior",
    (requestedAlbum) => {
      expect(
        isTrustedLmlTrackContextMatch(
          { search_type: 'alternative', results: [{ library_item: { id: 0, title: 'The Spiritual Sound' } }] },
          requestedAlbum
        )
      ).toBe(false);
    }
  );

  it('rejects a row-less match with no title to compare, even with a requestedAlbum', () => {
    expect(
      isTrustedLmlTrackContextMatch(
        { search_type: 'alternative', results: [{ library_item: { id: 0 } }] },
        'The Spiritual Sound'
      )
    ).toBe(false);
  });

  it('is case- and punctuation-insensitive via looseTitleKey', () => {
    expect(
      isTrustedLmlTrackContextMatch(
        { search_type: 'alternative', results: [{ library_item: { id: 0, title: 'Ghetto Dub' } }] },
        'ghetto-dub!!'
      )
    ).toBe(true);
  });

  it('rejects when results is empty even with a matching requestedAlbum', () => {
    expect(isTrustedLmlTrackContextMatch({ search_type: 'alternative', results: [] }, 'The Spiritual Sound')).toBe(
      false
    );
  });

  it.each<string>(['fallback', 'none'])(
    'a %s search_type still falls through to the correspondence check rather than an unconditional reject',
    (search_type) => {
      expect(
        isTrustedLmlTrackContextMatch(
          { search_type: search_type as never, results: [{ library_item: { id: 0, title: 'The Spiritual Sound' } }] },
          'The Spiritual Sound'
        )
      ).toBe(true);
    }
  );
});
