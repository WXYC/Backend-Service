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
import { runReenrichment, type LookupFn, type EnrichFn } from '../../../../jobs/flowsheet-reenrichment/orchestrate';
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
  delete process.env.SENTRY_DSN;
  initLogger({ repo: 'Backend-Service', tool: 'flowsheet-reenrichment', runId: 'test-run' });
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
