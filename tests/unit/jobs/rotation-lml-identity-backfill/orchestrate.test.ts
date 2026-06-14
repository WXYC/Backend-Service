/**
 * Unit tests for jobs/rotation-lml-identity-backfill orchestrate.ts (BS#1380).
 *
 * Mirrors the rotation-release-id-backfill counter-shape pins:
 *
 *   1. (tracer bullet) one resolvable row → write called with the resolved
 *      identity_id; `resolved` counter bumps, scanned == 1.
 *   2. LML returns null (422 sentinel rejection) → unresolved counter;
 *      no write.
 *   3. LML throws (timeout/5xx/network) → lml_error counter; no write;
 *      row stays NULL for next pass.
 *   4. Writer returns written:false → raced counter, not resolved.
 *   5. dryRun=true → resolved_dry counter; no write.
 *   6. Cooperative pause defers the resolve when the live-activity probe
 *      returns true, then proceeds when it returns false.
 *   7. Writer is called with `(rotationId, discogsReleaseId, identityId)` —
 *      the writer's WHERE clause pins on the discogs_release_id read at
 *      candidate-select time so a mid-run paste-correction races cleanly.
 */
import { jest } from '@jest/globals';

import {
  runBackfill,
  type LoadCandidatesFn,
  type LookupFn,
  type WriteFn,
} from '../../../../jobs/rotation-lml-identity-backfill/orchestrate';
import type { Candidate } from '../../../../jobs/rotation-lml-identity-backfill/query';

const makeLoadCandidates = (rows: Candidate[]): LoadCandidatesFn => jest.fn<LoadCandidatesFn>().mockResolvedValue(rows);

const COMMON_OPTS = {
  liveActivityLookbackSeconds: 0, // disable live-activity probe by default
  liveActivityPauseMs: 0,
};

describe('runBackfill', () => {
  test('one resolvable row produces one resolved UPDATE pinned on (rotationId, discogsReleaseId, identityId)', async () => {
    const loadCandidates = makeLoadCandidates([{ id: 42, discogs_release_id: 999001 }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(7700042);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write, ...COMMON_OPTS });

    expect(write).toHaveBeenCalledTimes(1);
    // BS#1380: writer pins on the discogs_release_id read at candidate-
    // select time so a mid-run paste-correction (rotation-etl CASE clears
    // lml_identity_id back to NULL after discogs_release_id changes) can't
    // be clobbered with an identity minted against the old id.
    expect(write).toHaveBeenCalledWith(42, 999001, 7700042);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.resolved).toBe(1);
    expect(result.totals.unresolved).toBe(0);
    expect(result.totals.lml_error).toBe(0);
    expect(result.totals.raced).toBe(0);
  });

  test('LML returns null (422 sentinel rejection) → unresolved counter, no write', async () => {
    // lml-fetch.ts maps LML's 422 sentinel rejection to `null` so the
    // orchestrator sees "ran cleanly, no row to point at" as `unresolved`,
    // not `lml_error`.
    const loadCandidates = makeLoadCandidates([{ id: 99, discogs_release_id: -1 /* sentinel */ }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(null);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write, ...COMMON_OPTS });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.unresolved).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('LML throws → lml_error counter; no write; row stays NULL for next pass', async () => {
    const loadCandidates = makeLoadCandidates([{ id: 7, discogs_release_id: 12345 }]);
    const lookup = jest.fn<LookupFn>().mockRejectedValue(new Error('LML socket timeout'));
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write, ...COMMON_OPTS });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.lml_error).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('write returns written:false → raced counter, not resolved', async () => {
    // Either another concurrent backfill won the race, or rotation-etl
    // cleared the row mid-run after a paste-correction. The orchestrator
    // surfaces both as `raced` so the dashboard distinguishes write
    // success from "lost the race".
    const loadCandidates = makeLoadCandidates([{ id: 11, discogs_release_id: 555 }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(8800011);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: false });

    const result = await runBackfill({ loadCandidates, lookup, write, ...COMMON_OPTS });

    expect(write).toHaveBeenCalledTimes(1);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.raced).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('dryRun=true skips writes and bumps resolved_dry', async () => {
    const loadCandidates = makeLoadCandidates([{ id: 42, discogs_release_id: 999001 }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(7700042);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write, dryRun: true, ...COMMON_OPTS });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.resolved_dry).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('cooperative pause defers per-row resolve while live activity is observed', async () => {
    const loadCandidates = makeLoadCandidates([{ id: 42, discogs_release_id: 999001 }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(7700042);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    // First probe says "busy", second probe says "quiet". The orchestrator
    // must call `onLivePause` exactly once and then proceed with the row.
    let probeCalls = 0;
    const checkLiveActivity = jest.fn<(s: number) => Promise<boolean>>().mockImplementation(() => {
      probeCalls += 1;
      return Promise.resolve(probeCalls === 1);
    });
    const onLivePause = jest.fn<() => void>();

    const result = await runBackfill({
      loadCandidates,
      lookup,
      write,
      liveActivityLookbackSeconds: 30,
      liveActivityPauseMs: 0, // skip the actual sleep so the test runs fast
      checkLiveActivity,
      onLivePause,
    });

    expect(checkLiveActivity).toHaveBeenCalledTimes(2);
    expect(onLivePause).toHaveBeenCalledTimes(1);
    expect(result.totals.resolved).toBe(1);
  });
});
