// Pin the HTML-entity decode added in BS#1223 and the search_type trust
// gate added in BS#1516. Rationale for both lives next to the
// implementation at jobs/rotation-release-id-backfill/lml-fetch.ts.
beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const loadModule = async (
  mockLookup: jest.Mock
): Promise<typeof import('../../../../jobs/rotation-release-id-backfill/lml-fetch.js')> => {
  jest.doMock('../../../../jobs/rotation-release-id-backfill/lml-limiter.js', () => ({
    defaultLmlLimiter: { run: jest.fn() },
  }));
  jest.doMock('@wxyc/lml-client', () => ({
    lookupMetadata: mockLookup,
  }));
  return import('../../../../jobs/rotation-release-id-backfill/lml-fetch.js');
};

describe('jobs/rotation-release-id-backfill/lml-fetch (HTML-entity decode)', () => {
  it('decodes numeric HTML entities in artist before calling LML', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 12345 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Rome&#769;o Poirier', 'Off the Record');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    // &#769; is U+0301 (combining acute); decoded form is NFD-decomposed,
    // which is what LML's downstream NFKD strip needs to act on. Spelled
    // with an explicit escape so an editor can't silently precompose it.
    expect(mockLookup).toHaveBeenCalledWith('Rome\u0301o Poirier', 'Off the Record', undefined, expect.any(Object));
    expect(result).toEqual({ kind: 'resolved', releaseId: 12345 });
  });

  it('decodes named HTML entities in both artist and album', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 67890 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    await lookupReleaseId('Duke Ellington &amp; John Coltrane', 'Duke Ellington &amp; John Coltrane');

    expect(mockLookup).toHaveBeenCalledWith(
      'Duke Ellington & John Coltrane',
      'Duke Ellington & John Coltrane',
      undefined,
      expect.any(Object)
    );
  });

  it('leaves plain strings unchanged (idempotent)', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 1 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    await lookupReleaseId('Jessica Pratt', 'On Your Own Love Again');

    expect(mockLookup).toHaveBeenCalledWith('Jessica Pratt', 'On Your Own Love Again', undefined, expect.any(Object));
  });

  it('decodes hex HTML entities', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 2 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    // &#xf6; is precomposed ö (U+00F6).
    await lookupReleaseId('Bj&#xf6;rk', 'Vespertine');

    expect(mockLookup).toHaveBeenCalledWith('Björk', 'Vespertine', undefined, expect.any(Object));
  });

  it('passes unknown named entities through unchanged', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 3 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    await lookupReleaseId('Foo &copy; Bar', '&trade;');

    expect(mockLookup).toHaveBeenCalledWith('Foo &copy; Bar', '&trade;', undefined, expect.any(Object));
  });

  it('decodes multiple entities in the same string', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 4 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    await lookupReleaseId('A &amp; B &#38; C', 'X');

    expect(mockLookup).toHaveBeenCalledWith('A & B & C', 'X', undefined, expect.any(Object));
  });

  it('passes lone-surrogate codepoints through unchanged (avoids ill-formed UTF-16)', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 5 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    // U+D800 is a high-surrogate; String.fromCodePoint accepts it silently
    // and would produce ill-formed UTF-16.
    await lookupReleaseId('Bad &#xd800; input', 'X');

    expect(mockLookup).toHaveBeenCalledWith('Bad &#xd800; input', 'X', undefined, expect.any(Object));
  });

  it('returns no_match when LML returns no Discogs match', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'direct', results: [{ artwork: null }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Some Artist', 'Some Album');

    expect(result).toEqual({ kind: 'no_match' });
  });

  it('returns no_match when LML returns an empty results array', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'none', results: [] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Some Artist', 'Some Album');

    expect(result).toEqual({ kind: 'no_match' });
  });
});

describe('jobs/rotation-release-id-backfill/lml-fetch (search_type trust gate, BS#1516)', () => {
  it('rejects the artist-fallback answer that caused the Yenbett→Tzenni recurrence (BS#1515)', async () => {
    // LML has no direct match for the typed album, so it answers with other
    // releases by the same artist. results[0] is a DIFFERENT album — trusting
    // it is how rotation row 21529 got Tzenni's release id persisted.
    const mockLookup = jest.fn().mockResolvedValue({
      search_type: 'alternative',
      results: [
        { library_item: { title: 'Tzenni' }, artwork: { album: 'Tzenni', release_id: 5879935 } },
        { library_item: { title: 'Arbina' }, artwork: { album: 'Arbina', release_id: 9239170 } },
      ],
    });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Noura Mint Seymali', 'Yenbett');

    expect(result).toEqual({ kind: 'trust_rejected', searchType: 'alternative' });
  });

  it.each(['fallback', 'alternative', 'compilation', 'song_as_artist', 'none'] as const)(
    'rejects search_type=%s when a candidate release id is present',
    async (searchType) => {
      const mockLookup = jest.fn().mockResolvedValue({
        search_type: searchType,
        results: [{ artwork: { release_id: 424242 } }],
      });

      const { lookupReleaseId } = await loadModule(mockLookup);
      const result = await lookupReleaseId('Stereolab', 'Dots and Loops');

      expect(result).toEqual({ kind: 'trust_rejected', searchType });
    }
  );

  it('fails closed when search_type is absent but a candidate release id is present', async () => {
    // search_type is optional on the wire DTO. An LML build that omits it
    // gives us no trust signal — never persist on silence.
    const mockLookup = jest.fn().mockResolvedValue({
      results: [{ artwork: { release_id: 424242 } }],
    });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Cat Power', 'Moon Pix');

    expect(result).toEqual({ kind: 'trust_rejected', searchType: 'absent' });
  });

  it('passes the BS#1185 streaming-only sentinel (release_id 0) through as resolved for the orchestrator to reject', async () => {
    // Sentinel handling (BS#1429) lives in the orchestrator so the counter
    // taxonomy stays in one place; the gate must not swallow it as no_match.
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 0 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Chuquimamani-Condori', 'Edits');

    expect(result).toEqual({ kind: 'resolved', releaseId: 0 });
  });

  it('accepts a direct match and returns its release id', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 35719330 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Noura Mint Seymali', 'Yenbett');

    expect(result).toEqual({ kind: 'resolved', releaseId: 35719330 });
  });
});
