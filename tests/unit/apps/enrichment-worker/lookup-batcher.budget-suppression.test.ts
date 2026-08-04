/**
 * Wire-layer tests for BS#1978's `ENRICHMENT_SUPPRESS_LML_BUDGET` flag.
 *
 * `lookup-batcher.test.ts` mocks `@wxyc/lml-client` wholesale and only
 * inspects the OPTIONS OBJECT `dispatchChunk` hands to `bulkLookupMetadata` —
 * that proves what this module INTENDS to send, not what actually reaches
 * LML. This file deliberately does NOT mock `@wxyc/lml-client`: it imports
 * the real `bulkLookupMetadata` implementation and intercepts `global.fetch`
 * instead (mirroring `tests/unit/services/lml.client.test.ts`'s wire-layer
 * pattern), so the assertions are on the actual HTTP request headers —
 * catching a regression where the options object looks right but
 * `resolveCallBudgetMs` / `sanitizeCallBudgetMs` / `buildLookupHeaders`
 * (`shared/lml-client/src`) don't thread it through to the wire correctly.
 *
 * Also pins the BS#1978 acceptance criterion that suppression is scoped to
 * THIS worker's call site (`dispatchChunk`), never the shared client or any
 * other class-5 caller: every other registered class-5 caller keeps sending
 * `X-Caller-Budget-Ms` even with the flag globally set, and even calling
 * `bulkLookupMetadata` directly with `caller: 'enrichment-worker'` (bypassing
 * `dispatchChunk` entirely) is unaffected — the shared client itself has no
 * knowledge of `ENRICHMENT_SUPPRESS_LML_BUDGET`.
 */
import { jest } from '@jest/globals';

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch;

// Same minimal @sentry/node stand-in as tests/unit/services/lml.client.test.ts —
// @wxyc/lml-client's real implementation calls Sentry.startSpan(opts, callback)
// and expects the callback's return value back.
const mockSpanSetAttributes = jest.fn();
type SpanLike = { setAttributes: typeof mockSpanSetAttributes };
jest.mock('@sentry/node', () => ({
  startSpan: async (_opts: { name: string; op: string }, callback: (span: SpanLike) => unknown) =>
    await callback({ setAttributes: mockSpanSetAttributes }),
}));

import { bulkLookupMetadata, ALL_LML_CALLERS, LML_CALLER_POLICY, type LmlCaller } from '@wxyc/lml-client';
import {
  enrichmentBulkLookup,
  _resetLookupBatcherForTest,
  ENRICHMENT_BULK_WINDOW_MS,
} from '../../../../apps/enrichment-worker/lookup-batcher';

const makeInput = (artist: string) => ({ artist_name: artist, album_title: null, track_title: null });

const okEmptyResponse = () =>
  ({
    ok: true,
    json: () => Promise.resolve({ results: [] }),
  }) as unknown as globalThis.Response;

/**
 * Advance past the flush window and let the promise chain settle. The stub
 * fetch response above carries no verdict for index 0, so `enrichmentBulkLookup`
 * always rejects here — only the wire request shape is under test, so the
 * rejection is swallowed rather than asserted on.
 */
const flushAndSettle = async (pending: Promise<unknown>) => {
  jest.advanceTimersByTime(ENRICHMENT_BULK_WINDOW_MS);
  await pending.catch(() => undefined);
};

describe('dispatchChunk X-Caller-Budget-Ms suppression (BS#1978)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.useFakeTimers();
    _resetLookupBatcherForTest();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okEmptyResponse());
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
  });

  it('flag ON: the real bulkLookupMetadata wire request omits X-Caller-Budget-Ms', async () => {
    process.env.ENRICHMENT_SUPPRESS_LML_BUDGET = 'true';

    await flushAndSettle(enrichmentBulkLookup(makeInput('Chuquimamani-Condori')));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1];
    if (!init) throw new Error('mockFetch was not called with init args');
    expect(Object.keys((init.headers as Record<string, string>) ?? {})).not.toContain('X-Caller-Budget-Ms');
  });

  it('flag OFF (unset, the default): still sends X-Caller-Budget-Ms at the enrichment-worker class-5 default', async () => {
    delete process.env.ENRICHMENT_SUPPRESS_LML_BUDGET;

    await flushAndSettle(enrichmentBulkLookup(makeInput('Csillagrablók')));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1];
    if (!init) throw new Error('mockFetch was not called with init args');
    expect(init.headers).toMatchObject({ 'X-Caller-Budget-Ms': '28000' });
  });

  it('flag "false": still sends the header — only the exact string "true" arms suppression', async () => {
    process.env.ENRICHMENT_SUPPRESS_LML_BUDGET = 'false';

    await flushAndSettle(enrichmentBulkLookup(makeInput('Hermanos Gutiérrez')));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1];
    if (!init) throw new Error('mockFetch was not called with init args');
    expect(init.headers).toMatchObject({ 'X-Caller-Budget-Ms': '28000' });
  });

  describe('suppression is scoped to this call site only (BS#1978 acceptance criterion)', () => {
    // Derived, not hardcoded, so a future class-default change (a caller
    // moving into or out of class 5) can't silently widen or narrow what
    // this guards without also touching this test.
    const class5Callers = ALL_LML_CALLERS.filter((caller) => LML_CALLER_POLICY[caller].class === 5);
    const otherClass5Callers = class5Callers.filter((caller) => caller !== 'enrichment-worker');

    it('every class-5 caller resolves to a defined policy budgetMs (the flag never touches policy.ts)', () => {
      expect(class5Callers.length).toBeGreaterThan(0);
      for (const caller of class5Callers) {
        expect(LML_CALLER_POLICY[caller].budgetMs).toBeDefined();
      }
    });

    it.each(otherClass5Callers)(
      '%s: still sends X-Caller-Budget-Ms via a direct bulkLookupMetadata call even when ENRICHMENT_SUPPRESS_LML_BUDGET=true',
      async (caller: LmlCaller) => {
        process.env.ENRICHMENT_SUPPRESS_LML_BUDGET = 'true';
        mockFetch.mockResolvedValueOnce(okEmptyResponse());

        // No budgetMs override here — this caller's OWN job code never reads
        // ENRICHMENT_SUPPRESS_LML_BUDGET, so it inherits the class-5 policy
        // default exactly as it does today, flag or no flag.
        await bulkLookupMetadata([{ raw_message: 'A - X', extended: true }], { caller });

        const init = mockFetch.mock.calls[0][1];
        if (!init) throw new Error('mockFetch was not called with init args');
        const expectedBudget = LML_CALLER_POLICY[caller].budgetMs;
        expect(init.headers).toMatchObject({ 'X-Caller-Budget-Ms': String(expectedBudget) });
      }
    );

    it("calling bulkLookupMetadata directly with caller: 'enrichment-worker' (bypassing dispatchChunk) also still sends the header — the shared client itself has no knowledge of the flag", async () => {
      process.env.ENRICHMENT_SUPPRESS_LML_BUDGET = 'true';
      mockFetch.mockResolvedValueOnce(okEmptyResponse());

      await bulkLookupMetadata([{ raw_message: 'A - X', extended: true }], { caller: 'enrichment-worker' });

      const init = mockFetch.mock.calls[0][1];
      if (!init) throw new Error('mockFetch was not called with init args');
      expect(init.headers).toMatchObject({ 'X-Caller-Budget-Ms': '28000' });
    });
  });
});
