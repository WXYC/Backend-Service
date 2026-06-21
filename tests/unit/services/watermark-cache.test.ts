import { describe, it, expect, jest } from '@jest/globals';
import { createWatermarkCache } from '../../../apps/backend/services/watermark-cache.service';

// BS#1468 — the bulk catalog export is built once per watermark value and the
// gzipped bytes are cached in-process (one shared copy per pod), so the hot
// path is a memcpy instead of a 5-join scan + re-gzip on every poll. The
// catalog churns ~daily, so the cache is warm for the vast majority of
// requests. `createWatermarkCache` is the table-agnostic deep module behind
// that: it pairs a watermark provider with a builder and only rebuilds when the
// watermark advances. Tested with injected fakes — no DB, no gzip.

describe('createWatermarkCache', () => {
  it('builds on the first read and returns the built payload', async () => {
    const build = jest.fn(() => Promise.resolve(Buffer.from('payload-v1')));
    const cache = createWatermarkCache(() => Promise.resolve(new Date('2026-06-20T00:00:00.000Z')), build);

    const out = await cache.get();

    expect(build).toHaveBeenCalledTimes(1);
    expect(out.toString()).toBe('payload-v1');
  });

  it('reuses the cached payload while the watermark is unchanged (no rebuild)', async () => {
    const build = jest.fn(() => Promise.resolve(Buffer.from('payload-v1')));
    const cache = createWatermarkCache(() => Promise.resolve(new Date('2026-06-20T00:00:00.000Z')), build);

    const first = await cache.get();
    const second = await cache.get();

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same buffer instance — a memcpy-able shared copy
  });

  it('rebuilds when the watermark advances and returns the fresh payload', async () => {
    let watermark = new Date('2026-06-20T00:00:00.000Z');
    let version = 0;
    const build = jest.fn(() => Promise.resolve(Buffer.from(`payload-v${++version}`)));
    const cache = createWatermarkCache(() => Promise.resolve(watermark), build);

    const first = await cache.get();
    watermark = new Date('2026-06-21T00:00:00.000Z'); // ETL wrote → watermark moved
    const second = await cache.get();

    expect(build).toHaveBeenCalledTimes(2);
    expect(first.toString()).toBe('payload-v1');
    expect(second.toString()).toBe('payload-v2');
  });

  it('single-flights concurrent reads at the same watermark (one build, no thundering herd)', async () => {
    let release: (b: Buffer) => void = () => {};
    const pending = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const build = jest.fn(() => pending);
    const cache = createWatermarkCache(() => Promise.resolve(new Date('2026-06-20T00:00:00.000Z')), build);

    // Two requests arrive while the (slow) 5-join scan + gzip is in flight.
    const a = cache.get();
    const b = cache.get();
    release(Buffer.from('payload-v1'));
    const [ra, rb] = await Promise.all([a, b]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
  });

  it('a slow build for an older watermark does not clobber a newer cached entry (lost-update guard)', async () => {
    // Two builds overlap because the watermark advanced mid-build. The OLDER
    // build resolves LAST and must not overwrite the fresher cached payload, or
    // a poller would briefly get stale bytes and the newer build's work is
    // discarded, forcing a redundant rebuild.
    const W1 = new Date('2026-06-20T00:00:00.000Z');
    const W2 = new Date('2026-06-21T00:00:00.000Z');
    let watermark = W1;
    const resolvers: Array<(b: Buffer) => void> = [];
    const build = jest.fn(() => new Promise<Buffer>((resolve) => resolvers.push(resolve)));
    const cache = createWatermarkCache(() => Promise.resolve(watermark), build);

    // get() awaits the watermark provider before calling build(), so drain the
    // microtask queue after each call to let the build() actually fire.
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    const pA = cache.get(); // reads W1, starts build[0]
    await flush();
    watermark = W2;
    const pB = cache.get(); // reads W2 (different), starts build[1]
    await flush();

    resolvers[1](Buffer.from('payload-v2')); // newer build resolves first → caches W2
    await pB;
    resolvers[0](Buffer.from('payload-v1')); // stale older build resolves last
    await pA;

    // A read at W2 must be a cache hit (no third build) returning v2. With the
    // bug, the stale W1 build clobbered the cache, so this read misses and
    // triggers a third build — resolve any such straggler so the assertion is a
    // clean failure rather than a hang.
    const pC = cache.get();
    await flush();
    while (resolvers.length > 2) resolvers.pop()?.(Buffer.from('straggler'));
    const cReadAtW2 = await pC;

    expect(build).toHaveBeenCalledTimes(2); // one per distinct watermark — not a third rebuild
    expect(cReadAtW2.toString()).toBe('payload-v2');
  });
});
