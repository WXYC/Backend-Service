/**
 * Payload pin for the streaming-url-upgrade LML shim (BS#1672).
 *
 * The job re-runs the same full `/api/v1/lookup` with artist + album + song
 * and `extended: true` the enrichment worker walked when it persisted the
 * search URL. This suite pins the shim's pass-through so a dropped `extended`
 * flag (or a swallowed track title, which would change which per-track URL
 * LML verifies) breaks CI instead of silently degrading the re-query. Mock
 * pattern mirrors tests/unit/jobs/apple-music-url-backfill/lml-fetch.test.ts.
 */

const emptyResponse = {
  results: [],
  search_type: 'none',
  song_not_found: true,
};

describe('jobs/streaming-url-upgrade/lml-fetch payload contract', () => {
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
  ): Promise<typeof import('../../../../jobs/streaming-url-upgrade/lml-fetch.js')> => {
    // Mock the local limiter module — we only care about the args passed to
    // sharedLookupMetadata. Avoids stubbing all of @wxyc/lml-client's
    // exports (Semaphore, TokenBucket, createLmlLimiter) that lml-limiter.ts
    // pulls in at module load.
    jest.doMock('../../../../jobs/streaming-url-upgrade/lml-limiter.js', () => ({
      defaultLmlLimiter: { run: jest.fn() },
    }));
    jest.doMock('@wxyc/lml-client', () => ({
      lookupMetadata: mockLookup,
    }));
    return import('../../../../jobs/streaming-url-upgrade/lml-fetch.js');
  };

  it('forwards artist + album + song positionally and sets extended: true (the issue contract)', async () => {
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Jessica Pratt', 'On Your Own Love Again', 'Back, Baby');

    expect(mockLookup).toHaveBeenCalledWith(
      'Jessica Pratt',
      'On Your Own Love Again',
      'Back, Baby',
      expect.objectContaining({ extended: true, caller: 'streaming-url-upgrade' })
    );
  });

  it('album-phase shape: album without track still carries extended: true', async () => {
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Juana Molina', 'DOGA');

    expect(mockLookup).toHaveBeenCalledWith(
      'Juana Molina',
      'DOGA',
      undefined,
      expect.objectContaining({ extended: true })
    );
  });

  it('passes the default 35_000ms per-call timeout when UPGRADE_LML_PER_CALL_TIMEOUT_MS is unset', async () => {
    delete process.env.UPGRADE_LML_PER_CALL_TIMEOUT_MS;
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Stereolab', 'Aluminum Tunes');

    expect(mockLookup).toHaveBeenCalledWith(
      'Stereolab',
      'Aluminum Tunes',
      undefined,
      expect.objectContaining({ timeoutMs: 35_000 })
    );
  });

  it('routes through the job-owned limiter (shared UPGRADE_LML_* envelope)', async () => {
    const mockLookup = jest.fn().mockResolvedValue(emptyResponse);

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Chuquimamani-Condori', 'Edits', 'Call Your Name');

    const options = mockLookup.mock.calls[0]?.[3] as { limiter?: unknown };
    expect(options.limiter).toBeDefined();
  });
});
