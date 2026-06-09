/**
 * Unit tests for jobs/rotation-artist-backfill/orchestrate.ts (BS#1361).
 *
 * Covers the two-tier loop and the counter shape:
 *   - releases tier: ok / not_found / error counters.
 *   - artists tier: ok / not_found / error counters; dedup across releases.
 *   - dryRun: artist tier skipped; artists_planned still populated.
 *   - one bad row doesn't tear down the whole run (orchestrator catches inside).
 *   - concurrency is honored (no more than N in flight).
 */

import { jest } from '@jest/globals';

import type { DiscogsArtistDetails, DiscogsReleaseMetadata } from '@wxyc/lml-client';

import type { FetchOutcome } from '../../../../jobs/rotation-artist-backfill/lml-fetch';
import { runBackfill } from '../../../../jobs/rotation-artist-backfill/orchestrate';

const makeRelease = (artistIds: number[], releaseId: number = 1): DiscogsReleaseMetadata =>
  ({
    release_id: releaseId,
    title: 'X',
    artist: 'A',
    artist_id: artistIds[0] ?? null,
    artists: artistIds.map((id) => ({ artist_id: id, name: `Artist ${id}`, join: '' })),
    extra_artists: [],
    labels: [],
    genres: [],
    styles: [],
    tracklist: [],
    videos: [],
  }) as DiscogsReleaseMetadata;

const makeArtist = (id: number): DiscogsArtistDetails =>
  ({ artist_id: id, name: `Artist ${id}`, profile: 'biography' }) as DiscogsArtistDetails;

const ok = <T>(value: T): FetchOutcome<T> => ({ kind: 'ok', value });
const notFound = <T>(): FetchOutcome<T> => ({ kind: 'not_found' });
const errored = <T>(): FetchOutcome<T> => ({ kind: 'error', error: new Error('boom'), retryable: true });

describe('runBackfill', () => {
  it('iterates the two tiers and tallies happy-path counters', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([10, 20]);
    const fetchReleaseFn = jest.fn((id: number) =>
      Promise.resolve(ok(makeRelease(id === 10 ? [100, 200] : [200, 300], id)))
    );
    const fetchArtistFn = jest.fn((id: number) => Promise.resolve(ok(makeArtist(id))));

    const result = await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 1,
    });

    expect(result.totals.releases_scanned).toBe(2);
    expect(result.totals.releases_ok).toBe(2);
    expect(result.totals.releases_not_found).toBe(0);
    expect(result.totals.releases_error).toBe(0);

    // 100, 200, 300 — deduped across the two releases.
    expect(result.totals.artists_planned).toBe(3);
    expect(result.totals.artists_attempted).toBe(3);
    expect(result.totals.artists_ok).toBe(3);

    expect(fetchArtistFn).toHaveBeenCalledTimes(3);
    const calledIds = fetchArtistFn.mock.calls.map((c) => c[0]).sort();
    expect(calledIds).toEqual([100, 200, 300]);
  });

  it('counts release 404s and skips artist fan-out for that release', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([1, 2]);
    const fetchReleaseFn = jest.fn((id: number) =>
      Promise.resolve(id === 1 ? ok(makeRelease([100], 1)) : notFound<DiscogsReleaseMetadata>())
    );
    const fetchArtistFn = jest.fn((id: number) => Promise.resolve(ok(makeArtist(id))));

    const result = await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 1,
    });

    expect(result.totals.releases_ok).toBe(1);
    expect(result.totals.releases_not_found).toBe(1);
    expect(result.totals.artists_planned).toBe(1);
    expect(result.totals.artists_ok).toBe(1);
    expect(fetchArtistFn).toHaveBeenCalledWith(100);
  });

  it('counts release errors and skips artist fan-out for that release', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([1]);
    const fetchReleaseFn = jest.fn(() => Promise.resolve(errored<DiscogsReleaseMetadata>()));
    const fetchArtistFn = jest.fn();

    const result = await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 1,
    });

    expect(result.totals.releases_error).toBe(1);
    expect(result.totals.artists_attempted).toBe(0);
    expect(fetchArtistFn).not.toHaveBeenCalled();
  });

  it('counts artist 404s separately from artist errors', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([1]);
    const fetchReleaseFn = jest.fn(() => Promise.resolve(ok(makeRelease([100, 200, 300], 1))));
    const fetchArtistFn = jest.fn((id: number) => {
      if (id === 100) return Promise.resolve(ok(makeArtist(100)));
      if (id === 200) return Promise.resolve(notFound<DiscogsArtistDetails>());
      return Promise.resolve(errored<DiscogsArtistDetails>());
    });

    const result = await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 1,
    });

    expect(result.totals.artists_ok).toBe(1);
    expect(result.totals.artists_not_found).toBe(1);
    expect(result.totals.artists_error).toBe(1);
  });

  it('dryRun=true skips the artist tier but still reports planned cardinality', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([1, 2]);
    const fetchReleaseFn = jest.fn((id: number) => Promise.resolve(ok(makeRelease(id === 1 ? [100] : [200, 300], id))));
    const fetchArtistFn = jest.fn();

    const result = await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 1,
      dryRun: true,
    });

    expect(result.totals.artists_planned).toBe(3);
    expect(result.totals.artists_attempted).toBe(0);
    expect(fetchArtistFn).not.toHaveBeenCalled();
  });

  it('dedupes artist ids that surface on multiple releases', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([1, 2, 3]);
    const fetchReleaseFn = jest.fn((id: number) => Promise.resolve(ok(makeRelease([42], id))));
    const fetchArtistFn = jest.fn((id: number) => Promise.resolve(ok(makeArtist(id))));

    const result = await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 1,
    });

    // Same artist credited on all three releases — one artist call total.
    expect(result.totals.artists_planned).toBe(1);
    expect(fetchArtistFn).toHaveBeenCalledTimes(1);
  });

  it('honors the concurrency cap on the artist tier', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([1]);
    const fetchReleaseFn = jest.fn(() => Promise.resolve(ok(makeRelease([1, 2, 3, 4, 5, 6, 7, 8], 1))));

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchArtistFn = jest.fn(async (id: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ok(makeArtist(id));
    });

    await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 3,
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it('zero release ids → zero artist calls, no throw', async () => {
    const loadReleaseIds = jest.fn().mockResolvedValue([]);
    const fetchReleaseFn = jest.fn();
    const fetchArtistFn = jest.fn();

    const result = await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 3,
    });

    expect(result.totals.releases_scanned).toBe(0);
    expect(result.totals.artists_planned).toBe(0);
    expect(fetchReleaseFn).not.toHaveBeenCalled();
    expect(fetchArtistFn).not.toHaveBeenCalled();
  });

  it('emits artist ids in sorted order so dry-run output is stable across runs', async () => {
    // Release-completion order under concurrency > 1 is non-deterministic;
    // the orchestrator sorts before the Phase-2 fan-out so artist log lines
    // and totals projection are byte-identical across re-runs.
    const loadReleaseIds = jest.fn().mockResolvedValue([1, 2, 3]);
    const fetchReleaseFn = jest.fn((id: number) => {
      const ids = id === 1 ? [300, 100] : id === 2 ? [50, 200] : [25, 75];
      return Promise.resolve(ok(makeRelease(ids, id)));
    });
    const calledArtists: number[] = [];
    const fetchArtistFn = jest.fn((id: number) => {
      calledArtists.push(id);
      return Promise.resolve(ok(makeArtist(id)));
    });

    await runBackfill({
      loadReleaseIds,
      fetchReleaseFn,
      fetchArtistFn,
      concurrency: 1,
    });

    expect(calledArtists).toEqual([25, 50, 75, 100, 200, 300]);
  });

  it('one bad task in the artist tier does not orphan sibling in-flight tasks (Promise.allSettled semantics)', async () => {
    // If `runWithConcurrency` used `Promise.all` directly, a worker rejection
    // would let the wrapper resolve while siblings are mid-`await`, leaking
    // promise resolutions after the caller has moved on. The new
    // semaphore-based pool waits for every task to settle so the rethrow
    // happens AFTER all permits are released.
    const loadReleaseIds = jest.fn().mockResolvedValue([1]);
    const fetchReleaseFn = jest.fn(() => Promise.resolve(ok(makeRelease([10, 20, 30], 1))));
    const completed: number[] = [];
    const fetchArtistFn = jest.fn(async (id: number) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (id === 20) throw new Error('synthetic task failure');
      completed.push(id);
      return ok(makeArtist(id));
    });

    await expect(
      runBackfill({
        loadReleaseIds,
        fetchReleaseFn,
        fetchArtistFn,
        concurrency: 3,
      })
    ).rejects.toThrow('synthetic task failure');

    // Both non-throwing siblings completed (no orphaning).
    expect(completed.sort((a, b) => a - b)).toEqual([10, 30]);
  });

  it('aggregates multiple task failures into an AggregateError so 2nd+ rejections are not silently dropped', async () => {
    // With Promise.all's first-rejection-wins semantics, a run where
    // three tasks throw at slightly different times would lose two of
    // the three failures. The aggregator surfaces all of them so the
    // shared root cause (e.g. a decoder regression hitting many calls)
    // is visible in the stack instead of hiding behind a single victim.
    const loadReleaseIds = jest.fn().mockResolvedValue([1]);
    const fetchReleaseFn = jest.fn(() => Promise.resolve(ok(makeRelease([10, 20, 30], 1))));
    const fetchArtistFn = jest.fn(async (id: number) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error(`task ${id} failed`);
    });

    let caught: unknown;
    try {
      await runBackfill({
        loadReleaseIds,
        fetchReleaseFn,
        fetchArtistFn,
        concurrency: 3,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(3);
    const messages = aggregate.errors.map((e: Error) => e.message).sort();
    expect(messages).toEqual(['task 10 failed', 'task 20 failed', 'task 30 failed']);
  });
});
