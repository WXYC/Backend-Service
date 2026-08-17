/**
 * Unit tests for jobs/flowsheet-no-match-recheck lml-fetch.ts (BS#2176).
 *
 * Pins:
 *   - the track-context trust gate (BS#1359/#1959): a match is only
 *     `resolved` when `isTrustedLmlTrackContextMatch` accepts the response's
 *     `search_type`, mirroring `apps/enrichment-worker/enrich.ts#extractArtwork`;
 *   - the compilation-aware walk over `results` (BS#961);
 *   - `no_match` vs `trust_rejected` classification (BS#1516 rationale);
 *   - a cascade-timeout body (`timeout: true`) is treated as transient
 *     (thrown), never as a definitive no-match;
 *   - a breaker-open/shed degraded response with no usable answer (BS#1995
 *     Arm 3) is also treated as transient — this job must not manufacture a
 *     NEW false-terminal no-match while it exists to fix old ones.
 */

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const loadModule = async (
  mockLookup: jest.Mock
): Promise<typeof import('../../../../jobs/flowsheet-no-match-recheck/lml-fetch.js')> => {
  jest.doMock('../../../../jobs/flowsheet-no-match-recheck/lml-limiter.js', () => ({
    defaultLmlLimiter: { run: jest.fn() },
  }));
  jest.doMock('@wxyc/lml-client', () => ({
    lookupMetadata: mockLookup,
    // BS#1359/#1959: faithful stand-in for the shared track-context trust
    // predicate — mirrors its real (and only) rule.
    isTrustedLmlTrackContextMatch: (r: { search_type?: string }) =>
      r.search_type === 'direct' || r.search_type === 'compilation',
    shedReasonOf: (response: { outcome?: string }) =>
      response.outcome === 'shed_limiter_saturated' || response.outcome === 'shed_breaker_open'
        ? response.outcome
        : undefined,
  }));
  return import('../../../../jobs/flowsheet-no-match-recheck/lml-fetch.js');
};

const candidate = {
  id: 5308981,
  artist_name: 'Vladislav Delay',
  album_title: 'Entain',
  track_title: 'Kohde',
  album_id: null,
};

describe('lookupNoMatchRecheck', () => {
  it('calls lookupMetadata with (artist, album, track) and the flowsheet-no-match-recheck caller label', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'none', results: [] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    await lookupNoMatchRecheck(candidate);

    expect(mockLookup).toHaveBeenCalledWith(
      'Vladislav Delay',
      'Entain',
      'Kohde',
      expect.objectContaining({ caller: 'flowsheet-no-match-recheck' })
    );
  });

  it('forwards discogs_unavailable to the lookup call', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'none', results: [] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    await lookupNoMatchRecheck({ ...candidate, discogs_unavailable: true });

    expect(mockLookup).toHaveBeenCalledWith(
      'Vladislav Delay',
      'Entain',
      'Kohde',
      expect.objectContaining({ discogsUnavailable: true })
    );
  });

  it('a direct match resolves with the trusted artwork', async () => {
    const artwork = { release_id: 28327348, release_url: 'https://www.discogs.com/release/28327348' };
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'direct', results: [{ artwork }] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'resolved', artwork });
  });

  it('a compilation match resolves — track-confirmed on a V/A release is a real match (BS#1359)', async () => {
    const artwork = { release_id: 111, release_url: 'https://www.discogs.com/release/111' };
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'compilation', results: [{ artwork }] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'resolved', artwork });
  });

  it('walks past a result with no artwork to find a later one (BS#961 compilation edge case)', async () => {
    const artwork = { release_id: 222, release_url: 'https://www.discogs.com/release/222' };
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'compilation', results: [{ library_item: {} }, { artwork }] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'resolved', artwork });
  });

  it('a trusted search_type with no artwork in any result is a genuine no-match, not a trust rejection', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'direct', results: [{ library_item: {} }] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'no_match' });
  });

  it('search_type=none is a genuine no-match', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'none', results: [] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'no_match' });
  });

  it.each(['fallback', 'alternative', 'song_as_artist'])(
    'search_type=%s with a candidate result is trust_rejected, not no_match (BS#1516)',
    async (searchType) => {
      const mockLookup = jest
        .fn()
        .mockResolvedValue({ search_type: searchType, results: [{ artwork: { release_id: 1, release_url: 'x' } }] });

      const { lookupNoMatchRecheck } = await loadModule(mockLookup);
      const outcome = await lookupNoMatchRecheck(candidate);

      expect(outcome).toEqual({ kind: 'trust_rejected', searchType });
    }
  );

  it('a cascade-timeout body is transient — throws so the row stays immediately retryable', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ timeout: true, results: [], search_type: 'none' });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);

    await expect(lookupNoMatchRecheck(candidate)).rejects.toThrow(/timeout/i);
  });

  it('a breaker-open degraded response with no usable answer is transient (BS#1995 Arm 3)', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ degraded: true, degraded_reason: 'upstream_unavailable', results: [], search_type: 'none' });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);

    await expect(lookupNoMatchRecheck(candidate)).rejects.toThrow(/degraded|unavailable/i);
  });

  it('a degraded response that still carries a trusted match is resolved, not treated as transient', async () => {
    const artwork = { release_id: 333, release_url: 'https://www.discogs.com/release/333' };
    const mockLookup = jest.fn().mockResolvedValue({
      degraded: true,
      degraded_reason: 'upstream_unavailable',
      search_type: 'direct',
      results: [{ artwork }],
    });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'resolved', artwork });
  });

  it('a shed response (limiter saturated) with no usable answer is transient', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ outcome: 'shed_limiter_saturated', results: [], search_type: 'none' });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);

    await expect(lookupNoMatchRecheck(candidate)).rejects.toThrow();
  });
});

describe('extractTrustedArtwork', () => {
  it('returns null when the response is not track-context trusted, even with a candidate result', async () => {
    const mockLookup = jest.fn();
    const { extractTrustedArtwork } = await loadModule(mockLookup);

    expect(
      extractTrustedArtwork({
        search_type: 'alternative',
        results: [{ artwork: { release_id: 1, release_url: 'x' } }],
      })
    ).toBeNull();
  });
});
