/**
 * Log-contract pin for apple-music-url-backfill (BS#1631).
 *
 * The README's post-run jq sources the run totals from the summary line's
 * NESTED per-phase objects (`.album_metadata.candidates`,
 * `.flowsheet.last_id`, ...) plus the top-level `dry_run`. Renaming any of
 * the contracted fields without updating the runbook would silently break
 * the post-run procedure — this suite makes that a CI failure instead.
 * Mirrors tests/unit/jobs/flowsheet-reenrichment/runbook-log-contract.test.ts.
 *
 * Contracted shapes:
 *   - `step: 'phase_started'` per phase: target (string), candidates
 *     (number), after_id (number).
 *   - `step: 'batch_done'` per batch: target, batch_index, wall_clock_ms,
 *     last_id, per-batch deltas (scanned / resolved / would_resolve /
 *     still_null / skipped_non_null / lml_error / db_error), total_scanned.
 *   - `step: 'finished' | 'stopped' | 'failed'` once: dry_run (boolean),
 *     album_metadata + flowsheet (objects, each carrying the numeric
 *     candidates / resolved / would_resolve / still_null /
 *     skipped_non_null / lml_error / db_error / last_id), stopped +
 *     failed (booleans), error_message on failed.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  requestStop,
  runBackfill,
  __resetStopForTesting,
  type ApplyFn,
  type LookupFn,
} from '../../../../jobs/apple-music-url-backfill/orchestrate';
import { initLogger, closeLogger } from '../../../../jobs/apple-music-url-backfill/logger';

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

const APPLE_URL = 'https://music.apple.com/us/album/aluminum-tunes/1533790069';

const withUrl: LookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'u', apple_music_url: APPLE_URL } }],
  search_type: 'direct',
};

const withoutUrl: LookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'u', apple_music_url: null } }],
  search_type: 'direct',
};

const albumRow = (id: number, artist = 'Stereolab', album = 'Aluminum Tunes') => ({
  id,
  artist_name: artist,
  album_title: album,
});

const flowsheetRow = (id: number) => ({
  id,
  artist_name: 'Jessica Pratt',
  album_title: 'On Your Own Love Again',
  track_title: 'Back, Baby',
});

const queueExecute = (...results: unknown[]): void => {
  for (const result of results) {
    (db.execute as jest.Mock).mockResolvedValueOnce(result as never);
  }
};

const baseOpts = (lookup: LookupFn, apply: ApplyFn) => ({
  lookup,
  apply,
  dryRun: false,
  batchSize: 100,
  secondPassDelayMs: 0,
  liveActivityLookbackSeconds: 0,
});

/** The nested per-phase fields the README's jq interpolates. */
const expectPhaseTotalsShape = (phase: unknown): void => {
  const totals = phase as Record<string, unknown>;
  expect(typeof totals.candidates).toBe('number');
  expect(typeof totals.resolved).toBe('number');
  expect(typeof totals.would_resolve).toBe('number');
  expect(typeof totals.still_null).toBe('number');
  expect(typeof totals.skipped_non_null).toBe('number');
  expect(typeof totals.lml_error).toBe('number');
  expect(typeof totals.db_error).toBe('number');
  expect(typeof totals.last_id).toBe('number');
};

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset wipes any unconsumed mockResolvedValueOnce queue from an
  // earlier test (clearAllMocks only clears call history).
  (db.execute as jest.Mock).mockReset();
  __resetStopForTesting();
  delete process.env.SENTRY_DSN;
  initLogger({ repo: 'Backend-Service', tool: 'apple-music-url-backfill', runId: 'test-run' });
});

afterEach(async () => {
  __resetStopForTesting();
  jest.restoreAllMocks();
  await closeLogger();
});

describe('runbook log contract — phase_started', () => {
  it('emits one phase_started per phase, album_metadata first, with numeric candidates + after_id', async () => {
    queueExecute([{ count: 2 }], [albumRow(5)], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const stdoutLines = captureJson('stdout');
    await runBackfill(baseOpts(lookup, apply));

    const phaseStarted = stdoutLines.filter((l) => l.step === 'phase_started');
    expect(phaseStarted.map((l) => l.target)).toEqual(['album_metadata', 'flowsheet']);
    expect(phaseStarted[0].candidates).toBe(2);
    expect(phaseStarted[1].candidates).toBe(1);
    expect(typeof phaseStarted[0].after_id).toBe('number');
  });
});

describe('runbook log contract — batch_done', () => {
  it('emits one batch_done per batch with the contracted numeric fields and base tags', async () => {
    queueExecute([{ count: 2 }], [albumRow(5), albumRow(6)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    // One clean fill, one raced skip — both deltas must surface.
    const apply = jest.fn<ApplyFn>().mockResolvedValueOnce('resolved').mockResolvedValueOnce('skipped_non_null');

    const stdoutLines = captureJson('stdout');
    await runBackfill(baseOpts(lookup, apply));

    const batchDone = stdoutLines.filter((l) => l.step === 'batch_done');
    expect(batchDone.length).toBe(1);

    const rec = batchDone[0];
    expect(rec.target).toBe('album_metadata');
    expect(typeof rec.batch_index).toBe('number');
    expect(typeof rec.wall_clock_ms).toBe('number');
    expect(typeof rec.last_id).toBe('number');
    expect(typeof rec.total_scanned).toBe('number');
    expect(rec.repo).toBe('Backend-Service');
    expect(rec.tool).toBe('apple-music-url-backfill');
    expect(rec.run_id).toBe('test-run');
    expect(rec.scanned).toBe(2);
    expect(rec.resolved).toBe(1);
    expect(rec.skipped_non_null).toBe(1);
    expect(rec.still_null).toBe(0);
    expect(rec.would_resolve).toBe(0);
    expect(typeof rec.lml_error).toBe('number');
    expect(typeof rec.db_error).toBe('number');
  });
});

describe('runbook log contract — finished', () => {
  it('carries dry_run plus the nested per-phase objects the README jq interpolates', async () => {
    // Row 6 is a DIFFERENT album than row 5 — same-key rows would be served
    // from the dedup cache and never reach the second-pass mocks below.
    queueExecute(
      [{ count: 2 }],
      [albumRow(5), albumRow(6, 'Juana Molina', 'DOGA')],
      [],
      [{ count: 1 }],
      [flowsheetRow(9)],
      []
    );
    const lookup = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce(withUrl)
      .mockResolvedValueOnce(withoutUrl)
      .mockResolvedValueOnce(withoutUrl)
      .mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const stdoutLines = captureJson('stdout');
    await runBackfill(baseOpts(lookup, apply));

    const finished = stdoutLines.find((l) => l.step === 'finished');
    expect(finished).toBeDefined();
    expect(finished?.dry_run).toBe(false);
    expect(finished?.stopped).toBe(false);
    expect(finished?.failed).toBe(false);

    expectPhaseTotalsShape(finished?.album_metadata);
    expectPhaseTotalsShape(finished?.flowsheet);

    const am = finished?.album_metadata as Record<string, unknown>;
    const fs = finished?.flowsheet as Record<string, unknown>;
    // Row 5 resolved on pass 1; row 6 null on both passes → still_null.
    expect(am.candidates).toBe(2);
    expect(am.resolved).toBe(1);
    expect(am.still_null).toBe(1);
    expect(am.last_id).toBe(6);
    // Flowsheet row 9 resolved.
    expect(fs.candidates).toBe(1);
    expect(fs.resolved).toBe(1);
    expect(fs.last_id).toBe(9);
  });

  it('dry-run finished line reports dry_run=true and would_resolve instead of resolved', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);

    const stdoutLines = captureJson('stdout');
    await runBackfill({ lookup, dryRun: true, batchSize: 100, secondPassDelayMs: 0, liveActivityLookbackSeconds: 0 });

    const finished = stdoutLines.find((l) => l.step === 'finished');
    expect(finished?.dry_run).toBe(true);
    const am = finished?.album_metadata as Record<string, unknown>;
    expect(am.would_resolve).toBe(1);
    expect(am.resolved).toBe(0);
  });
});

describe('runbook log contract — stopped step', () => {
  it('emits step=stopped (not finished) on SIGTERM-induced early break, with resume cursors', async () => {
    queueExecute([{ count: 2 }], [albumRow(5), albumRow(6)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockImplementation(() => {
      requestStop(); // simulate SIGTERM while row 5 is in flight
      return Promise.resolve(withUrl);
    });
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const stdoutLines = captureJson('stdout');
    const result = await runBackfill(baseOpts(lookup, apply));

    // The README jq selects finished OR stopped OR failed; a stopped run
    // MUST be distinguishable so the operator knows to resume, and it
    // interpolates the SAME fields as finished — dry_run plus BOTH nested
    // phase objects (resume needs .flowsheet.last_id even when the stop
    // landed in phase A).
    expect(stdoutLines.find((l) => l.step === 'finished')).toBeUndefined();
    const stopped = stdoutLines.find((l) => l.step === 'stopped');
    expect(stopped).toBeDefined();
    expect(stopped?.stopped).toBe(true);
    expect(stopped?.dry_run).toBe(false);
    expectPhaseTotalsShape(stopped?.album_metadata);
    expectPhaseTotalsShape(stopped?.flowsheet);
    expect((stopped?.album_metadata as Record<string, unknown>).last_id).toBe(5);
    expect(result.stopped).toBe(true);
  });
});

describe('runbook log contract — failed step', () => {
  it('emits step=failed with error_message and per-phase last_id when loadBatch exhausts retries', async () => {
    const err = new Error('sustained outage');
    (db.execute as jest.Mock).mockResolvedValueOnce([{ count: 1 }] as never);
    (db.execute as jest.Mock).mockRejectedValue(err as never);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const stdoutLines = captureJson('stdout');
    const stderrLines = captureJson('stderr');
    await runBackfill(baseOpts(lookup, apply));

    const failed = [...stdoutLines, ...stderrLines].find((l) => l.step === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.failed).toBe(true);
    expect(failed?.error_message).toMatch(/sustained outage/);
    expectPhaseTotalsShape(failed?.album_metadata);
    expectPhaseTotalsShape(failed?.flowsheet);
  }, 30_000);
});
