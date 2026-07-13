/**
 * Unit tests for jobs/concerts-artist-lml-resolver orchestrate.ts (BS#1614).
 *
 * The orchestrator is the unit-testable seam: gate → dedupe → serial pages
 * → verdict routing, over dep-injected {@link RoleTarget}s and a fake
 * `resolveBatch`. Every LML#759 verdict lands here, so this suite is the
 * verdict matrix:
 *
 *   - resolved → applyResolved (id + method), fan-out to all rows sharing
 *     the raw name, raced accounting when the NULL-guard drops rows;
 *   - ambiguous / not_found → applyNoMatch (marker-only responded verdicts);
 *   - escalation_unavailable → NO target call (retryable — the whole
 *     LML#759 "couldn't ask" contract), and an all-escalation page stops
 *     the run early (breaker open);
 *   - thrown resolveBatch → page counted as errors, run continues;
 *   - thrown target writes → error counter, loop continues;
 *   - unknown future verdict shapes → no write, error counter.
 *
 * Plus the structural pins: clean-name gate exclusion, verbatim-name
 * dedupe, page composition, dry-run short-circuit, TTL passthrough, and
 * the role-agnostic multi-target seam BS#1618 Phase D builds on.
 */
import { jest } from '@jest/globals';

import type { ArtistResolveBulkResponse, ArtistResolveResult } from '@wxyc/lml-client';
import {
  runResolve,
  type ResolvedVerdict,
  type RoleTarget,
  type RunDeps,
  type RunOptions,
  type TargetCandidate,
} from '../../../../jobs/concerts-artist-lml-resolver/orchestrate';

type ApplyResolvedFn = RoleTarget['applyResolved'];
type ApplyNoMatchFn = RoleTarget['applyNoMatch'];
type LoadCandidatesFn = RoleTarget['loadCandidates'];
type ResolveBatchFn = RunDeps['resolveBatch'];

/** A target whose writes always succeed and touch every row. */
const makeTarget = (role: string, candidates: TargetCandidate[]) => {
  const loadCandidates = jest.fn<LoadCandidatesFn>().mockResolvedValue(candidates);
  const applyResolved = jest
    .fn<ApplyResolvedFn>()
    .mockImplementation((rowIds: number[]) => Promise.resolve({ updated: rowIds.length, fk_loop_closed: 0 }));
  const applyNoMatch = jest
    .fn<ApplyNoMatchFn>()
    .mockImplementation((rowIds: number[]) => Promise.resolve({ updated: rowIds.length }));
  return { role, loadCandidates, applyResolved, applyNoMatch } satisfies RoleTarget;
};

const resolvedResult = (name: string, id: number): ArtistResolveResult => ({
  name,
  discogs_artist_id: id,
  canonical_name: name,
  method: 'api_search',
  cache_corroboration: [],
  candidate_count: 1,
});

const unresolvedResult = (
  name: string,
  reason: NonNullable<ArtistResolveResult['unresolved_reason']>
): ArtistResolveResult => ({
  name,
  cache_corroboration: [],
  unresolved_reason: reason,
  candidate_count: reason === 'escalation_unavailable' ? null : 0,
});

/** Fake LML: verdicts keyed by name; unknown names come back not_found. */
const makeResolveBatch = (rules: Record<string, ArtistResolveResult>) =>
  jest.fn<ResolveBatchFn>().mockImplementation((names: string[]) =>
    Promise.resolve({
      results: names.map((n) => rules[n] ?? unresolvedResult(n, 'not_found')),
    } satisfies ArtistResolveBulkResponse)
  );

const passAll = () => true;

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  pageSize: 10,
  ttlDays: 30,
  dryRun: false,
  ...overrides,
});

describe('runResolve — verdict matrix', () => {
  test('resolved: applyResolved gets the row ids and the verdict; counters land', async () => {
    const target = makeTarget('headliner', [{ id: 1, raw_name: 'Sweeping Promises' }]);
    const resolveBatch = makeResolveBatch({ 'Sweeping Promises': resolvedResult('Sweeping Promises', 777) });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

    expect(target.applyResolved).toHaveBeenCalledTimes(1);
    expect(target.applyResolved).toHaveBeenCalledWith([1], {
      discogs_artist_id: 777,
      method: 'api_search',
    } satisfies ResolvedVerdict);
    expect(target.applyNoMatch).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 1, names: 1, pages: 1, resolved: 1, rows_resolved: 1, errors: 0 });
  });

  test('resolved counters split by LML method tier (identity_store vs api_search)', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Sweeping Promises' }, // cheap cache hit
      { id: 2, raw_name: 'Wednesday' }, // live Discogs search
    ]);
    const resolveBatch = makeResolveBatch({
      'Sweeping Promises': { ...resolvedResult('Sweeping Promises', 777), method: 'identity_store' },
      Wednesday: resolvedResult('Wednesday', 88), // helper defaults method to 'api_search'
    });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

    // The split makes the run's cost story legible from the finished log —
    // identity_store is free, api_search spent LML's Discogs budget.
    expect(totals).toMatchObject({
      resolved: 2,
      resolved_via_identity_store: 1,
      resolved_via_api_search: 1,
    });
  });

  test('fk_loop_closed and raced aggregate from the target return values', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Mannequin Pussy' },
      { id: 2, raw_name: 'Mannequin Pussy' },
      { id: 3, raw_name: 'Mannequin Pussy' },
    ]);
    // 3 candidate rows fan out, but one was resolved by the SQL arm mid-run:
    // the NULL-guard drops it (updated 2 of 3) and the FK loop-close covered
    // both surviving rows.
    target.applyResolved.mockResolvedValueOnce({ updated: 2, fk_loop_closed: 2 });
    const resolveBatch = makeResolveBatch({ 'Mannequin Pussy': resolvedResult('Mannequin Pussy', 42) });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

    expect(target.applyResolved).toHaveBeenCalledWith([1, 2, 3], expect.anything());
    expect(totals).toMatchObject({ resolved: 1, rows_resolved: 2, fk_loop_closed: 2, raced: 1 });
  });

  test.each(['ambiguous', 'not_found'] as const)(
    '%s: marker-only applyNoMatch, never applyResolved',
    async (reason) => {
      const target = makeTarget('headliner', [{ id: 5, raw_name: 'Popsicle' }]);
      const resolveBatch = makeResolveBatch({ Popsicle: unresolvedResult('Popsicle', reason) });

      const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

      expect(target.applyResolved).not.toHaveBeenCalled();
      expect(target.applyNoMatch).toHaveBeenCalledWith([5]);
      expect(totals[reason]).toBe(1);
      expect(totals.errors).toBe(0);
    }
  );

  test('escalation_unavailable: NO write of any kind — the row must stay retryable', async () => {
    const target = makeTarget('headliner', [{ id: 5, raw_name: 'King Buffalo' }]);
    const resolveBatch = makeResolveBatch({
      'King Buffalo': unresolvedResult('King Buffalo', 'escalation_unavailable'),
    });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

    // Stamping the marker here would put the row behind the 30-day TTL for a
    // transient LML outage — the exact misclassification LML#759's contract
    // forbids ("couldn't ask" is not "asked and missed").
    expect(target.applyResolved).not.toHaveBeenCalled();
    expect(target.applyNoMatch).not.toHaveBeenCalled();
    expect(totals.escalation_unavailable).toBe(1);
  });

  test('unknown future verdict shape: no write, error counter', async () => {
    const target = makeTarget('headliner', [{ id: 5, raw_name: 'Wishy' }]);
    const weird = { name: 'Wishy', cache_corroboration: [], candidate_count: null } as ArtistResolveResult;
    const resolveBatch = makeResolveBatch({ Wishy: weird });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

    expect(target.applyResolved).not.toHaveBeenCalled();
    expect(target.applyNoMatch).not.toHaveBeenCalled();
    expect(totals.errors).toBe(1);
  });
});

describe('runResolve — early stop and error isolation', () => {
  test('an all-escalation page stops the run before later pages', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Horse Jumper of Love' },
      { id: 2, raw_name: 'Ekko Astral' },
      { id: 3, raw_name: 'Truth Club' },
    ]);
    const resolveBatch = makeResolveBatch({
      'Horse Jumper of Love': unresolvedResult('Horse Jumper of Love', 'escalation_unavailable'),
      'Ekko Astral': unresolvedResult('Ekko Astral', 'escalation_unavailable'),
    });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options({ pageSize: 2 }));

    // Page 1 (2 names) was entirely escalation_unavailable → the breaker is
    // open; page 2 ('Truth Club') must never be sent.
    expect(resolveBatch).toHaveBeenCalledTimes(1);
    expect(totals.early_stopped).toBe(true);
    expect(totals.escalation_unavailable).toBe(2);
    expect(target.applyNoMatch).not.toHaveBeenCalled();
  });

  test('a mixed page (some escalation) does NOT early-stop', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Horse Jumper of Love' },
      { id: 2, raw_name: 'Ekko Astral' },
      { id: 3, raw_name: 'Truth Club' },
    ]);
    const resolveBatch = makeResolveBatch({
      'Horse Jumper of Love': unresolvedResult('Horse Jumper of Love', 'escalation_unavailable'),
      'Ekko Astral': resolvedResult('Ekko Astral', 99),
    });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options({ pageSize: 2 }));

    expect(resolveBatch).toHaveBeenCalledTimes(2);
    expect(totals.early_stopped).toBe(false);
    expect(totals).toMatchObject({ resolved: 1, escalation_unavailable: 1, not_found: 1 });
  });

  test('a thrown resolveBatch counts the page as errors and continues to the next page', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Restraining Order' },
      { id: 2, raw_name: 'Gel' },
      { id: 3, raw_name: 'Be Your Own Pet' },
    ]);
    const resolveBatch = jest
      .fn<ResolveBatchFn>()
      .mockRejectedValueOnce(new Error('LML timeout'))
      .mockImplementation((names: string[]) =>
        Promise.resolve({ results: names.map((n) => resolvedResult(n, 5)) } satisfies ArtistResolveBulkResponse)
      );

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options({ pageSize: 2 }));

    expect(resolveBatch).toHaveBeenCalledTimes(2);
    // Page 1's two names were never written (still retryable); page 2's name
    // resolved normally.
    expect(totals).toMatchObject({ errors: 2, resolved: 1, pages: 1 });
    expect(target.applyResolved).toHaveBeenCalledTimes(1);
  });

  test('a thrown target write isolates to that name (error counter, loop continues)', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Prewn' },
      { id: 2, raw_name: 'Squirrel Flower' },
    ]);
    target.applyResolved.mockRejectedValueOnce(new Error('deadlock'));
    const resolveBatch = makeResolveBatch({
      Prewn: resolvedResult('Prewn', 7),
      'Squirrel Flower': resolvedResult('Squirrel Flower', 8),
    });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

    expect(target.applyResolved).toHaveBeenCalledTimes(2);
    expect(totals).toMatchObject({ resolved: 2, rows_resolved: 1, errors: 1 });
  });
});

describe('runResolve — gate, dedupe, paging, dry-run', () => {
  test('gated names are never sent and count as gated_out', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Wednesday, Hotline TNT' }, // comma co-bill → gated
      { id: 2, raw_name: 'Wednesday' },
    ]);
    const gate = (name: string) => !name.includes(',');
    const resolveBatch = makeResolveBatch({ Wednesday: resolvedResult('Wednesday', 11) });

    const totals = await runResolve({ targets: [target], gate, resolveBatch }, options());

    expect(resolveBatch).toHaveBeenCalledWith(['Wednesday']);
    expect(totals).toMatchObject({ candidates: 2, gated_out: 1, names: 1 });
  });

  test('an entirely-gated candidate set sends nothing', async () => {
    const target = makeTarget('headliner', [{ id: 1, raw_name: 'A, B' }]);
    const resolveBatch = makeResolveBatch({});

    const totals = await runResolve({ targets: [target], gate: () => false, resolveBatch }, options());

    expect(resolveBatch).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ gated_out: 1, names: 0, pages: 0 });
  });

  test('rows sharing a verbatim raw name resolve once and fan out together', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Duster' },
      { id: 2, raw_name: 'Duster' },
    ]);
    const resolveBatch = makeResolveBatch({ Duster: resolvedResult('Duster', 12) });

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options());

    expect(resolveBatch).toHaveBeenCalledTimes(1);
    expect(resolveBatch).toHaveBeenCalledWith(['Duster']);
    expect(target.applyResolved).toHaveBeenCalledTimes(1);
    expect(target.applyResolved).toHaveBeenCalledWith([1, 2], expect.anything());
    expect(totals).toMatchObject({ candidates: 2, names: 1, resolved: 1, rows_resolved: 2 });
  });

  test('pages are composed serially at pageSize', async () => {
    const target = makeTarget(
      'headliner',
      [1, 2, 3, 4, 5].map((n) => ({ id: n, raw_name: `Band ${n}` }))
    );
    const resolveBatch = makeResolveBatch(
      Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`Band ${n}`, resolvedResult(`Band ${n}`, n)]))
    );

    const totals = await runResolve({ targets: [target], gate: passAll, resolveBatch }, options({ pageSize: 2 }));

    expect(resolveBatch.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 1]);
    expect(totals.pages).toBe(3);
  });

  test('awaitQuiet is awaited before every page (cooperative pause)', async () => {
    const target = makeTarget(
      'headliner',
      [1, 2, 3].map((n) => ({ id: n, raw_name: `Band ${n}` }))
    );
    const resolveBatch = makeResolveBatch({});
    const awaitQuiet = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await runResolve({ targets: [target], gate: passAll, resolveBatch, awaitQuiet }, options({ pageSize: 2 }));

    expect(awaitQuiet).toHaveBeenCalledTimes(2);
  });

  test('dry-run: enumerates and gates but never calls LML or writes', async () => {
    const target = makeTarget('headliner', [
      { id: 1, raw_name: 'Cindy Lee' },
      { id: 2, raw_name: 'A, B' },
    ]);
    const gate = (name: string) => !name.includes(',');
    const resolveBatch = makeResolveBatch({});

    const totals = await runResolve({ targets: [target], gate, resolveBatch }, options({ dryRun: true }));

    expect(resolveBatch).not.toHaveBeenCalled();
    expect(target.applyResolved).not.toHaveBeenCalled();
    expect(target.applyNoMatch).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 2, gated_out: 1, names: 1, pages: 0 });
  });

  test('ttlDays flows through to loadCandidates', async () => {
    const target = makeTarget('headliner', []);
    const resolveBatch = makeResolveBatch({});

    await runResolve({ targets: [target], gate: passAll, resolveBatch }, options({ ttlDays: 7 }));

    expect(target.loadCandidates).toHaveBeenCalledWith(7);
  });
});

describe('runResolve — role-agnostic multi-target seam (BS#1618 Phase D)', () => {
  test('a name billed in two roles resolves ONCE and each target gets its own rows', async () => {
    const headliner = makeTarget('headliner', [{ id: 1, raw_name: 'Ribbon Stage' }]);
    const support = makeTarget('support', [
      { id: 101, raw_name: 'Ribbon Stage' },
      { id: 102, raw_name: 'Ribbon Stage' },
    ]);
    const resolveBatch = makeResolveBatch({ 'Ribbon Stage': resolvedResult('Ribbon Stage', 55) });

    const totals = await runResolve({ targets: [headliner, support], gate: passAll, resolveBatch }, options());

    // Shared resolution: one LML call for the name, both targets written.
    expect(resolveBatch).toHaveBeenCalledTimes(1);
    expect(resolveBatch).toHaveBeenCalledWith(['Ribbon Stage']);
    expect(headliner.applyResolved).toHaveBeenCalledWith([1], expect.anything());
    expect(support.applyResolved).toHaveBeenCalledWith([101, 102], expect.anything());
    expect(totals).toMatchObject({ candidates: 3, names: 1, resolved: 1, rows_resolved: 3 });
  });
});
