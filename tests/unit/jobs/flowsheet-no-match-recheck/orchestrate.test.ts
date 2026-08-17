/**
 * Unit tests for jobs/flowsheet-no-match-recheck orchestrate.ts (BS#2176).
 *
 * The recurring, cause-agnostic re-ask pass over `enriched_no_match`
 * flowsheet rows: a row that was a correct no-match at write time can become
 * resolvable later for any reason (a discogs-etl rebuild, an LML matcher
 * fix, the librarian filing the album) and nothing else revisits it, so this
 * sweep re-asks LML on a bounded, TTL-gated cadence. Structural donor:
 * jobs/rotation-release-id-backfill/orchestrate.ts.
 *
 * Behaviors covered:
 *   1. (tracer bullet) one resolvable row → write called with the candidate
 *      + trusted artwork; `resolved` counter bumps, scanned == 1.
 *   2. LML finds no match → unresolved counter; markAttempted called, no write.
 *   3. LML throws → lml_error counter; no write, no markAttempted (row stays
 *      immediately retryable — the marker is never touched on a transient
 *      failure).
 *   4. Writer returns written:false → raced counter, not resolved (a
 *      concurrent writer flipped metadata_status between SELECT and UPDATE).
 *   5. dryRun=true → resolved_dry counter; no write, no markAttempted.
 *   6. Track-context trust gate (BS#1359/#1959): a non-trusted LML answer →
 *      trust_rejected counter; no write; the row stays enriched_no_match
 *      rather than persisting a same-artist substitution.
 *   7. BS#1294-style discogs_unavailable forwarding to the lookup call.
 *   8. Cooperative live-DJ pause + db_error isolation, mirroring the donor.
 *   9. Candidate count / projected LML call volume is logged as soon as the
 *      candidates are loaded — before any lookup or write — satisfying the
 *      BS#2176 dry-run acceptance criterion for both dry-run and live runs.
 */
import { jest } from '@jest/globals';

const mockLog = jest.fn();
jest.mock('../../../../jobs/flowsheet-no-match-recheck/logger.js', () => ({
  log: mockLog,
  captureError: jest.fn(),
}));

import { type CheckLiveActivityFn } from '@wxyc/database';
import type { DiscogsMatchResult } from '@wxyc/lml-client';

import {
  runNoMatchRecheck,
  type Candidate,
  type LoadCandidatesFn,
  type LookupFn,
  type MarkAttemptedFn,
  type WriteFn,
} from '../../../../jobs/flowsheet-no-match-recheck/orchestrate';

const artwork = (releaseId: number): DiscogsMatchResult =>
  ({
    release_id: releaseId,
    release_url: `https://www.discogs.com/release/${releaseId}`,
    artwork_url: 'https://example.com/art.jpg',
    confidence: 1,
  }) as DiscogsMatchResult;

const makeLoadCandidates = (rows: Candidate[]): LoadCandidatesFn => jest.fn<LoadCandidatesFn>().mockResolvedValue(rows);
const makeMarkAttempted = (): jest.MockedFunction<MarkAttemptedFn> =>
  jest.fn<MarkAttemptedFn>().mockResolvedValue({ written: true });

describe('runNoMatchRecheck', () => {
  beforeEach(() => {
    mockLog.mockClear();
  });

  test('BS#2176: logs the candidate count / projected LML call volume as soon as candidates load, before any lookup or write', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 1, artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja', album_id: null },
      {
        id: 2,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
        album_id: null,
      },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'no_match' });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();

    await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted, dryRun: true });

    const candidatesLoadedCall = mockLog.mock.calls.find((call) => call[1] === 'candidates_loaded');
    expect(candidatesLoadedCall).toBeDefined();
    expect(candidatesLoadedCall?.[3]).toMatchObject({ candidates: 2, projected_lml_calls: 2, dry_run: true });
    // Reported as the very first log line — before the loop touches lookup
    // or write for any row.
    expect(mockLog.mock.calls.indexOf(candidatesLoadedCall)).toBe(0);
  });

  test('one resolvable row produces one resolved write and bumps the counter', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 5308981, artist_name: 'Vladislav Delay', album_title: 'Entain', track_title: 'Kohde', album_id: null },
    ]);
    const match = artwork(28327348);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', artwork: match });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      { id: 5308981, artist_name: 'Vladislav Delay', album_title: 'Entain', track_title: 'Kohde', album_id: null },
      match
    );
    expect(markAttempted).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.resolved).toBe(1);
    expect(result.totals.unresolved).toBe(0);
    expect(result.totals.lml_error).toBe(0);
    expect(result.totals.raced).toBe(0);
  });

  test('forwards candidate.discogs_unavailable to the lookup call', async () => {
    const loadCandidates = makeLoadCandidates([
      {
        id: 42,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
        album_id: 7,
        discogs_unavailable: true,
      },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'no_match' });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();

    await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ id: 42, discogs_unavailable: true }));
  });

  test('LML finds no match → unresolved counter, marker stamped, no write', async () => {
    const loadCandidates = makeLoadCandidates([
      {
        id: 99,
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        track_title: 'Call Your Name',
        album_id: null,
      },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'no_match' });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(write).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledTimes(1);
    expect(markAttempted).toHaveBeenCalledWith(99);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.unresolved).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('LML throws → lml_error counter; no write, no markAttempted (stays immediately retryable)', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 7, artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja', album_id: null },
    ]);
    const lookup = jest.fn<LookupFn>().mockRejectedValue(new Error('LML socket timeout'));
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(write).not.toHaveBeenCalled();
    expect(markAttempted).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.lml_error).toBe(1);
    expect(result.totals.resolved).toBe(0);
    expect(result.totals.unresolved).toBe(0);
  });

  test('write returns written:false → raced counter, not resolved', async () => {
    const loadCandidates = makeLoadCandidates([
      {
        id: 11,
        artist_name: 'Duke Ellington & John Coltrane',
        album_title: 'Duke Ellington & John Coltrane',
        track_title: 'In a Sentimental Mood',
        album_id: 3,
      },
    ]);
    const match = artwork(555);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', artwork: match });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: false });
    const markAttempted = makeMarkAttempted();

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(write).toHaveBeenCalledTimes(1);
    expect(markAttempted).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.raced).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('dryRun=true skips writes and bumps resolved_dry instead of resolved', async () => {
    const loadCandidates = makeLoadCandidates([
      {
        id: 42,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
        album_id: null,
      },
    ]);
    const match = artwork(999001);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', artwork: match });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted, dryRun: true });

    expect(write).not.toHaveBeenCalled();
    expect(markAttempted).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.resolved_dry).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('trust-rejected lookup (BS#1359/#1959) → trust_rejected counter, marker stamped, no write; batch continues', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 21529, artist_name: 'Noura Mint Seymali', album_title: 'Yenbett', track_title: 'Tzenni', album_id: null },
      {
        id: 8,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
        album_id: null,
      },
    ]);
    const match = artwork(999001);
    const lookup = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce({ kind: 'trust_rejected', searchType: 'alternative' })
      .mockResolvedValueOnce({ kind: 'resolved', artwork: match });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(write).toHaveBeenCalledTimes(1);
    expect(markAttempted).toHaveBeenCalledTimes(1);
    expect(markAttempted).toHaveBeenCalledWith(21529);
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.trust_rejected).toBe(1);
    expect(result.totals.resolved).toBe(1);
    expect(result.totals.unresolved).toBe(0);
  });

  test('counter invariant holds across a mixed batch (scanned == sum of outcome counters)', async () => {
    const loadCandidates = makeLoadCandidates([
      {
        id: 1,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
        album_id: null,
      },
      { id: 2, artist_name: 'Noura Mint Seymali', album_title: 'Yenbett', track_title: 'Tzenni', album_id: null },
      {
        id: 3,
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        track_title: 'Call Your Name',
        album_id: null,
      },
      { id: 4, artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja', album_id: null },
      { id: 5, artist_name: 'Stereolab', album_title: 'Dots and Loops', track_title: 'Diagonals', album_id: null },
    ]);
    const lookup = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce({ kind: 'resolved', artwork: artwork(111) }) // resolved
      .mockResolvedValueOnce({ kind: 'trust_rejected', searchType: 'alternative' }) // trust_rejected
      .mockResolvedValueOnce({ kind: 'no_match' }) // unresolved
      .mockRejectedValueOnce(new Error('LML socket timeout')) // lml_error
      .mockResolvedValueOnce({ kind: 'resolved', artwork: artwork(222) }); // raced
    const write = jest.fn<WriteFn>().mockResolvedValueOnce({ written: true }).mockResolvedValueOnce({ written: false });
    const markAttempted = makeMarkAttempted();

    const { totals } = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(totals).toEqual({
      scanned: 5,
      resolved: 1,
      resolved_dry: 0,
      unresolved: 1,
      trust_rejected: 1,
      lml_error: 1,
      raced: 1,
      db_error: 0,
    });
    expect(totals.scanned).toBe(
      totals.resolved +
        totals.resolved_dry +
        totals.unresolved +
        totals.trust_rejected +
        totals.lml_error +
        totals.raced +
        totals.db_error
    );
  });

  test('attempt-marker race reports raced instead of a no-match bucket', async () => {
    const loadCandidates = makeLoadCandidates([
      {
        id: 99,
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        track_title: 'Call Your Name',
        album_id: null,
      },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'no_match' });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = jest.fn<MarkAttemptedFn>().mockResolvedValue({ written: false });

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(markAttempted).toHaveBeenCalledWith(99);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.raced).toBe(1);
    expect(result.totals.unresolved).toBe(0);
  });

  test('a marker UPDATE that throws is isolated as db_error and the batch continues', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 1, artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja', album_id: null },
      {
        id: 2,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
        album_id: null,
      },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'no_match' });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = jest
      .fn<MarkAttemptedFn>()
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce({ written: true });

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(markAttempted).toHaveBeenCalledTimes(2);
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.db_error).toBe(1);
    expect(result.totals.unresolved).toBe(1);
  });

  test('a match write that throws is isolated as db_error, not resolved', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 1, artist_name: 'Stereolab', album_title: 'Dots and Loops', track_title: 'Diagonals', album_id: null },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', artwork: artwork(999) });
    const write = jest.fn<WriteFn>().mockRejectedValue(new Error('connection reset'));
    const markAttempted = makeMarkAttempted();

    const result = await runNoMatchRecheck({ loadCandidates, lookup, write, markAttempted });

    expect(result.totals.scanned).toBe(1);
    expect(result.totals.db_error).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('cooperative pause defers each row until live activity clears', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 5, artist_name: 'Stereolab', album_title: 'Dots and Loops', track_title: 'Diagonals', album_id: null },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', artwork: artwork(12345) });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();
    const checkLiveActivity = jest
      .fn<CheckLiveActivityFn>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const onLivePause = jest.fn();

    const result = await runNoMatchRecheck({
      loadCandidates,
      lookup,
      write,
      markAttempted,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 0,
      checkLiveActivity,
      onLivePause,
    });

    expect(checkLiveActivity).toHaveBeenCalledTimes(3);
    expect(checkLiveActivity).toHaveBeenCalledWith(60);
    expect(onLivePause).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.totals.resolved).toBe(1);
  });

  test('cooperative pause probe is skipped when lookback is 0', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 6, artist_name: 'Cat Power', album_title: 'Moon Pix', track_title: 'Metal Heart', album_id: null },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'no_match' });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });
    const markAttempted = makeMarkAttempted();
    const checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);

    await runNoMatchRecheck({
      loadCandidates,
      lookup,
      write,
      markAttempted,
      liveActivityLookbackSeconds: 0,
      checkLiveActivity,
    });

    expect(checkLiveActivity).not.toHaveBeenCalled();
  });
});
