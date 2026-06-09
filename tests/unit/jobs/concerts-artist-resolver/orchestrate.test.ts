/**
 * Unit tests for jobs/concerts-artist-resolver orchestrate.ts (BS#1372).
 *
 * The orchestrator is the unit-testable seam: a pure-function loop over
 * `loadCandidates() → resolve(raw) → write(id, artistId)`. Production
 * wires the resolver to a Drizzle-typed SELECT that joins `artists` and
 * `artist_search_alias` after normalization; tests drive the same shape
 * through an in-memory resolver so every acceptance case from the issue
 * is exercised without a live database.
 *
 * Acceptance cases per BS#1372:
 *   - strict match (single artist, name matches after normalization)
 *   - strict match with "The " prefix stripped on one side only
 *   - alias match (zero strict, single alias hit)
 *   - strict-wins (strict singleton + alias singleton for a different artist → strict wins)
 *   - ambiguous strict (>1 artist with same normalized name → NULL, counter)
 *   - ambiguous alias (>1 distinct artist_id from alias dedup → NULL, counter)
 *   - no match (FK stays NULL, unmatched counter)
 *   - NULL `headlining_artist_raw` (row skipped, null_raw_skipped counter)
 *   - idempotent re-run (second pass over already-resolved rows is a no-op)
 */
import { jest } from '@jest/globals';

import {
  runResolver,
  type Candidate,
  type LoadCandidatesFn,
  type ResolveFn,
  type ResolveOutcome,
  type WriteFn,
} from '../../../../jobs/concerts-artist-resolver/orchestrate';

const makeLoad = (rows: Candidate[]): LoadCandidatesFn => jest.fn<LoadCandidatesFn>().mockResolvedValue(rows);

const makeResolver = (rules: Record<string, ResolveOutcome>): ResolveFn => {
  const lookup = new Map(Object.entries(rules));
  return jest
    .fn<ResolveFn>()
    .mockImplementation((raw: string) => Promise.resolve(lookup.get(raw) ?? { kind: 'unmatched' }));
};

describe('runResolver', () => {
  test('strict match: single artist resolves and writes the FK', async () => {
    const loadCandidates = makeLoad([{ id: 1, headlining_artist_raw: 'Pavement' }]);
    const resolve = makeResolver({
      Pavement: { kind: 'strict', artist_id: 9001 },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(resolve).toHaveBeenCalledWith('Pavement');
    expect(write).toHaveBeenCalledWith(1, 9001);
    expect(result.totals).toMatchObject({
      scanned: 1,
      resolved: 1,
      resolved_strict: 1,
      resolved_alias: 0,
      ambiguous: 0,
      unmatched: 0,
      null_raw_skipped: 0,
      error: 0,
    });
  });

  test('strict match works even when only one side strips a leading "The "', async () => {
    // The orchestrator is shape-only: it delegates the actual matching
    // to the resolver. This test pins that a leading "The " on the raw
    // value alone is the resolver's contract (the SQL JOIN normalizes
    // both sides via normalize_artist_name) and the orchestrator does
    // nothing case-special with it.
    const loadCandidates = makeLoad([{ id: 2, headlining_artist_raw: 'The Beatles' }]);
    const resolve = makeResolver({
      'The Beatles': { kind: 'strict', artist_id: 9002 },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledWith(2, 9002);
    expect(result.totals.resolved_strict).toBe(1);
  });

  test('alias match: zero strict matches + single alias hit writes the FK', async () => {
    const loadCandidates = makeLoad([{ id: 3, headlining_artist_raw: 'Beck Hansen' }]);
    const resolve = makeResolver({
      'Beck Hansen': { kind: 'alias', artist_id: 9003 },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledWith(3, 9003);
    expect(result.totals).toMatchObject({
      resolved: 1,
      resolved_strict: 0,
      resolved_alias: 1,
    });
  });

  test('strict-wins: strict singleton + alias singleton for a different artist → strict wins', async () => {
    // The strict-wins rule is enforced at the SELECT level — the
    // resolver returns the strict outcome and never falls through. The
    // orchestrator simply trusts the resolver's `kind`. This test makes
    // it explicit that a strict outcome is what's written when both
    // could have produced a match.
    const loadCandidates = makeLoad([{ id: 4, headlining_artist_raw: 'Pavement' }]);
    const resolve = makeResolver({
      Pavement: { kind: 'strict', artist_id: 9004 },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledWith(4, 9004);
    expect(result.totals.resolved_strict).toBe(1);
    expect(result.totals.resolved_alias).toBe(0);
  });

  test('ambiguous strict: >1 canonical artist with the same normalized name → FK stays NULL', async () => {
    const loadCandidates = makeLoad([{ id: 5, headlining_artist_raw: 'Nirvana' }]);
    const resolve = makeResolver({
      Nirvana: { kind: 'ambiguous' },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.ambiguous).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('ambiguous alias: >1 distinct artist_id after alias dedup → FK stays NULL', async () => {
    // The dedup-on-artist_id rule (multiple variants for the same
    // canonical artist count as one) lives in the SELECT. The
    // orchestrator only sees the post-dedup outcome — `ambiguous` —
    // and bumps the same counter as the strict-ambiguous case.
    const loadCandidates = makeLoad([{ id: 6, headlining_artist_raw: 'Generic Band Name' }]);
    const resolve = makeResolver({
      'Generic Band Name': { kind: 'ambiguous' },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.ambiguous).toBe(1);
  });

  test('no match: zero strict, zero alias → FK stays NULL, unmatched counter increments', async () => {
    const loadCandidates = makeLoad([{ id: 7, headlining_artist_raw: 'A Brand New Band' }]);
    const resolve = makeResolver({});
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.unmatched).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('NULL headlining_artist_raw: row skipped, null_raw_skipped counter increments', async () => {
    // The SELECT predicate filters `headlining_artist_raw IS NOT NULL`,
    // so production should never hand a NULL raw to the orchestrator —
    // but the candidate type permits it and the orchestrator handles
    // it defensively rather than tripping the resolver on bad input.
    const loadCandidates = makeLoad([{ id: 8, headlining_artist_raw: null }]);
    const resolve = makeResolver({});
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(result.totals.null_raw_skipped).toBe(1);
    expect(result.totals.scanned).toBe(1);
  });

  test('idempotent re-run: second pass produces no work when no rows remain unresolved', async () => {
    // The SELECT predicate `headlining_artist_id IS NULL` is the
    // idempotency gate — a rerun after a full first pass sees no
    // candidates and the orchestrator returns the empty-totals shape.
    const loadCandidates = jest.fn<LoadCandidatesFn>().mockResolvedValue([]);
    const resolve = jest.fn<ResolveFn>();
    const write = jest.fn<WriteFn>();

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(result.totals).toMatchObject({
      scanned: 0,
      resolved: 0,
      resolved_strict: 0,
      resolved_alias: 0,
      ambiguous: 0,
      unmatched: 0,
      null_raw_skipped: 0,
      error: 0,
    });
  });

  test('resolver throws → error counter; FK stays NULL; loop continues for the next candidate', async () => {
    const loadCandidates = makeLoad([
      { id: 10, headlining_artist_raw: 'Resolver Throws' },
      { id: 11, headlining_artist_raw: 'Pavement' },
    ]);
    const resolve = jest
      .fn<ResolveFn>()
      .mockRejectedValueOnce(new Error('PG statement timeout'))
      .mockResolvedValueOnce({ kind: 'strict', artist_id: 9011 });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(11, 9011);
    expect(result.totals.error).toBe(1);
    expect(result.totals.resolved).toBe(1);
  });

  test('resolver throws → onError invoked with the failing candidate and the underlying error', async () => {
    const boom = new Error('PG statement timeout');
    const loadCandidates = makeLoad([{ id: 50, headlining_artist_raw: 'Resolver Throws' }]);
    const resolve = jest.fn<ResolveFn>().mockRejectedValue(boom);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const onError = jest.fn();

    const result = await runResolver({ loadCandidates, resolve, write, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ id: 50, headlining_artist_raw: 'Resolver Throws' }, boom);
    expect(result.totals.error).toBe(1);
  });

  test('writer throws → error counter; FK stays NULL; loop continues for the next candidate (symmetric with resolver)', async () => {
    // A transient writer failure (PG outage, FK race against a parallel
    // artist delete) must not abort the entire batch. The current
    // candidate stays unresolved (FK NULL) and the next cron run
    // re-drains it via the idempotent IS-NULL gate.
    const loadCandidates = makeLoad([
      { id: 60, headlining_artist_raw: 'Writer Throws' },
      { id: 61, headlining_artist_raw: 'Pavement' },
    ]);
    const resolve = makeResolver({
      'Writer Throws': { kind: 'strict', artist_id: 9060 },
      Pavement: { kind: 'strict', artist_id: 9061 },
    });
    const write = jest
      .fn<WriteFn>()
      .mockRejectedValueOnce(new Error('PG: relation "concerts" did not exist'))
      .mockResolvedValueOnce({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(2);
    expect(result.totals.error).toBe(1);
    expect(result.totals.resolved).toBe(1);
    expect(result.totals.resolved_strict).toBe(1);
  });

  test('writer throws → onError invoked with the failing candidate and the underlying error', async () => {
    const boom = new Error('FK violation: artist 9070 not found');
    const loadCandidates = makeLoad([{ id: 70, headlining_artist_raw: 'Writer Throws' }]);
    const resolve = makeResolver({
      'Writer Throws': { kind: 'strict', artist_id: 9070 },
    });
    const write = jest.fn<WriteFn>().mockRejectedValue(boom);
    const onError = jest.fn();

    const result = await runResolver({ loadCandidates, resolve, write, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ id: 70, headlining_artist_raw: 'Writer Throws' }, boom);
    expect(result.totals.error).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('writer reports written:false → row was raced (FK already set between SELECT and UPDATE)', async () => {
    // The writer's WHERE clause guards on `headlining_artist_id IS NULL`.
    // A 0-row UPDATE means a concurrent run beat us (the recurring drain
    // is idempotent, but two ETL pods could both pick the same row up
    // mid-scan). Counted separately so the cron dashboard distinguishes
    // a real write from a no-op.
    const loadCandidates = makeLoad([{ id: 12, headlining_artist_raw: 'Pavement' }]);
    const resolve = makeResolver({
      Pavement: { kind: 'strict', artist_id: 9012 },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: false });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(result.totals.raced).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('processes a mixed batch of every outcome without leaking state across candidates', async () => {
    const loadCandidates = makeLoad([
      { id: 20, headlining_artist_raw: 'Pavement' },
      { id: 21, headlining_artist_raw: 'The Beatles' },
      { id: 22, headlining_artist_raw: 'Beck Hansen' },
      { id: 23, headlining_artist_raw: 'Nirvana' },
      { id: 24, headlining_artist_raw: 'A Brand New Band' },
      { id: 25, headlining_artist_raw: null },
    ]);
    const resolve = makeResolver({
      Pavement: { kind: 'strict', artist_id: 100 },
      'The Beatles': { kind: 'strict', artist_id: 101 },
      'Beck Hansen': { kind: 'alias', artist_id: 102 },
      Nirvana: { kind: 'ambiguous' },
    });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runResolver({ loadCandidates, resolve, write });

    expect(write).toHaveBeenCalledTimes(3);
    expect(result.totals).toMatchObject({
      scanned: 6,
      resolved: 3,
      resolved_strict: 2,
      resolved_alias: 1,
      ambiguous: 1,
      unmatched: 1,
      null_raw_skipped: 1,
      error: 0,
      raced: 0,
    });
  });
});
