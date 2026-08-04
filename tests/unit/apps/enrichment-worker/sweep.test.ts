/**
 * Unit tests for enrichment-worker sweep.ts (BS#1225 / Epic C C6 split).
 *
 * Pins the stranded-claim recovery query shape so a schema change or an
 * accidental WHERE-loosening fails CI before deploy.
 *
 * The sweep flips `metadata_status='enriching'` rows whose `enriching_since`
 * is older than `STRANDED_TTL_SECONDS` back to `'pending'` (and NULLs
 * `enriching_since`). The TTL is derived from `ENRICHMENT_LML_BUDGET_MS`
 * with a floor of 60s to keep the invariant `TTL > LML budget`. Without
 * this sweep, every LML throw or worker SIGTERM leaks a row in
 * `enriching` forever — the C2 worker (#892) documents this in
 * `handler.ts:90-115` and tests/integration/enrichment-worker-claim.spec.js
 * exercises the SQL inline.
 *
 * Three contract guarantees pinned here:
 *   1. WHERE narrows by `metadata_status='enriching'`. Loosening this would
 *      revert terminal rows back to pending, re-enqueueing finished work.
 *   2. WHERE narrows by `enriching_since < now() - <interval>` (subtraction
 *      direction matters — flipping to `>` would revert in-flight claims
 *      and leave stale ones untouched).
 *   3. SET writes `metadata_status='pending'` AND `enriching_since=NULL`.
 *      Forgetting the NULL would leave a stale enriching_since the next
 *      claim-then-strand cycle has to overwrite.
 *
 * Integration coverage of the end-to-end recovery cycle (claim → strand →
 * sweep → re-claim) lives in `tests/integration/enrichment-worker-sweep.spec.js`.
 */
import { jest } from '@jest/globals';

import { db, flowsheet } from '@wxyc/database';
import { resolveLmlPolicy, LML_LIMITER_MAX_QUEUE_WAIT_MS_DEFAULT } from '@wxyc/lml-client';
import { sweepStrandedClaims, STRANDED_TTL_SECONDS } from '../../../../apps/enrichment-worker/sweep';

type SqlLike = {
  sql?: string | string[];
  queryChunks?: Array<string | { value?: string | string[] }>;
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: { set: jest.Mock; where: jest.Mock; returning: jest.Mock };
};

describe('sweepStrandedClaims (BS#1225)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates the flowsheet table', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    await sweepStrandedClaims();

    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
  });

  it('SET flips metadata_status back to pending and NULLs enriching_since', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    await sweepStrandedClaims();

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('pending');
    expect(setCall.enriching_since).toBeNull();
  });

  it('WHERE references the enriching guard, the cutoff direction, and an interval', async () => {
    // The WHERE uses a raw `sql\`...\`` chunk (codebase convention for
    // multi-predicate partial-index queries; mirrors the `schema.ts`
    // index definitions). Render the chunk and assert the
    // metadata_status='enriching' guard, the `<` cutoff direction, and
    // an interval subtraction are all present — a "drop the status
    // guard" or "swap `<` for `>`" edit is caught here.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    await sweepStrandedClaims();

    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    expect(whereArg).toBeDefined();
    const rendered = renderSql(whereArg);
    // The renderer drops column refs and bound params, so the rendered
    // string is the static SQL between interpolations: e.g.
    //   " = 'enriching' AND  < now() - make_interval(secs => )"
    // Assert the enum literal, the cutoff operator + direction, and the
    // interval subtraction — these three together pin both the status
    // guard and the `enriching_since < now() - interval` shape. A swap
    // to `>` or to `now() + interval` fails the regex below.
    expect(rendered).toContain("'enriching'");
    expect(rendered).toMatch(/<\s+now\(\)\s*-\s*make_interval/);
  });

  it('returns the recovered row count', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const recovered = await sweepStrandedClaims();

    expect(recovered).toBe(3);
  });

  it('returns 0 when nothing was stranded', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const recovered = await sweepStrandedClaims();

    expect(recovered).toBe(0);
  });

  it('propagates DB errors instead of swallowing them', async () => {
    const dbError = new Error('connection refused');
    mockDb._chain.returning.mockRejectedValueOnce(dbError);

    await expect(sweepStrandedClaims()).rejects.toThrow('connection refused');
  });

  describe('STRANDED_TTL_SECONDS derivation (BS#1826 PR 2)', () => {
    // Pre-PR2, `sweep.ts` and `lookup-batcher.ts` each read
    // `envInt('ENRICHMENT_LML_BUDGET_MS', 29000)` independently — two
    // module-level reads of the same env var that could desync if an
    // operator (or a test) overrode only one process's env. PR 2 collapses
    // both to the SAME source of truth: the `enrichment-worker` class-5
    // entry in the per-caller policy layer (`@wxyc/lml-client` `policy.ts`).
    // These tests pin that derivation directly, independent of the
    // `sweepStrandedClaims` SQL-shape tests above.

    it("derives from resolveLmlPolicy('enrichment-worker').budgetMs, not a locally-duplicated constant", () => {
      const { budgetMs } = resolveLmlPolicy('enrichment-worker');
      if (budgetMs === undefined) throw new Error('expected the enrichment-worker class-5 entry to set budgetMs');
      expect(STRANDED_TTL_SECONDS).toBe(Math.max(60, Math.ceil(budgetMs / 1000) + 30));
    });

    it('exceeds the enrichment-worker policy budget — the load-bearing TTL > LML_BUDGET invariant', () => {
      const { budgetMs } = resolveLmlPolicy('enrichment-worker');
      if (budgetMs === undefined) throw new Error('expected the enrichment-worker class-5 entry to set budgetMs');
      expect(STRANDED_TTL_SECONDS).toBeGreaterThan(budgetMs / 1000);
    });

    it('matches the documented class-5 defaults (28000ms budget -> 60s TTL floor)', () => {
      // Regression pin for the concrete numbers: class 5's default budgetMs
      // is timeoutMs(29000) - 1000 = 28000, so ceil(28000/1000)+30 = 58,
      // which the 60s floor overrides — identical to the pre-PR2 constant
      // (29000ms budget -> ceil(29)+30=59, also floored to 60), so this
      // migration does not change the sweep's real-world TTL.
      expect(resolveLmlPolicy('enrichment-worker').budgetMs).toBe(28000);
      expect(STRANDED_TTL_SECONDS).toBe(60);
    });
  });

  describe('STRANDED_TTL_SECONDS verified against a suppressed budget (BS#1978)', () => {
    // BS#1978's ENRICHMENT_SUPPRESS_LML_BUDGET flag adds a PER-CALL
    // `budgetMs: null` override at lookup-batcher.ts's dispatchChunk call
    // site — it does not touch shared/lml-client/src/policy.ts's table.
    // STRANDED_TTL_SECONDS derives from resolveLmlPolicy('enrichment-worker')
    // .budgetMs (the TABLE value), which the per-call override can never
    // mutate, so this constant is byte-identical whether the flag is on or
    // off. This block exists to pin that explicitly and to verify the
    // invariant `sweep.ts`'s docstring requires (TTL > worst-case in-flight
    // time) still holds once a call can legitimately run to LML's full
    // headerless cascade instead of the ~4s empty-state cutoff.
    //
    // Worst-case suppressed in-flight arithmetic:
    //   - Suppressing the header does NOT raise any timeout — it only
    //     removes LML's empty-state cutoff (the gate armed by the header's
    //     PRESENCE, not magnitude; see policy.ts's BS#1914 "CORRECTED MODEL").
    //     A genuine hard miss now falls through to LML's own hard cap,
    //     `LML_SEARCH_HARD_TIMEOUT_MS` (default 25000ms, unset in prod).
    //   - But the load-bearing ceiling for "how long can a suppressed call
    //     hold a defaultLimiter permit" is NOT that 25s LML-side cap — it's
    //     this client's class-5 `timeoutMs` (29000ms), because the
    //     AbortController in `lmlFetch` fires at 29s regardless of whether
    //     LML itself would have given up sooner. 29s > 25s, so the client
    //     timeout is the true dominant bound.
    //   - On top of that, a call can spend up to `LML_LIMITER_MAX_QUEUE_WAIT_MS`
    //     (5000ms default) waiting for a permit on the shared `defaultLimiter`
    //     BEFORE the LML call even starts (BS#1748 admission bound), so the
    //     full worst-case wall-clock time from `enrichmentBulkLookup` to a
    //     settled promise is 29000 + 5000 = 34000ms.
    //   - 34000ms must stay comfortably under STRANDED_TTL_SECONDS * 1000
    //     (60000ms) or the sweep could revert a still-in-flight suppressed
    //     claim back to 'pending' (see sweep.ts's TTL-derivation docstring
    //     for why that race matters — it silently no-ops the worker's
    //     eventual finalize UPDATE and wastes the LML token spend).
    const SUPPRESSED_CLIENT_TIMEOUT_MS = 29_000;
    const WORST_CASE_SUPPRESSED_INFLIGHT_MS = SUPPRESSED_CLIENT_TIMEOUT_MS + LML_LIMITER_MAX_QUEUE_WAIT_MS_DEFAULT;

    it("suppressing the header does not change resolveLmlPolicy('enrichment-worker').budgetMs or STRANDED_TTL_SECONDS", () => {
      // The flag lives entirely in lookup-batcher.ts's dispatchChunk; this
      // module (sweep.ts) never reads ENRICHMENT_SUPPRESS_LML_BUDGET and
      // needed no code change for BS#1978. Pin both derived values so a
      // future refactor that accidentally threads the flag into policy.ts
      // (which WOULD change this) fails here.
      expect(resolveLmlPolicy('enrichment-worker').budgetMs).toBe(28000);
      expect(STRANDED_TTL_SECONDS).toBe(60);
    });

    it('matches the documented class-5 client timeout (29000ms) and admission bound (5000ms)', () => {
      expect(resolveLmlPolicy('enrichment-worker').timeoutMs).toBe(SUPPRESSED_CLIENT_TIMEOUT_MS);
      expect(LML_LIMITER_MAX_QUEUE_WAIT_MS_DEFAULT).toBe(5000);
      expect(WORST_CASE_SUPPRESSED_INFLIGHT_MS).toBe(34_000);
    });

    it('STRANDED_TTL_SECONDS comfortably exceeds the worst-case suppressed in-flight time (60s > 34s)', () => {
      expect(STRANDED_TTL_SECONDS * 1000).toBeGreaterThan(WORST_CASE_SUPPRESSED_INFLIGHT_MS);
      // "Comfortably" quantified: at least 25s of slack, not a near-miss.
      expect(STRANDED_TTL_SECONDS * 1000 - WORST_CASE_SUPPRESSED_INFLIGHT_MS).toBeGreaterThanOrEqual(25_000);
    });
  });
});
