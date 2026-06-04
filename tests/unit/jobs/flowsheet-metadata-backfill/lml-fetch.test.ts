// Unit tests for the backfill's per-call LML timeout (BS#994 / BS#1180)
// and the run-scoped (artist, album) dedup cache (peer ticket to BS#1011).
//
// Verifies that `lookupMetadata` passes a per-call timeoutMs through to
// `@wxyc/lml-client`. BS#994 introduced the per-call knob; BS#1180 retuned
// the default from 8000ms → 35_000ms after LML#370 capped per-item cascade
// exhaustion at 25.25s — the prior 8s budget aborted before LML could
// return its `{timeout:true, results:[]}` body, leaving rows unmarked.

const emptyResponse = {
  results: [],
  search_type: 'none',
  song_not_found: true,
  found_on_compilation: false,
};

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
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

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
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

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
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

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
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

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
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

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
  // These tests pin:
  //   1. cache miss calls LML and stores; the LookupResult returns cacheHit=false
  //   2. cache hit does NOT call LML and returns stripped response; cacheHit=true
  //   3. LML throw does NOT poison the cache (size + misses + hits unchanged)
  //   4. different track on same (artist, album) is a cache hit
  //   5. LML cascade-timeout response (`timeout: true`) is NOT cached
  //   6. apple_music_url is stripped on cache hit (BS#1192 — track-aware URL)
  //   7. __setLookupCacheForTesting throws outside NODE_ENV=test
  //   8. tests construct their own LookupCache rather than mutate the singleton

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
          apple_music_url: 'https://music.apple.com/album/xyz?i=track-A',
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

  it('miss → call LML once, store, return raw response with cacheHit=false', async () => {
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    const { response, cacheHit } = await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Teen Age Riot');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(cacheHit).toBe(false);
    expect(response.results[0].artwork?.release_id).toBe(555);
    // First call returns raw — stripping only applies on cache reads.
    expect(response.results[0].artwork?.spotify_url).toBe('https://open.spotify.com/album/xyz');
    expect(response.results[0].artwork?.apple_music_url).toBe('https://music.apple.com/album/xyz?i=track-A');
    expect(cache.stats()).toEqual({ size: 1, hits: 0, misses: 1, overwrites: 0 });
  });

  it('hit → no LML call, returns stripped response with cacheHit=true', async () => {
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Teen Age Riot');
    const { response, cacheHit } = await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Silver Rocket');

    expect(mockLookup).toHaveBeenCalledTimes(1); // not called for the second
    expect(cacheHit).toBe(true);
    expect(response.results[0].artwork?.release_id).toBe(555);
    // Stripping on cache hit — enrich.ts's ?? fallback synthesizes per row,
    // and apple_music_url falls to null (BS#1192 load-bearing).
    const artwork = response.results[0].artwork;
    expect(artwork && 'spotify_url' in artwork).toBe(false);
    expect(artwork && 'youtube_music_url' in artwork).toBe(false);
    expect(artwork && 'bandcamp_url' in artwork).toBe(false);
    expect(artwork && 'soundcloud_url' in artwork).toBe(false);
    expect(artwork && 'apple_music_url' in artwork).toBe(false);
    expect(cache.stats()).toEqual({ size: 1, hits: 1, misses: 1, overwrites: 0 });
  });

  it('different track on same (artist, album) is a hit (track is not part of the key)', async () => {
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Teen Age Riot');
    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Silver Rocket');
    await fetchMod.lookupMetadata('Sonic Youth', 'Daydream Nation', 'Eric’s Trip');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ size: 1, hits: 2, misses: 1, overwrites: 0 });
  });

  it('LML error does not poison the cache (size + misses + hits all 0)', async () => {
    const mockLookup = jest.fn().mockRejectedValue(new Error('LML 503'));
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await expect(fetchMod.lookupMetadata('Foo', 'Bar', 'Baz')).rejects.toThrow('LML 503');

    // Pre-fix this asserted misses: 1 — but counting an error as a miss
    // conflates 'genuinely missed' with 'upstream broken' and corrupts
    // the post-deploy verification recipe (hit-rate metric). misses is
    // now bumped inside set() only, so an LML throw leaves it at 0.
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0, overwrites: 0 });
    expect(mockLookup).toHaveBeenCalledTimes(1);

    // A second call on the same key still goes to LML.
    await expect(fetchMod.lookupMetadata('Foo', 'Bar', 'Baz')).rejects.toThrow('LML 503');
    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0, overwrites: 0 });
  });

  it('caches no-match (empty results) responses too', async () => {
    // An LML no-match for (artist, album) is worth caching: the 73.6%
    // no-match-rate residual would otherwise be retried 1.74× per pair.
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await fetchMod.lookupMetadata('Unknown', 'Unknown', 'a');
    const { response, cacheHit } = await fetchMod.lookupMetadata('Unknown', 'Unknown', 'b');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(cacheHit).toBe(true);
    expect(response.results).toEqual([]);
    expect(response.song_not_found).toBe(true);
    expect(cache.stats()).toEqual({ size: 1, hits: 1, misses: 1, overwrites: 0 });
  });

  it('does NOT cache responses signaling upstream cascade timeout (timeout: true)', async () => {
    // LML#370: when the Discogs cascade exhausts its per-item budget,
    // LML returns a 200 OK with `{timeout: true, results: []}`. This is
    // operationally identical to no-match at the shape level, but it
    // represents transient LML degradation, not a confirmed answer.
    // Caching one would permanently seal the (artist, album) as
    // no-match for the rest of the run + stamp the rows so future runs
    // also skip them. Pre-PR the cron would have retried under relaxed
    // load on the next pass.
    const timeoutResponse = {
      ...emptyResponse,
      timeout: true,
    };
    const mockLookup = jest.fn().mockResolvedValue(timeoutResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    const first = await fetchMod.lookupMetadata('Slow', 'Album', 'a');
    expect(first.cacheHit).toBe(false);
    expect(first.response.results).toEqual([]);
    // Cache size + counters all zero — the response went straight back
    // to the orchestrator without entering the dedup store.
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0, overwrites: 0 });

    // A second call on the same key still goes to LML.
    const second = await fetchMod.lookupMetadata('Slow', 'Album', 'b');
    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(second.cacheHit).toBe(false);
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0, overwrites: 0 });
  });

  it('a real no-match on the same key as a prior timeout response gets cached (the timeout did not block future caching)', async () => {
    // Sanity check: after a transient timeout we should still be able to
    // cache the next non-timeout response, including a legitimate no-match.
    const mockLookup = jest
      .fn()
      .mockResolvedValueOnce({ ...emptyResponse, timeout: true })
      .mockResolvedValueOnce(emptyResponse);
    const fetchMod = await loadModule(mockLookup);
    const cache = await freshCache(fetchMod);

    await fetchMod.lookupMetadata('Flaky', 'Album', 'a'); // timeout — not cached
    await fetchMod.lookupMetadata('Flaky', 'Album', 'b'); // real no-match — cached
    expect(cache.stats()).toEqual({ size: 1, hits: 0, misses: 1, overwrites: 0 });

    // Third call hits the cache.
    const third = await fetchMod.lookupMetadata('Flaky', 'Album', 'c');
    expect(third.cacheHit).toBe(true);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it('__setLookupCacheForTesting throws outside NODE_ENV=test', async () => {
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    const { LookupCache } = await import('../../../../jobs/flowsheet-metadata-backfill/lookup-cache.js');
    const cache = new LookupCache();

    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => fetchMod.__setLookupCacheForTesting(cache)).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('production wiring: getLookupCache().stats() reflects actual lookupMetadata gets/sets', async () => {
    // Pins the integration that job.ts depends on:
    //   `cacheStats: () => getLookupCache().stats()` reads from the same
    //   cache that `lookupMetadata` reads/writes. Without this test, a
    //   future regression in `getLookupCache()` (e.g. returning the wrong
    //   `let` binding, or `let activeCache` being undefined after a
    //   refactor) would slip through every hand-stubbed cacheStats mock.
    const mockLookup = jest.fn().mockResolvedValue(fullResponse);
    const fetchMod = await loadModule(mockLookup);
    await freshCache(fetchMod);

    // Empty cache.
    expect(fetchMod.getLookupCache().stats()).toEqual({ size: 0, hits: 0, misses: 0, overwrites: 0 });

    await fetchMod.lookupMetadata('A', 'X');
    expect(fetchMod.getLookupCache().stats()).toEqual({ size: 1, hits: 0, misses: 1, overwrites: 0 });

    await fetchMod.lookupMetadata('A', 'X');
    expect(fetchMod.getLookupCache().stats()).toEqual({ size: 1, hits: 1, misses: 1, overwrites: 0 });

    await fetchMod.lookupMetadata('B', 'Y');
    expect(fetchMod.getLookupCache().stats()).toEqual({ size: 2, hits: 1, misses: 2, overwrites: 0 });
  });
});
