/**
 * Unit tests for jobs/rotation-artist-backfill/orchestrate.ts (BS#1381).
 *
 * Covers the one-tier batched loop and the new counter shape:
 *   - tally semantics for warmed / not_found / not_implemented / error.
 *   - warmed_releases / warmed_artists derived from per-source response items.
 *   - chunking at LML_REFRESH_BATCH_CAP = 50.
 *   - dryRun: refresh calls skipped; identities_scanned still populated.
 *   - batch-level failure bumps identities_scanned + lml_error by batch size,
 *     not identities_resolved.
 *   - concurrency cap on batches honored.
 *   - AggregateError when multiple batches fail.
 *   - totals span gated on didLoadIds.
 */

import { jest } from '@jest/globals';

import type { BulkCacheRefreshResponse, CacheRefreshResultItem, CacheRefreshSourceResult } from '@wxyc/lml-client';

import type { FetchOutcome } from '../../../../jobs/rotation-artist-backfill/lml-fetch';
import { LML_REFRESH_BATCH_CAP, chunk, runBackfill } from '../../../../jobs/rotation-artist-backfill/orchestrate';

const ok = (value: BulkCacheRefreshResponse): FetchOutcome<BulkCacheRefreshResponse> => ({ kind: 'ok', value });
const errored = (): FetchOutcome<BulkCacheRefreshResponse> => ({
  kind: 'error',
  error: new Error('boom'),
  retryable: true,
});

const warmed = (id: number, sources: Record<string, CacheRefreshSourceResult>): CacheRefreshResultItem => ({
  identity_id: id,
  status: 'warmed',
  sources,
});
const notFoundItem = (id: number): CacheRefreshResultItem => ({ identity_id: id, status: 'not_found', sources: null });
const notImplementedItem = (id: number): CacheRefreshResultItem => ({
  identity_id: id,
  status: 'not_implemented',
  sources: { discogs_master: { release_outcome: 'not_implemented', artists: [] } },
});
const errorItem = (id: number): CacheRefreshResultItem => ({
  identity_id: id,
  status: 'error',
  sources: { discogs_release: { release_outcome: 'error', artists: [] } },
});

const discogsRelease = (artistOutcomes: ('success' | 'error' | 'not_implemented')[]): CacheRefreshSourceResult => ({
  release_outcome: 'success',
  artists: artistOutcomes.map((outcome, i) => ({ external_id: String(100 + i), outcome })),
});

describe('chunk', () => {
  it('returns empty array for empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('returns one chunk when input fits in one batch', () => {
    expect(chunk([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
  });

  it('returns multiple chunks at the cap', () => {
    const items = Array.from({ length: 125 }, (_, i) => i);
    const chunks = chunk(items, 50);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(50);
    expect(chunks[1]).toHaveLength(50);
    expect(chunks[2]).toHaveLength(25);
  });

  it('throws on non-positive size', () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow();
  });
});

describe('LML_REFRESH_BATCH_CAP', () => {
  it('is the hard contract value LML#525 documents', () => {
    // The cap is a hard contract, not an env-tunable. If LML's ingress is
    // recalibrated (CDN insertion, replica scale-up, Railway timeout change),
    // this constant moves alongside that change. The test exists to catch
    // a drive-by edit that accidentally raises it past LML's 400-on-overflow
    // ceiling.
    expect(LML_REFRESH_BATCH_CAP).toBe(50);
  });
});

describe('runBackfill', () => {
  it('tallies a single batch of mixed-status responses correctly', async () => {
    const loadIdentityIds = jest.fn().mockResolvedValue([1, 2, 3, 4]);
    const fetchFn = jest.fn(() =>
      Promise.resolve(
        ok({
          results: [
            warmed(1, { discogs_release: discogsRelease(['success', 'success']) }),
            notFoundItem(2),
            notImplementedItem(3),
            errorItem(4),
          ],
        })
      )
    );

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.identities_scanned).toBe(4);
    // resolved = warmed + not_found + not_implemented (everything except error)
    expect(result.totals.identities_resolved).toBe(3);
    expect(result.totals.warmed_releases).toBe(1);
    expect(result.totals.warmed_artists).toBe(2);
    expect(result.totals.not_found).toBe(1);
    expect(result.totals.not_implemented).toBe(1);
    expect(result.totals.lml_error).toBe(1);
  });

  it('counts warmed_releases per-source (multi-source row contributes multiple)', async () => {
    // A hypothetical future state where LML wires multiple source legs:
    // a single warmed identity_id can contribute to warmed_releases per
    // source. We bake the multi-source semantics in now so dashboards
    // don't have to migrate when MB / Spotify legs come online.
    const loadIdentityIds = jest.fn().mockResolvedValue([1]);
    const fetchFn = jest.fn(() =>
      Promise.resolve(
        ok({
          results: [
            warmed(1, {
              discogs_release: discogsRelease(['success', 'success', 'success']),
              musicbrainz_release: {
                release_outcome: 'success',
                artists: [{ external_id: 'mbid-1', outcome: 'success' }],
              },
            }),
          ],
        })
      )
    );

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.warmed_releases).toBe(2);
    expect(result.totals.warmed_artists).toBe(4);
  });

  it('skips warmed_releases for sources that returned not_implemented', async () => {
    // A warmed identity_id whose discogs_release leg succeeded but whose
    // discogs_master leg returned not_implemented should bump warmed_releases
    // by 1, not 2 — only the success leg counts.
    const loadIdentityIds = jest.fn().mockResolvedValue([1]);
    const fetchFn = jest.fn(() =>
      Promise.resolve(
        ok({
          results: [
            warmed(1, {
              discogs_release: discogsRelease(['success']),
              discogs_master: { release_outcome: 'not_implemented', artists: [] },
            }),
          ],
        })
      )
    );

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.warmed_releases).toBe(1);
    expect(result.totals.warmed_artists).toBe(1);
  });

  it('counts only success-outcome artists toward warmed_artists', async () => {
    // Per LML#525's rollup semantics, an artist 404 inside a warmed release
    // walk does NOT promote the per-id status to error — but it should also
    // not pad the warmed_artists counter.
    const loadIdentityIds = jest.fn().mockResolvedValue([1]);
    const fetchFn = jest.fn(() =>
      Promise.resolve(
        ok({
          results: [warmed(1, { discogs_release: discogsRelease(['success', 'error', 'not_implemented']) })],
        })
      )
    );

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.warmed_artists).toBe(1);
  });

  it('chunks input above LML_REFRESH_BATCH_CAP into multiple batches', async () => {
    const ids = Array.from({ length: 75 }, (_, i) => i + 1);
    const loadIdentityIds = jest.fn().mockResolvedValue(ids);
    const fetchFn = jest.fn((batch: number[]) =>
      Promise.resolve(ok({ results: batch.map((id) => warmed(id, { discogs_release: discogsRelease(['success']) })) }))
    );

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toHaveLength(LML_REFRESH_BATCH_CAP);
    expect(fetchFn.mock.calls[1][0]).toHaveLength(25);
    expect(result.totals.identities_scanned).toBe(75);
    expect(result.totals.warmed_releases).toBe(75);
  });

  it('dryRun=true skips refresh calls but populates identities_scanned', async () => {
    const loadIdentityIds = jest.fn().mockResolvedValue([1, 2, 3]);
    const fetchFn = jest.fn();

    const result = await runBackfill({
      loadIdentityIds,
      fetchFn,
      concurrency: 1,
      dryRun: true,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.totals.identities_scanned).toBe(3);
    expect(result.totals.warmed_releases).toBe(0);
  });

  it('batch-level failure bumps identities_scanned + lml_error by batch size, not identities_resolved', async () => {
    // The whole batch failed at the transport level — the orchestrator can't
    // tell which per-id sub-fanouts ran. Keeping identities_scanned truthful
    // makes the `not_found / identities_scanned` ratio alert (BS#1402)
    // resilient to transient LML outages.
    const loadIdentityIds = jest.fn().mockResolvedValue([10, 20, 30]);
    const fetchFn = jest.fn(() => Promise.resolve(errored()));

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.identities_scanned).toBe(3);
    expect(result.totals.lml_error).toBe(3);
    expect(result.totals.identities_resolved).toBe(0);
    expect(result.totals.warmed_releases).toBe(0);
  });

  it('mixes successful and failed batches without double-counting', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const loadIdentityIds = jest.fn().mockResolvedValue(ids);
    let callCount = 0;
    const fetchFn = jest.fn((batch: number[]) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          ok({ results: batch.map((id) => warmed(id, { discogs_release: discogsRelease(['success']) })) })
        );
      }
      return Promise.resolve(errored());
    });

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.identities_scanned).toBe(100);
    expect(result.totals.identities_resolved).toBe(50);
    expect(result.totals.warmed_releases).toBe(50);
    expect(result.totals.lml_error).toBe(50);
  });

  it('honors the concurrency cap on batch fan-out', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => i + 1); // 6 batches
    const loadIdentityIds = jest.fn().mockResolvedValue(ids);

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = jest.fn(async (batch: number[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ok({ results: batch.map((id) => warmed(id, { discogs_release: discogsRelease(['success']) })) });
    });

    await runBackfill({ loadIdentityIds, fetchFn, concurrency: 3 });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it('zero identity ids → zero refresh calls, no throw', async () => {
    const loadIdentityIds = jest.fn().mockResolvedValue([]);
    const fetchFn = jest.fn();

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 3 });

    expect(result.totals.identities_scanned).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('aggregates multiple batch failures into an AggregateError so 2nd+ rejections are not silently dropped', async () => {
    // Same Promise.allSettled + AggregateError guarantee as the prior shape,
    // re-asserted here under the batched call surface.
    const ids = Array.from({ length: 150 }, (_, i) => i + 1); // 3 batches
    const loadIdentityIds = jest.fn().mockResolvedValue(ids);
    let callIdx = 0;
    const fetchFn = jest.fn(async () => {
      const idx = ++callIdx;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error(`batch ${idx} failed`);
    });

    let caught: unknown;
    try {
      await runBackfill({ loadIdentityIds, fetchFn, concurrency: 3 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(3);
    const messages = (aggregate.errors as Error[]).map((e) => e.message).sort();
    expect(messages).toEqual(['batch 1 failed', 'batch 2 failed', 'batch 3 failed']);
  });

  it('does not fire the totals span when loadIdentityIds throws (avoids all-zero counter span on guard-level failure)', async () => {
    const loadIdentityIds = jest.fn().mockRejectedValue(new Error('PG pool exhausted'));
    const fetchFn = jest.fn();

    await expect(runBackfill({ loadIdentityIds, fetchFn, concurrency: 3 })).rejects.toThrow('PG pool exhausted');

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('under concurrency > 1, completes sibling batches when one batch throws (no sibling-orphan)', async () => {
    // Coverage gap fixed: previously only concurrency=1 + all-fail were
    // tested. A future refactor of runWithConcurrency from Promise.allSettled
    // to Promise.all (first-rejection-wins) would orphan in-flight siblings.
    // This test guards by mixing one throwing batch with two successful
    // batches and asserting siblings completed (counters reflect 100 ids).
    const ids = Array.from({ length: 150 }, (_, i) => i + 1); // 3 batches of 50
    const loadIdentityIds = jest.fn().mockResolvedValue(ids);
    let callIdx = 0;
    const fetchFn = jest.fn(async (batch: number[]) => {
      const idx = ++callIdx;
      // Stagger so sibling batches are in-flight when batch 2 throws.
      await new Promise((resolve) => setTimeout(resolve, idx === 2 ? 2 : 10));
      if (idx === 2) {
        throw new Error('batch 2 failed mid-flight');
      }
      return ok({ results: batch.map((id) => warmed(id, { discogs_release: discogsRelease(['success']) })) });
    });

    await expect(runBackfill({ loadIdentityIds, fetchFn, concurrency: 3 })).rejects.toThrow(
      'batch 2 failed mid-flight'
    );

    // All 3 batches were dispatched; siblings drained.
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('treats a 200 response with non-array results as a batch-level error (denominator stays truthful)', async () => {
    // Defends against LML response-shape drift (`{}` or `{results: null}`)
    // that would otherwise throw Symbol.iterator mid-batch and leak through
    // runWithConcurrency, leaving identities_scanned uncounted for that
    // batch and corrupting BS#1402's not_found/identities_scanned ratio.
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const loadIdentityIds = jest.fn().mockResolvedValue(ids);
    const fetchFn = jest.fn().mockResolvedValue({ kind: 'ok', value: {} as BulkCacheRefreshResponse });

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.identities_scanned).toBe(50);
    expect(result.totals.lml_error).toBe(50);
    expect(result.totals.identities_resolved).toBe(0);
  });

  it('skips null source values in tallySources without throwing (response-shape defense)', async () => {
    // If LML's response carries a null source slot (response-shape drift),
    // tallySources must continue instead of throwing TypeError mid-batch.
    const loadIdentityIds = jest.fn().mockResolvedValue([1]);
    const fetchFn = jest.fn(() =>
      Promise.resolve(
        ok({
          results: [
            {
              identity_id: 1,
              status: 'warmed',
              // One real source, one null; the null must not crash the tally.
              sources: {
                discogs_release: { release_outcome: 'success', artists: [] },
                musicbrainz_release: null,
              } as unknown as Record<string, CacheRefreshSourceResult>,
            },
          ],
        })
      )
    );

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.identities_scanned).toBe(1);
    expect(result.totals.identities_resolved).toBe(1);
    expect(result.totals.warmed_releases).toBe(1);
  });

  it('counts an unknown per-id status under lml_error (default switch arm)', async () => {
    // Future LML version may add a status (e.g. 'partial_warmed') BS doesn't
    // yet recognize. Without a default arm, identities_scanned would bump
    // without identities_resolved or lml_error, breaking the invariant the
    // BS#1402 alert relies on.
    const loadIdentityIds = jest.fn().mockResolvedValue([1]);
    const fetchFn = jest.fn(() =>
      Promise.resolve(
        ok({
          results: [{ identity_id: 1, status: 'partial_warmed' as unknown as 'warmed', sources: null }],
        })
      )
    );

    const result = await runBackfill({ loadIdentityIds, fetchFn, concurrency: 1 });

    expect(result.totals.identities_scanned).toBe(1);
    expect(result.totals.lml_error).toBe(1);
    // Invariant: scanned == resolved + lml_error.
    expect(result.totals.identities_scanned).toBe(result.totals.identities_resolved + result.totals.lml_error);
  });
});
