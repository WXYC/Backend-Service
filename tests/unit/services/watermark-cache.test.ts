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
});
