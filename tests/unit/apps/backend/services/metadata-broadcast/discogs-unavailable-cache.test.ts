/**
 * Unit tests for the BS#1962 discogs-unavailable SSE-feeder cache
 * (`discogs-unavailable-cache.ts`): an LRU + in-flight-promise-coalescing
 * wrapper over `library.service.getDiscogsUnavailableFlagsById`, plus a
 * targeted `invalidateDiscogsUnavailableFlags` for the interactive
 * `PATCH /library/{id}` flip.
 *
 * Pins the "no unbounded per-broadcast query" acceptance criterion: two
 * concurrent lookups for the same album_id must collapse to one underlying
 * DB read (in-flight coalescing), and a resolved value is served from cache
 * on a subsequent call without re-hitting the DB. A rejected underlying read
 * must never be cached (so a transient DB blip is retried on the next call,
 * not pinned as a false negative for the rest of the TTL).
 */

import { jest } from '@jest/globals';

const mockGetDiscogsUnavailableFlagsById = jest.fn<() => Promise<unknown>>();

jest.mock('../../../../../../apps/backend/services/library.service', () => ({
  getDiscogsUnavailableFlagsById: mockGetDiscogsUnavailableFlagsById,
}));

import {
  getCachedDiscogsUnavailableFlags,
  invalidateDiscogsUnavailableFlags,
  __resetDiscogsUnavailableCacheForTests,
} from '../../../../../../apps/backend/services/metadata-broadcast/discogs-unavailable-cache';

const FLAGS_SET = {
  discogsUnavailable: true,
  discogsUnavailableNote: 'Embargoed promo pressing',
  lastDiscogsRecheckAt: null,
};
const FLAGS_UNSET = { discogsUnavailable: false, discogsUnavailableNote: null, lastDiscogsRecheckAt: null };

describe('getCachedDiscogsUnavailableFlags (BS#1962)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetDiscogsUnavailableCacheForTests();
  });

  it('returns the underlying result on a cache miss', async () => {
    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(FLAGS_SET);

    const result = await getCachedDiscogsUnavailableFlags(501);

    expect(result).toEqual(FLAGS_SET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledWith(501);
  });

  it('serves a warm cache hit without re-reading the DB', async () => {
    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(FLAGS_SET);

    await getCachedDiscogsUnavailableFlags(501);
    const second = await getCachedDiscogsUnavailableFlags(501);

    expect(second).toEqual(FLAGS_SET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(1);
  });

  it('negative-caches an undefined result (no library row) — one read, cached', async () => {
    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(undefined);

    const first = await getCachedDiscogsUnavailableFlags(999);
    const second = await getCachedDiscogsUnavailableFlags(999);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(1);
  });

  it('coalesces two concurrent lookups for the same album_id into one DB read', async () => {
    let resolveRead!: (value: unknown) => void;
    mockGetDiscogsUnavailableFlagsById.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );

    const p1 = getCachedDiscogsUnavailableFlags(501);
    const p2 = getCachedDiscogsUnavailableFlags(501);

    // Both calls in flight; only one underlying read should have started.
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(1);

    resolveRead(FLAGS_UNSET);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(FLAGS_UNSET);
    expect(r2).toEqual(FLAGS_UNSET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected underlying read — a later call retries', async () => {
    mockGetDiscogsUnavailableFlagsById.mockRejectedValueOnce(new Error('db blip'));

    await expect(getCachedDiscogsUnavailableFlags(501)).rejects.toThrow('db blip');

    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(FLAGS_SET);
    const result = await getCachedDiscogsUnavailableFlags(501);

    expect(result).toEqual(FLAGS_SET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(2);
  });

  it('keeps independent album_ids on independent cache entries', async () => {
    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(FLAGS_SET).mockResolvedValueOnce(FLAGS_UNSET);

    const a = await getCachedDiscogsUnavailableFlags(501);
    const b = await getCachedDiscogsUnavailableFlags(502);

    expect(a).toEqual(FLAGS_SET);
    expect(b).toEqual(FLAGS_UNSET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(2);
  });
});

describe('invalidateDiscogsUnavailableFlags (BS#1962)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetDiscogsUnavailableCacheForTests();
  });

  it('forces a fresh read on the next call after invalidation (interactive-flip flip-lag closure)', async () => {
    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(FLAGS_UNSET);
    const before = await getCachedDiscogsUnavailableFlags(501);
    expect(before).toEqual(FLAGS_UNSET);

    invalidateDiscogsUnavailableFlags(501);

    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(FLAGS_SET);
    const after = await getCachedDiscogsUnavailableFlags(501);

    expect(after).toEqual(FLAGS_SET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(2);
  });

  it('is a safe no-op on an album_id that was never cached', () => {
    expect(() => invalidateDiscogsUnavailableFlags(123456)).not.toThrow();
  });

  it('does not re-pin a stale value when invalidated mid-flight (F1 TOCTOU)', async () => {
    // A cold read is in flight, observing the pre-flip UNSET snapshot.
    let resolveRead!: (value: unknown) => void;
    mockGetDiscogsUnavailableFlagsById.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const p1 = getCachedDiscogsUnavailableFlags(501);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(1);

    // An MD's PATCH /library flips the flag and invalidates *before* the
    // in-flight read resolves.
    invalidateDiscogsUnavailableFlags(501);

    // The in-flight read now settles with the stale (pre-flip) value.
    resolveRead(FLAGS_UNSET);
    await p1;

    // That stale value must NOT have been pinned into the cache: the next
    // call re-queries and observes the fresh flagged value, rather than
    // serving the stale `false` for the rest of the TTL window.
    mockGetDiscogsUnavailableFlagsById.mockResolvedValueOnce(FLAGS_SET);
    const after = await getCachedDiscogsUnavailableFlags(501);

    expect(after).toEqual(FLAGS_SET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(2);
  });

  it('an invalidation of one album_id does not suppress caching of an unrelated in-flight read', async () => {
    // Poisoning is per-album_id (not a shared counter): invalidating album 501
    // must not stop album 502's concurrently-in-flight read from caching its
    // fresh result — otherwise every interactive flip would bust caching for
    // whatever unrelated reads happened to be in flight, defeating the LRU
    // during exactly the backfill burst it exists to protect.
    let resolveB!: (value: unknown) => void;
    mockGetDiscogsUnavailableFlagsById.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveB = resolve;
        })
    );
    const pB = getCachedDiscogsUnavailableFlags(502); // album 502 read in flight

    // An interactive flip invalidates a DIFFERENT album.
    invalidateDiscogsUnavailableFlags(501);

    // 502 resolves fresh — it must still be cached despite the 501 invalidation.
    resolveB(FLAGS_SET);
    await pB;

    const second = await getCachedDiscogsUnavailableFlags(502);
    expect(second).toEqual(FLAGS_SET);
    // Cached → no second read for 502.
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(1);
  });

  it('a settling read does not evict a newer in-flight read for the same album_id', async () => {
    // Regression for the in-flight-map clobber: after an invalidate drops R1's
    // slot and R2 registers a fresh read under the same id, R1's `.finally`
    // must NOT delete R2's slot — otherwise a later caller misses the in-flight
    // entry and issues a THIRD redundant DB read, defeating coalescing.
    let resolveR1!: (value: unknown) => void;
    let resolveR2!: (value: unknown) => void;
    mockGetDiscogsUnavailableFlagsById
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveR1 = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveR2 = resolve;
          })
      );

    const p1 = getCachedDiscogsUnavailableFlags(501); // R1 in flight
    invalidateDiscogsUnavailableFlags(501); // drop + poison R1
    const p2 = getCachedDiscogsUnavailableFlags(501); // R2 starts (2nd read)
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(2);

    // R1 settles; its `.finally` must leave R2's slot in place (identity guard).
    resolveR1(FLAGS_UNSET);
    await p1;

    // A third caller must coalesce onto R2, NOT start a third read.
    const p3 = getCachedDiscogsUnavailableFlags(501);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(2);

    resolveR2(FLAGS_SET);
    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2).toEqual(FLAGS_SET);
    expect(r3).toEqual(FLAGS_SET);
    expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledTimes(2);
  });
});
