/**
 * Unit tests for jobs/concerts-artist-resolver support.ts (BS#1760).
 *
 * `runSupportResolver` is the BESPOKE support-arm loop — a fresh
 * implementation (not `runResolver` from orchestrate.ts, per the BS#1760
 * issue's explicit constraint) that reuses only the pure `resolveArtistId`
 * fn's TYPE contract (`ResolveFn`/`ResolveOutcome` from orchestrate.ts).
 * Its shape intentionally parallels `runResolver`'s tests
 * (orchestrate.test.ts) so the two loops' behavior stays comparable, minus
 * the headliner-only `null_raw_skipped` branch — `concert_performers.
 * raw_name` is `NOT NULL`, so there is no analogous skip case here.
 *
 * Acceptance cases per BS#1760:
 *   - strict / alias match: writes `artist_id`, no marker.
 *   - ambiguous / unmatched: `artist_id` stays NULL, no marker, no write
 *     call at all (mirrors the headliner loop's write-only-on-match rule).
 *   - resolver / writer throws: error counter, loop continues.
 *   - onError sink is bulletproof (sync throw / async rejection).
 *   - writer reports written:false → raced counter (fill-NULLs-only guard
 *     lost a race to another run).
 *   - idempotent re-run: empty candidate set is a no-op.
 */
import { jest } from '@jest/globals';

import {
  runSupportResolver,
  type SupportCandidate,
  type LoadSupportCandidatesFn,
  type WriteSupportFn,
} from '../../../../jobs/concerts-artist-resolver/support';
import type { ResolveFn, ResolveOutcome } from '../../../../jobs/concerts-artist-resolver/orchestrate';

const makeLoad = (rows: SupportCandidate[]): LoadSupportCandidatesFn =>
  jest.fn<LoadSupportCandidatesFn>().mockResolvedValue(rows);

const makeResolver = (rules: Record<string, ResolveOutcome>): ResolveFn => {
  const lookup = new Map(Object.entries(rules));
  return jest
    .fn<ResolveFn>()
    .mockImplementation((raw: string) => Promise.resolve(lookup.get(raw) ?? { kind: 'unmatched' }));
};

describe('runSupportResolver', () => {
  test('strict match: writes artist_id, no marker involved', async () => {
    const loadCandidates = makeLoad([{ id: 1, raw_name: 'Squirrel Flower' }]);
    const resolve = makeResolver({ 'Squirrel Flower': { kind: 'strict', artist_id: 501 } });
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(resolve).toHaveBeenCalledWith('Squirrel Flower');
    expect(write).toHaveBeenCalledWith(1, 501);
    expect(result.totals).toMatchObject({
      scanned: 1,
      resolved: 1,
      resolved_strict: 1,
      resolved_alias: 0,
      ambiguous: 0,
      unmatched: 0,
      error: 0,
      raced: 0,
    });
  });

  test('alias match: zero strict + single alias hit writes artist_id', async () => {
    const loadCandidates = makeLoad([{ id: 2, raw_name: 'Sluice' }]);
    const resolve = makeResolver({ Sluice: { kind: 'alias', artist_id: 502 } });
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledWith(2, 502);
    expect(result.totals).toMatchObject({ resolved: 1, resolved_strict: 0, resolved_alias: 1 });
  });

  test('ambiguous: artist_id stays NULL, no write call, no marker', async () => {
    const loadCandidates = makeLoad([{ id: 3, raw_name: 'Common Name' }]);
    const resolve = makeResolver({ 'Common Name': { kind: 'ambiguous' } });
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.ambiguous).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('unmatched: artist_id stays NULL, no write call', async () => {
    const loadCandidates = makeLoad([{ id: 4, raw_name: 'Some Unsigned Opener' }]);
    const resolve = makeResolver({});
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.unmatched).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('idempotent re-run: empty candidate set produces empty totals and no calls', async () => {
    const loadCandidates = jest.fn<LoadSupportCandidatesFn>().mockResolvedValue([]);
    const resolve = jest.fn<ResolveFn>();
    const write = jest.fn<WriteSupportFn>();

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(result.totals).toMatchObject({
      scanned: 0,
      resolved: 0,
      resolved_strict: 0,
      resolved_alias: 0,
      ambiguous: 0,
      unmatched: 0,
      error: 0,
      raced: 0,
    });
  });

  test('resolver throws → error counter; loop continues to the next candidate', async () => {
    const loadCandidates = makeLoad([
      { id: 10, raw_name: 'Resolver Throws' },
      { id: 11, raw_name: 'Sluice' },
    ]);
    const resolve = jest
      .fn<ResolveFn>()
      .mockRejectedValueOnce(new Error('PG statement timeout'))
      .mockResolvedValueOnce({ kind: 'strict', artist_id: 511 });
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(11, 511);
    expect(result.totals.error).toBe(1);
    expect(result.totals.resolved).toBe(1);
  });

  test('resolver throws → onError invoked with the failing candidate and the underlying error', async () => {
    const boom = new Error('PG statement timeout');
    const candidate: SupportCandidate = { id: 50, raw_name: 'Resolver Throws' };
    const loadCandidates = makeLoad([candidate]);
    const resolve = jest.fn<ResolveFn>().mockRejectedValue(boom);
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });
    const onError = jest.fn();

    const result = await runSupportResolver({ loadCandidates, resolve, write, onError });

    expect(onError).toHaveBeenCalledWith(candidate, boom);
    expect(result.totals.error).toBe(1);
  });

  test('writer throws → error counter; loop continues (symmetric with resolver)', async () => {
    const loadCandidates = makeLoad([
      { id: 60, raw_name: 'Writer Throws' },
      { id: 61, raw_name: 'Sluice' },
    ]);
    const resolve = makeResolver({
      'Writer Throws': { kind: 'strict', artist_id: 560 },
      Sluice: { kind: 'strict', artist_id: 561 },
    });
    const write = jest
      .fn<WriteSupportFn>()
      .mockRejectedValueOnce(new Error('PG: relation "concert_performers" did not exist'))
      .mockResolvedValueOnce({ written: true });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(2);
    expect(result.totals.error).toBe(1);
    expect(result.totals.resolved).toBe(1);
  });

  test('writer reports written:false → raced counter (fill-NULLs-only guard lost a race)', async () => {
    const loadCandidates = makeLoad([{ id: 12, raw_name: 'Sluice' }]);
    const resolve = makeResolver({ Sluice: { kind: 'strict', artist_id: 512 } });
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: false });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(result.totals.raced).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('synchronous onError throw does not abort the loop', async () => {
    const loadCandidates = makeLoad([
      { id: 80, raw_name: 'Resolver Throws' },
      { id: 81, raw_name: 'Sluice' },
    ]);
    const resolve = jest
      .fn<ResolveFn>()
      .mockRejectedValueOnce(new Error('PG statement timeout'))
      .mockResolvedValueOnce({ kind: 'strict', artist_id: 581 });
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });
    const onError = jest.fn(() => {
      throw new Error('EPIPE: stdout closed');
    });

    const result = await runSupportResolver({ loadCandidates, resolve, write, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.totals.error).toBe(1);
    expect(result.totals.resolved).toBe(1);
  });

  test('async onError rejection does not abort the loop or surface as unhandledRejection', async () => {
    const loadCandidates = makeLoad([
      { id: 90, raw_name: 'Writer Throws' },
      { id: 91, raw_name: 'Sluice' },
    ]);
    const resolve = makeResolver({
      'Writer Throws': { kind: 'strict', artist_id: 590 },
      Sluice: { kind: 'strict', artist_id: 591 },
    });
    const write = jest
      .fn<WriteSupportFn>()
      .mockRejectedValueOnce(new Error('PG: write failed'))
      .mockResolvedValueOnce({ written: true });
    const onError = jest.fn(() => Promise.reject(new Error('slack: 429 rate limited')));

    const result = await runSupportResolver({ loadCandidates, resolve, write, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.totals.error).toBe(1);
    expect(result.totals.resolved).toBe(1);
  });

  test('processes a mixed batch of every outcome without leaking state across candidates', async () => {
    const loadCandidates = makeLoad([
      { id: 20, raw_name: 'Sluice' },
      { id: 21, raw_name: 'Squirrel Flower' },
      { id: 22, raw_name: 'Common Name' },
      { id: 23, raw_name: 'Some Unsigned Opener' },
    ]);
    const resolve = makeResolver({
      Sluice: { kind: 'strict', artist_id: 100 },
      'Squirrel Flower': { kind: 'alias', artist_id: 101 },
      'Common Name': { kind: 'ambiguous' },
    });
    const write = jest.fn<WriteSupportFn>().mockResolvedValue({ written: true });

    const result = await runSupportResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(2);
    expect(result.totals).toMatchObject({
      scanned: 4,
      resolved: 2,
      resolved_strict: 1,
      resolved_alias: 1,
      ambiguous: 1,
      unmatched: 1,
      error: 0,
      raced: 0,
    });
  });
});
