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
