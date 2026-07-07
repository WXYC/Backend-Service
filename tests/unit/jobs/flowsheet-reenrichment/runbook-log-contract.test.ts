/**
 * Log-contract pin for flowsheet-reenrichment.
 *
 * The post-run comment on BS#1433 is sourced from the `finished` log line's
 * `flipped` field. Renaming any of the contracted fields without updating
 * the runbook + issue-comment procedure will silently break observability.
 *
 * Contracted shapes:
 *   - `step: 'batch_done'` per batch: batch_index (number), wall_clock_ms
 *     (number), scanned (number), match (number), still_no_match (number),
 *     lml_error (number), flipped (number).
 *   - `step: 'finished'` once: scanned (number), flipped (number),
 *     still_no_match (number), lml_error (number).
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  runReenrichment,
  type LookupFn,
  type EnrichFn,
  __resetStopForTesting,
} from '../../../../jobs/flowsheet-reenrichment/orchestrate';
import { initLogger, closeLogger } from '../../../../jobs/flowsheet-reenrichment/logger';
import type { LookupResponse } from '@wxyc/lml-client';

type JsonLine = Record<string, unknown>;

const captureJson = (stream: 'stdout' | 'stderr'): JsonLine[] => {
  const lines: JsonLine[] = [];
  jest.spyOn(process[stream], 'write').mockImplementation((chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as JsonLine);
      } catch {
        // ignore non-JSON
      }
    }
    return true;
  });
  return lines;
};

const makeRow = (id: number) => ({ id, artist_name: 'Juana Molina', album_title: 'DOGA', track_title: null });

const CUTOFF = '2026-06-16T17:53:53Z';

const noMatchResponse: LookupResponse = { results: [], search_type: 'none' };
const matchedResponse: LookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'u' } }],
  search_type: 'direct',
};

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset wipes the mockResolvedValueOnce queue too (clearAllMocks
  // only clears call history, so an unconsumed mockResolvedValueOnce from
  // an earlier test would leak into the next one and make db.execute
  // return [] before the test's intended mock values).
  (db.execute as jest.Mock).mockReset();
  // Reset module-level singleton so tests that exercise requestStop()
  // don't leak the flag into subsequent tests (round 3).
  __resetStopForTesting();
  delete process.env.SENTRY_DSN;
  initLogger({ repo: 'Backend-Service', tool: 'flowsheet-reenrichment', runId: 'test-run' });
});

afterEach(() => {
  __resetStopForTesting();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeLogger();
});

describe('runbook log contract — batch_done', () => {
  it('emits one batch_done JSON record per batch with the contracted numeric fields', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: noMatchResponse, cacheHit: false });
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const stdoutLines = captureJson('stdout');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 2, liveActivityLookbackSeconds: 0 });

    const batchDone = stdoutLines.filter((l) => l.step === 'batch_done');
    expect(batchDone.length).toBe(1);

    const rec = batchDone[0];
    expect(typeof rec.batch_index).toBe('number');
    expect(typeof rec.wall_clock_ms).toBe('number');
    expect(typeof rec.scanned).toBe('number');
    expect(typeof rec.match).toBe('number');
    expect(typeof rec.still_no_match).toBe('number');
    expect(typeof rec.lml_error).toBe('number');
    expect(typeof rec.flipped).toBe('number');
    expect(rec.repo).toBe('Backend-Service');
    expect(rec.tool).toBe('flowsheet-reenrichment');
    expect(rec.run_id).toBe('test-run');
    expect(rec.scanned).toBe(2);
    expect(rec.still_no_match).toBe(2);
    expect(rec.match).toBe(0);
    expect(rec.flipped).toBe(0);
  });

  it('tracks match and flipped separately when some UPDATEs race', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: matchedResponse, cacheHit: false });
    // First row → match (non-raced), second → match_raced
    const enrich = jest.fn<EnrichFn>().mockResolvedValueOnce('match').mockResolvedValueOnce('match_raced');

    const stdoutLines = captureJson('stdout');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 10, liveActivityLookbackSeconds: 0 });

    const rec = stdoutLines.find((l) => l.step === 'batch_done');
    expect(rec?.match).toBe(1); // non-raced matches
    expect(rec?.match_raced).toBe(1); // raced matches
    expect(rec?.flipped).toBe(1); // = match (non-raced)
  });
});

describe('runbook log contract — db_error / match_raced field pinning (round 4)', () => {
  it('batch_done emits db_error and match_raced as numeric fields', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: matchedResponse, cacheHit: false });
    // db_error path: enrich throws → counted as db_error
    const enrich = jest.fn<EnrichFn>().mockRejectedValueOnce(new Error('pg blip'));

    const stdoutLines = captureJson('stdout');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 10, liveActivityLookbackSeconds: 0 });

    const rec = stdoutLines.find((l) => l.step === 'batch_done');
    expect(typeof rec?.db_error).toBe('number');
    expect(typeof rec?.match_raced).toBe('number');
    expect(rec?.db_error).toBe(1);
  });

  it('finished log carries match_raced, db_error, last_id, and stopped fields', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(7)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: matchedResponse, cacheHit: false });
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match');

    const stdoutLines = captureJson('stdout');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 10, liveActivityLookbackSeconds: 0 });

    const finished = stdoutLines.find((l) => l.step === 'finished');
    expect(typeof finished?.match_raced).toBe('number');
    expect(typeof finished?.db_error).toBe('number');
    expect(typeof finished?.last_id).toBe('number');
    expect(typeof finished?.stopped).toBe('boolean');
    expect(finished?.last_id).toBe(7); // resume cursor
    expect(finished?.stopped).toBe(false);
  });
});

describe('runbook log contract — failed step (round 4)', () => {
  it('emits step=failed with last_id when loadBatch exhausts retries', async () => {
    const err = new Error('sustained outage');
    (db.execute as jest.Mock).mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockRejectedValueOnce(err);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: noMatchResponse, cacheHit: false });
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const stdoutLines = captureJson('stdout');
    const stderrLines = captureJson('stderr');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 100, liveActivityLookbackSeconds: 0 });

    const failed = [...stdoutLines, ...stderrLines].find((l) => l.step === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.failed).toBe(true);
    expect(failed?.error_message).toMatch(/sustained outage/);
    expect(typeof failed?.last_id).toBe('number');
    expect(typeof failed?.scanned).toBe('number');
    // Runbook's jq filter must include 'failed' alongside finished/stopped
    // so the operator can extract last_id for resume after a sustained outage.
  }, 30_000);
});

describe('runbook log contract — stopped step (round 3)', () => {
  it('emits step=stopped (not finished) on SIGTERM-induced early break', async () => {
    const { requestStop, __resetStopForTesting } = await import('../../../../jobs/flowsheet-reenrichment/orchestrate');
    __resetStopForTesting();
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockImplementation(() => {
      requestStop(); // simulate SIGTERM during processing of row 1
      return Promise.resolve({ response: noMatchResponse, cacheHit: false });
    });
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const stdoutLines = captureJson('stdout');
    const result = await runReenrichment({
      lookup,
      enrich,
      cutoffTs: CUTOFF,
      batchSize: 10,
      liveActivityLookbackSeconds: 0,
    });

    // Runbook's jq filter is `select(.step=="finished" or .step=="stopped")`.
    // A stopped run MUST be distinguishable from a finished one so the
    // runbook can tell the operator to re-run.
    const finished = stdoutLines.find((l) => l.step === 'finished');
    const stopped = stdoutLines.find((l) => l.step === 'stopped');
    expect(finished).toBeUndefined();
    expect(stopped).toBeDefined();
    expect(stopped?.stopped).toBe(true);
    expect(result.stopped).toBe(true);
    __resetStopForTesting();
  });
});

describe('runbook log contract — match_raced_summary (round 3)', () => {
  it('emits one summary log per run when match_raced > 0 (not per-row)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1), makeRow(2), makeRow(3)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: matchedResponse, cacheHit: false });
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('match_raced');

    const stdoutLines = captureJson('stdout');
    const stderrLines = captureJson('stderr');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 10, liveActivityLookbackSeconds: 0 });

    const summaries = [...stdoutLines, ...stderrLines].filter((l) => l.step === 'match_raced_summary');
    expect(summaries.length).toBe(1);
    expect(summaries[0].match_raced_count).toBe(3);
    expect(summaries[0].sample_ids).toEqual([1, 2, 3]);
    expect(summaries[0].truncated_count).toBe(0);
  });

  it('does NOT emit when match_raced is zero', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([makeRow(1)]).mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: noMatchResponse, cacheHit: false });
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('still_no_match');

    const stdoutLines = captureJson('stdout');
    const stderrLines = captureJson('stderr');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 10, liveActivityLookbackSeconds: 0 });

    const summaries = [...stdoutLines, ...stderrLines].filter((l) => l.step === 'match_raced_summary');
    expect(summaries.length).toBe(0);
  });
});

describe('runbook log contract — finished', () => {
  it('emits finished with cumulative scanned / flipped / still_no_match / lml_error', async () => {
    // Two batches: batch 1 has a match, batch 2 has a still_no_match
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([makeRow(1)])
      .mockResolvedValueOnce([makeRow(2)])
      .mockResolvedValueOnce([]);

    const lookup = jest.fn<LookupFn>().mockResolvedValue({ response: matchedResponse, cacheHit: false });
    const enrich = jest.fn<EnrichFn>().mockResolvedValueOnce('match').mockResolvedValueOnce('still_no_match');

    const stdoutLines = captureJson('stdout');
    await runReenrichment({ lookup, enrich, cutoffTs: CUTOFF, batchSize: 1, liveActivityLookbackSeconds: 0 });

    const finished = stdoutLines.find((l) => l.step === 'finished');
    expect(finished).toBeDefined();
    expect(typeof finished?.scanned).toBe('number');
    expect(typeof finished?.flipped).toBe('number');
    expect(typeof finished?.still_no_match).toBe('number');
    expect(typeof finished?.lml_error).toBe('number');
    expect(finished?.scanned).toBe(2);
    expect(finished?.flipped).toBe(1);
    expect(finished?.still_no_match).toBe(1);
    expect(finished?.lml_error).toBe(0);
  });
});
