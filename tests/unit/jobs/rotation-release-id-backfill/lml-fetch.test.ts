/**
 * Unit tests for jobs/rotation-release-id-backfill lml-fetch.ts.
 *
 * Focus: HTML-entity decode on (artist, album) ahead of the LML hop.
 * tubafrenzy paste data can land `rotation.artist_name` /
 * `rotation.album_title` as HTML-escaped strings (e.g. "Rome&#769;o Poirier"
 * instead of "Roméo Poirier"). LML's NFKD diacritic-strip runs over the raw
 * string — an entity-encoded combining mark never reaches that pass, so the
 * row stays NO_RESULT. Decoding here closes the gap for the rotation
 * backfill without touching the runtime lookup path.
 */
describe('jobs/rotation-release-id-backfill/lml-fetch (HTML-entity decode)', () => {
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

  it('decodes numeric HTML entities in artist before calling LML', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: { release_id: 12345 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Rome&#769;o Poirier', 'Off the Record');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    // &#769; is U+0301 (combining acute) — the decoded form is decomposed
    // (NFD): "Rome" + U+0301 + "o Poirier". That's the desired shape: LML's
    // downstream NFKD strip can act on the combining mark and reduce to
    // "Romeo Poirier" for cache-key matching.
    expect(mockLookup).toHaveBeenCalledWith('Roméo Poirier', 'Off the Record', undefined, expect.any(Object));
    expect(result).toBe(12345);
  });

  it('decodes named HTML entities in both artist and album', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: { release_id: 67890 } }] });

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
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: { release_id: 1 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    await lookupReleaseId('Jessica Pratt', 'On Your Own Love Again');

    expect(mockLookup).toHaveBeenCalledWith('Jessica Pratt', 'On Your Own Love Again', undefined, expect.any(Object));
  });

  it('decodes hex HTML entities', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: { release_id: 2 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    // &#xf6; is precomposed ö (U+00F6).
    await lookupReleaseId('Bj&#xf6;rk', 'Vespertine');

    expect(mockLookup).toHaveBeenCalledWith('Björk', 'Vespertine', undefined, expect.any(Object));
  });

  it('returns null when LML returns no Discogs match', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: null }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Some Artist', 'Some Album');

    expect(result).toBeNull();
  });

  it('returns null when LML returns an empty results array', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    const result = await lookupReleaseId('Some Artist', 'Some Album');

    expect(result).toBeNull();
  });
});
