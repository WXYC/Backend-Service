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
 *     NEW false-terminal no-match while it exists to fix old ones;
 *   - a `degraded_reason: 'deadline_exceeded'` response with no usable
 *     answer is ALSO transient (BS#2179 review HIGH 2 / BS#1977) — the
 *     budget-cutoff shed shape `shared/lml-client/src/policy.ts`'s module
 *     docstring documents, distinct from the shed-limiter/breaker shape
 *     `shedReasonOf` detects;
 *   - `isUnansweredDegraded`'s classification is exhaustive over every
 *     `degraded_reason` `@wxyc/shared`'s `LookupResponse` DTO documents
 *     today, so a newly-added reason can't silently regress into
 *     "definitive" — see the dedicated describe block below.
 *   - BS#2218: `lookupNoMatchRecheck` sends `budgetMs: null` unconditionally
 *     (BS#1914's lever), so no `X-Caller-Budget-Ms` header reaches LML at
 *     all — see the dedicated describe block below.
 *
 * CORRECTION (BS#2218): BS#2179 review HIGH 3 concluded this job should stay
 * registered at LML class 5 sending `X-Caller-Budget-Ms` unconditionally,
 * reasoning that the "4s cutoff is wrong" finding applied only to
 * `enrichment-worker`'s live CDC lane, not to class-5 batch drains generally.
 * That reasoning didn't hold for THIS drain specifically: unlike a generic
 * backfill, this cohort is defined by having already failed a live lookup
 * once, so it's enriched for exactly the cold non-library releases that need
 * LML's full cascade (measured 4-20s on 2026-08-04) — the same population
 * BS#1978 was built for. Prod measurement on 2026-08-18 confirmed the
 * consequence directly: the header's ~4s empty-state cutoff was arming on
 * this population so reliably that the job made near-zero forward progress
 * (64 rows drained from a 137,340-row cohort in five runs). See BS#2218 for
 * the full measurement and the corrected decision.
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
    // BS#1359/#1959/#2217: faithful stand-in for the shared track-context
    // trust predicate — mirrors its real (and only) rule, including the
    // BS#2217 request<->result correspondence carve-out for everything
    // other than `direct`/`compilation`/`song_as_artist`.
    isTrustedLmlTrackContextMatch: (
      r: { search_type?: string; results?: { library_item?: { id?: number; title?: string | null } }[] },
      requestedAlbum?: string | null
    ) => {
      if (r.search_type === 'direct' || r.search_type === 'compilation') return true;
      if (r.search_type === 'song_as_artist') return false;
      const top = r.results?.[0];
      if (top?.library_item?.id !== 0) return false;
      const norm = (s: string | null | undefined) =>
        (s ?? '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim();
      const a = norm(top.library_item?.title);
      return a !== '' && a === norm(requestedAlbum);
    },
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

  it('sends no X-Caller-Budget-Ms — budgetMs: null unconditionally (BS#2218, BS#1914 lever)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'none', results: [] });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    await lookupNoMatchRecheck(candidate);

    expect(mockLookup).toHaveBeenCalledWith(
      'Vladislav Delay',
      'Entain',
      'Kohde',
      expect.objectContaining({ budgetMs: null })
    );
  });

  it('decodes HTML entities in artist/album/track before the LML hop (LOW finding: tubafrenzy paste data lands entity-encoded)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'none', results: [] });
    // Decimal numeric entities only, mirroring
    // `rotation-release-id-backfill/lml-fetch.ts`'s donor exactly: ́ is
    // a combining acute accent — the motivating case where LML's NFKD strip
    // never sees the encoded combining mark and the row stays a no-match
    // (entity `&#769;`, decimal for 0x301). Built via `String.fromCharCode`
    // rather than a literal combining character in source, per this repo's
    // mojibake-prevention convention.
    const combiningAcute = String.fromCharCode(0x301);

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    await lookupNoMatchRecheck({
      id: 1,
      artist_name: `Rome&#769;o Poirier`,
      album_title: 'Caf&#233; &amp; Bar', // &#233; = 'é'; &amp; = '&'
      track_title: 'Under 1&#48;0&#37;', // &#48; = '0'; &#37; = '%'
      album_id: null,
    });

    expect(mockLookup).toHaveBeenCalledWith(
      `Rome${combiningAcute}o Poirier`,
      'Café & Bar',
      'Under 100%',
      expect.anything()
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

  it('resolves an alternative row-less match whose title corresponds to candidate.album_title (BS#2217)', async () => {
    const artwork = { release_id: 555, release_url: 'https://www.discogs.com/release/555' };
    const mockLookup = jest.fn().mockResolvedValue({
      search_type: 'alternative',
      results: [{ library_item: { id: 0, title: candidate.album_title }, artwork }],
    });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'resolved', artwork });
  });

  it('still trust_rejects an alternative match with a real library_item.id even when the title matches (the Vantaa/Animaru shape)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({
      search_type: 'alternative',
      results: [
        { library_item: { id: 64288, title: candidate.album_title }, artwork: { release_id: 1, release_url: 'x' } },
      ],
    });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'trust_rejected', searchType: 'alternative' });
  });

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

  it('a deadline_exceeded degraded response with no usable answer is transient (BS#2179 review HIGH 2 / BS#1977)', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ degraded: true, degraded_reason: 'deadline_exceeded', results: [], search_type: 'none' });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);

    await expect(lookupNoMatchRecheck(candidate)).rejects.toThrow(/degraded|deadline/i);
  });

  it('a deadline_exceeded degraded response that still carries a trusted match is resolved, not treated as transient', async () => {
    const artwork = { release_id: 444, release_url: 'https://www.discogs.com/release/444' };
    const mockLookup = jest.fn().mockResolvedValue({
      degraded: true,
      degraded_reason: 'deadline_exceeded',
      search_type: 'direct',
      results: [{ artwork }],
    });

    const { lookupNoMatchRecheck } = await loadModule(mockLookup);
    const outcome = await lookupNoMatchRecheck(candidate);

    expect(outcome).toEqual({ kind: 'resolved', artwork });
  });
});

describe('isUnansweredDegraded classification — exhaustive over every documented degraded_reason (BS#2179 review HIGH 2 / BS#1977)', () => {
  /**
   * `@wxyc/shared`'s `LookupResponse.degraded_reason` is a 3-member union
   * today (`deadline_exceeded` / `cache_only` / `upstream_unavailable` —
   * pinned independently at
   * `tests/unit/shared/lml-client/degraded-discriminator.test.ts`).
   * `upstream_unavailable` and `deadline_exceeded` are both "LML never
   * produced a usable verdict" shapes and must stay transient.
   * `cache_only` is a genuine (if degraded-confidence) answer from cache,
   * not an unanswered call, and is NOT part of this fix's scope — pinned
   * here as a deliberate negative case so a future widening is a conscious
   * choice, not a silent one. `lml-fetch.ts`'s `UNANSWERED_DEGRADED_REASON`
   * table is typed `satisfies Record<DegradedReason, boolean>`, so a 4th
   * `degraded_reason` added to the shared DTO fails typecheck there until
   * explicitly classified — this test only pins the three reasons that
   * exist today.
   */
  it.each([
    ['upstream_unavailable', true],
    ['deadline_exceeded', true],
    ['cache_only', false],
  ] as const)('degraded_reason=%s with no usable answer classifies as unanswered=%s', async (reason, isUnanswered) => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ degraded: true, degraded_reason: reason, results: [], search_type: 'none' });
    const { lookupNoMatchRecheck } = await loadModule(mockLookup);

    if (isUnanswered) {
      await expect(lookupNoMatchRecheck(candidate)).rejects.toThrow();
    } else {
      const outcome = await lookupNoMatchRecheck(candidate);
      expect(outcome).toEqual({ kind: 'no_match' });
    }
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

  it('threads requestedAlbum into the predicate — a row-less match resolves only when it is supplied and corresponds (BS#2217)', async () => {
    const mockLookup = jest.fn();
    const { extractTrustedArtwork } = await loadModule(mockLookup);
    const response = {
      search_type: 'alternative',
      results: [
        { library_item: { id: 0, title: 'The Spiritual Sound' }, artwork: { release_id: 1, release_url: 'x' } },
      ],
    };

    expect(extractTrustedArtwork(response)).toBeNull();
    expect(extractTrustedArtwork(response, 'The Spiritual Sound')).toEqual(response.results[0].artwork);
  });
});
