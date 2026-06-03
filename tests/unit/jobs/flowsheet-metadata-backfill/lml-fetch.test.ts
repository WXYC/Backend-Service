// Unit tests for the backfill's per-call LML timeout (BS#994 / BS#1180).
//
// Verifies that `lookupMetadata` passes a per-call timeoutMs through to
// `@wxyc/lml-client`. BS#994 introduced the per-call knob; BS#1180 retuned
// the default from 8000ms → 35_000ms after LML#370 capped per-item cascade
// exhaustion at 25.25s — the prior 8s budget aborted before LML could
// return its `{timeout:true, results:[]}` body, leaving rows unmarked.

describe('jobs/flowsheet-metadata-backfill/lml-fetch (BS#994 / BS#1180 timeout knob)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  const loadModule = async (
    mockLookup: jest.Mock
  ): Promise<typeof import('../../../../jobs/flowsheet-metadata-backfill/lml-fetch.js')> => {
    // Mock the local limiter module — we only care about the args passed to
    // sharedLookupMetadata. Avoids needing to fully stub all of @wxyc/lml-client's
    // exports (Semaphore, TokenBucket, createLmlLimiter) that lml-limiter.ts
    // pulls in at module-load.
    jest.doMock('../../../../jobs/flowsheet-metadata-backfill/lml-limiter.js', () => ({
      defaultLmlLimiter: { run: jest.fn() },
    }));
    jest.doMock('@wxyc/lml-client', () => ({
      lookupMetadata: mockLookup,
    }));
    // Module evaluates env at load — must doMock + import after env setup.
    return import('../../../../jobs/flowsheet-metadata-backfill/lml-fetch.js');
  };

  it('passes default 35_000ms timeoutMs when BACKFILL_LML_PER_CALL_TIMEOUT_MS is unset', async () => {
    delete process.env.BACKFILL_LML_PER_CALL_TIMEOUT_MS;
    const mockLookup = jest.fn().mockResolvedValue({ matches: [] });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Juana Molina', 'DOGA', 'la paradoja');

    expect(mockLookup).toHaveBeenCalledWith(
      'Juana Molina',
      'DOGA',
      'la paradoja',
      expect.objectContaining({ timeoutMs: 35_000 })
    );
  });

  it('reads BACKFILL_LML_PER_CALL_TIMEOUT_MS from env when set', async () => {
    process.env.BACKFILL_LML_PER_CALL_TIMEOUT_MS = '5000';
    const mockLookup = jest.fn().mockResolvedValue({ matches: [] });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Jessica Pratt');

    expect(mockLookup).toHaveBeenCalledWith(
      'Jessica Pratt',
      undefined,
      undefined,
      expect.objectContaining({ timeoutMs: 5000 })
    );
  });

  it('falls back to 35_000ms on non-positive or unparseable env values, with warn', async () => {
    process.env.BACKFILL_LML_PER_CALL_TIMEOUT_MS = '0';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mockLookup = jest.fn().mockResolvedValue({ matches: [] });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Stereolab');

    expect(mockLookup).toHaveBeenCalledWith(
      'Stereolab',
      undefined,
      undefined,
      expect.objectContaining({ timeoutMs: 35_000 })
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BACKFILL_LML_PER_CALL_TIMEOUT_MS=0'));
  });

  it('rejects partial-parse strings like "35000banana" (no silent coercion)', async () => {
    process.env.BACKFILL_LML_PER_CALL_TIMEOUT_MS = '35000banana';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mockLookup = jest.fn().mockResolvedValue({ matches: [] });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Cat Power');

    // "35000banana" → NaN under Number(), not 35000 under parseInt; falls back.
    expect(mockLookup).toHaveBeenCalledWith(
      'Cat Power',
      undefined,
      undefined,
      expect.objectContaining({ timeoutMs: 35_000 })
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BACKFILL_LML_PER_CALL_TIMEOUT_MS=35000banana'));
  });

  it('passes the backfill limiter through alongside the timeout', async () => {
    delete process.env.BACKFILL_LML_PER_CALL_TIMEOUT_MS;
    const mockLookup = jest.fn().mockResolvedValue({ matches: [] });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Chuquimamani-Condori', 'Edits', 'Call Your Name');

    const callArgs = mockLookup.mock.calls[0][3];
    expect(callArgs).toHaveProperty('limiter');
    expect(callArgs.limiter).toBeDefined();
    expect(callArgs).toHaveProperty('timeoutMs', 35_000);
  });
});

describe('jobs/flowsheet-metadata-backfill/lml-fetch (run-scoped (artist, album) dedup)', () => {
  // Peer ticket to BS#1011; see plans/flowsheet-backfill-lookup-dedup.md.
  // These tests pin: (1) cache miss calls LML and stores; (2) cache hit
  // does NOT call LML and returns stripped response; (3) LML error does
  // NOT poison the cache; (4) different track on same (artist, album)
  // is a cache hit (track is not part of the dedup key); (5) tests
  // construct their own `LookupCache` rather than mutate the singleton.

  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  type FetchModule = typeof import('../../../../jobs/flowsheet-metadata-backfill/lml-fetch.js');

  const fullResponse = {
    results: [
      {
        library_item: {
          id: 1,
          call_number: 'Rock CD ABC 123/45',
          library_url: 'https://wxyc.org/library/1',
        },
        artwork: {
          release_id: 555,
          release_url: 'https://www.discogs.com/release/555',
          confidence: 0.92,
          artwork_url: 'https://discogs.example/cover.jpg',
          release_year: 1988,
          spotify_url: 'https://open.spotify.com/album/xyz',
          youtube_music_url: 'https://music.youtube.com/playlist?list=xyz',
          bandcamp_url: 'https://example.bandcamp.com/album/xyz',
          soundcloud_url: 'https://soundcloud.com/example/sets/xyz',
          apple_music_url: 'https://music.apple.com/album/xyz',
        },
      },
    ],
    search_type: 'direct',
    song_not_found: false,
    found_on_compilation: false,
  };

  const loadModule = async (mockLookup: jest.Mock): Promise<FetchModule> => {
    jest.doMock('../../../../jobs/flowsheet-metadata-backfill/lml-limiter.js', () => ({
      defaultLmlLimiter: { run: jest.fn() },
    }));
    jest.doMock('@wxyc/lml-client', () => ({
      lookupMetadata: mockLookup,
    }));
    return import('../../../../jobs/flowsheet-metadata-backfill/lml-fetch.js');
  };

  const freshCache = async (
    fetchMod: FetchModule
  ): Promise<import('../../../../jobs/flowsheet-metadata-backfill/lookup-cache.js').LookupCache> => {
    // Mutating the singleton across tests leaks state. Drop in a fresh
    // instance per test.
    const { LookupCache } = await import('../../../../jobs/flowsheet-metadata-backfill/lookup-cache.js');
    const cache = new LookupCache();
    fetchMod.__setLookupCacheForTesting(cache);
    return cache;
  };

  it('miss → call LML once, store, return raw response', async () => {
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    const result = await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Teen Age Riot');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(result.results[0].artwork?.release_id).toBe(555);
    // First call returns raw — stripping only applies on cache reads.
    expect(result.results[0].artwork?.spotify_url).toBe('https://open.spotify.com/album/xyz');
    expect(cache.stats()).toEqual({ size: 1, hits: 0, misses: 1 });
  });

  it('hit → no LML call, returns stripped response, increments hit counter', async () => {
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Teen Age Riot');
    const second = await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Silver Rocket');

    expect(mockLookup).toHaveBeenCalledTimes(1); // not called for the second
    expect(second.results[0].artwork?.release_id).toBe(555);
    // Stripping on cache hit — enrich.ts's ?? fallback synthesizes per row.
    expect(second.results[0].artwork?.spotify_url).toBeUndefined();
    expect(second.results[0].artwork?.youtube_music_url).toBeUndefined();
    expect(second.results[0].artwork?.bandcamp_url).toBeUndefined();
    expect(second.results[0].artwork?.soundcloud_url).toBeUndefined();
    expect(cache.stats()).toEqual({ size: 1, hits: 1, misses: 1 });
  });

  it('different track on same (artist, album) is a hit (track is not part of the key)', async () => {
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Teen Age Riot');
    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Silver Rocket');
    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Eric’s Trip');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ size: 1, hits: 2, misses: 1 });
  });

  it('LML error does not poison the cache (size + hit counters unchanged)', async () => {
    const mockLookup = jest.fn().mockRejectedValue(new Error('LML 503'));
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await expect(fetchMod.lookupMetadata('Foo', 'Bar', 'Baz')).rejects.toThrow('LML 503');

    // The miss is still counted (we did look in the cache). The error
    // must not have left anything behind.
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 1 });
    expect(mockLookup).toHaveBeenCalledTimes(1);

    // A second call on the same key still goes to LML.
    await expect(fetchMod.lookupMetadata('Foo', 'Bar', 'Baz')).rejects.toThrow('LML 503');
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it('caches no-match (empty results) responses too', async () => {
    // Plan: an LML no-match for (artist, album) is just as worth caching
    // as a match. Otherwise the 73.6% no-match-rate residual gets retried
    // 1.74× per (artist, album) for no gain.
    const noMatch = {
      results: [],
      search_type: 'none',
      song_not_found: true,
      found_on_compilation: false,
    };
    const mockLookup = jest.fn().mockResolvedValue(noMatch);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await fetchMod.lookupMetadata('Unknown', 'Unknown', 'a');
    const second = await fetchMod.lookupMetadata('Unknown', 'Unknown', 'b');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(second.results).toEqual([]);
    expect(second.song_not_found).toBe(true);
    expect(cache.stats()).toEqual({ size: 1, hits: 1, misses: 1 });
  });
});
