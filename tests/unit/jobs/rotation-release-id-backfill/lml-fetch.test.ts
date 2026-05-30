// Pin the HTML-entity decode added in BS#1223. Rationale lives next to the
// implementation at jobs/rotation-release-id-backfill/lml-fetch.ts.
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
    // &#769; is U+0301 (combining acute); decoded form is NFD-decomposed,
    // which is what LML's downstream NFKD strip needs to act on.
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

  it('passes unknown named entities through unchanged', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: { release_id: 3 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    await lookupReleaseId('Foo &copy; Bar', '&trade;');

    expect(mockLookup).toHaveBeenCalledWith('Foo &copy; Bar', '&trade;', undefined, expect.any(Object));
  });

  it('decodes multiple entities in the same string', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: { release_id: 4 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    await lookupReleaseId('A &amp; B &#38; C', 'X');

    expect(mockLookup).toHaveBeenCalledWith('A & B & C', 'X', undefined, expect.any(Object));
  });

  it('passes lone-surrogate codepoints through unchanged (avoids ill-formed UTF-16)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [{ artwork: { release_id: 5 } }] });

    const { lookupReleaseId } = await loadModule(mockLookup);
    // U+D800 is a high-surrogate; String.fromCodePoint accepts it silently
    // and would produce ill-formed UTF-16.
    await lookupReleaseId('Bad &#xd800; input', 'X');

    expect(mockLookup).toHaveBeenCalledWith('Bad &#xd800; input', 'X', undefined, expect.any(Object));
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
