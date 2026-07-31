// Pins jobs/library-discogs-unavailable-recheck/lml-fetch.ts: forceLookup is
// always set (issue test 5), the raw confidence score passes through
// untouched (the 0.95 floor lives in orchestrate.ts, not here), the BS#1185
// streaming-only sentinel (release_id 0) is treated as no_match, and an LML
// timeout body throws so the row stays retryable.
beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const loadModule = async (
  mockLookup: jest.Mock
): Promise<typeof import('../../../../jobs/library-discogs-unavailable-recheck/lml-fetch.js')> => {
  jest.doMock('../../../../jobs/library-discogs-unavailable-recheck/lml-limiter.js', () => ({
    defaultLmlLimiter: { run: jest.fn() },
  }));
  jest.doMock('@wxyc/lml-client', () => ({
    lookupMetadata: mockLookup,
  }));
  return import('../../../../jobs/library-discogs-unavailable-recheck/lml-fetch.js');
};

describe('jobs/library-discogs-unavailable-recheck/lml-fetch', () => {
  it('always passes forceLookup: true (issue test 5)', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 12345, confidence: 0.98 } }] });

    const { lookupRecheck } = await loadModule(mockLookup);
    await lookupRecheck('Chuquimamani-Condori', 'Edits');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    const [artist, album, song, options] = mockLookup.mock.calls[0] as [
      string,
      string,
      undefined,
      Record<string, unknown>,
    ];
    expect(artist).toBe('Chuquimamani-Condori');
    expect(album).toBe('Edits');
    expect(song).toBeUndefined();
    expect(options.forceLookup).toBe(true);
    expect(options.caller).toBe('library-discogs-unavailable-recheck');
  });

  it('returns the raw confidence score untouched — no floor applied here', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 55555, confidence: 0.42 } }] });

    const { lookupRecheck } = await loadModule(mockLookup);
    const result = await lookupRecheck('Some Artist', 'Some Album');

    expect(result).toEqual({ kind: 'match', releaseId: 55555, confidence: 0.42 });
  });

  it('defaults confidence to 0 when LML omits it', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 1 } }] });

    const { lookupRecheck } = await loadModule(mockLookup);
    const result = await lookupRecheck('Some Artist', 'Some Album');

    expect(result).toEqual({ kind: 'match', releaseId: 1, confidence: 0 });
  });

  it('returns no_match when LML has no candidate', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ search_type: 'none', results: [] });

    const { lookupRecheck } = await loadModule(mockLookup);
    const result = await lookupRecheck('Some Artist', 'Some Album');

    expect(result).toEqual({ kind: 'no_match' });
  });

  it('treats the BS#1185 streaming-only sentinel (release_id 0) as no_match', async () => {
    const mockLookup = jest
      .fn()
      .mockResolvedValue({ search_type: 'direct', results: [{ artwork: { release_id: 0, confidence: 0.9 } }] });

    const { lookupRecheck } = await loadModule(mockLookup);
    const result = await lookupRecheck('Some Artist', 'Some Album');

    expect(result).toEqual({ kind: 'no_match' });
  });

  it('throws on a transient LML timeout body so the row stays retryable', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ timeout: true, results: [] });

    const { lookupRecheck } = await loadModule(mockLookup);

    await expect(lookupRecheck('Some Artist', 'Some Album')).rejects.toThrow(/timeout/i);
  });
});
