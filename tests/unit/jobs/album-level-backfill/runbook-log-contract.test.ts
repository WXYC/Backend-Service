/**
 * BS#1179 regression pin: the album-level-backfill drain log shape MUST stay
 * in lockstep with the BS#1078 Phase 3 runbook's `jq` watchdog and grep
 * probes (`docs/ops-album-level-backfill-phase3.md`).
 *
 * The 2026-05-27 incident: the runbook's `jq -r 'select(.step=="batch_done"
 * and .wall_clock_ms>25000) ...'` watchdog was wired into a launcher script
 * but the job emitted plain text with `elapsed_ms`, so the filter never
 * matched. A fully-failing 14.5h drain ran unnoticed.
 *
 * These tests assert the structural contract the runbook reads:
 *   - `step: 'batch_done'` per batch with `wall_clock_ms`, `batch_index`,
 *     `scanned`, `lml_error` keys
 *   - `step: 'lml_batch_failed'` when bulkLookupMetadata throws, with
 *     `size`, `first_album_id`, `last_album_id`, `error_message` keys
 *   - `step: 'post_pass_update_done'` after the post-pass UPDATE (Step 5
 *     grep target in the runbook)
 *
 * Renaming any of these keys (or the step names) without updating the
 * runbook in lockstep will break the watchdog silently. Don't.
 */

import { jest } from '@jest/globals';

const mockBulkLookupMetadata = jest.fn<(items: unknown, opts?: unknown) => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  __esModule: true,
  bulkLookupMetadata: mockBulkLookupMetadata,
}));

import { db } from '@wxyc/database';
import { runBackfill, type BackfillOptions } from '../../../../jobs/album-level-backfill/job';
import { initLogger, closeLogger } from '../../../../jobs/album-level-backfill/logger';

type JsonLine = Record<string, unknown>;

const baseOptions = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  batchSize: 2,
  ratePerMin: 60_000, // sleep ≈ 1ms between batches; keeps tests fast
  budgetMs: 25_000,
  postPassTimeoutMs: 60_000,
  readTimeoutMs: 300_000,
  liveActivityLookbackSeconds: 0,
  liveActivityPauseMs: 1,
  dryRun: false,
  ...over,
});

const captureStdoutJson = (): JsonLine[] => {
  const lines: JsonLine[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as JsonLine);
      } catch {
        // Non-JSON stdout (jest worker chatter etc.) is ignored.
      }
    }
    return true;
  });
  return lines;
};

const captureStderrJson = (): JsonLine[] => {
  const lines: JsonLine[] = [];
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as JsonLine);
      } catch {
        // Non-JSON stderr (e.g. Sentry's own warnings) is ignored.
      }
    }
    return true;
  });
  return lines;
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SENTRY_DSN;
  initLogger({ repo: 'Backend-Service', tool: 'album-level-backfill', runId: 'test-run' });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeLogger();
});

const wrappedSelect = (rows: unknown[]): [unknown, unknown] => [{}, rows];

describe('runbook log contract — batch_done', () => {
  it('emits one batch_done JSON record per batch with wall_clock_ms / batch_index / scanned / lml_error', async () => {
    const resolved = [
      { album_id: 1, artist_name: 'A', album_title: 'X' },
      { album_id: 2, artist_name: 'B', album_title: 'Y' },
    ];
    const mock = db.execute as jest.Mock;
    for (const v of [
      ...wrappedSelect([{ album_id: 1 }, { album_id: 2 }, { album_id: 3 }, { album_id: 4 }]),
      ...wrappedSelect(resolved),
      ...wrappedSelect(resolved),
      ...wrappedSelect([{ flipped: 0 }]),
    ]) {
      mock.mockResolvedValueOnce(v);
    }
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'no_match', lookup: { results: [] } },
        { index: 1, status: 'error', lookup: null, message: 'Boom' },
      ],
    });

    const stdoutLines = captureStdoutJson();
    await runBackfill(baseOptions({ batchSize: 2 }));

    const batchDone = stdoutLines.filter((l) => l.step === 'batch_done');
    // BS#1078 runbook watchdog (line 122 of ops-album-level-backfill-phase3.md):
    //   jq -r 'select(.step=="batch_done" and .wall_clock_ms>25000) | "...batch_index=\(.batch_index)..."'
    // Both `step==='batch_done'` and the `wall_clock_ms` + `batch_index` keys
    // MUST exist or the watchdog stays silent.
    expect(batchDone.length).toBe(2);
    for (const rec of batchDone) {
      expect(typeof rec.wall_clock_ms).toBe('number');
      expect(typeof rec.batch_index).toBe('number');
      // Step-4 aggregate (line 138-145 of the runbook) sums `.scanned` and
      // `.lml_error // 0`. Both keys must be numeric.
      expect(typeof rec.scanned).toBe('number');
      expect(typeof rec.lml_error).toBe('number');
      // Spot-check the other accounting keys we emit alongside.
      expect(rec).toHaveProperty('match');
      expect(rec).toHaveProperty('no_match');
      expect(rec).toHaveProperty('upserts');
      expect(rec).toHaveProperty('batches');
      // Tag bundle from the base logger.
      expect(rec.repo).toBe('Backend-Service');
      expect(rec.tool).toBe('album-level-backfill');
      expect(rec.run_id).toBe('test-run');
    }
    // Per-batch lml_error reflects the LML per-item error.
    expect(batchDone[0].lml_error).toBe(1);
    expect(batchDone[1].lml_error).toBe(1);
  });
});

describe('runbook log contract — lml_batch_failed', () => {
  it('emits structured lml_batch_failed on bulkLookupMetadata throw (replaces the BS#1179 plain-text line)', async () => {
    const resolved = [
      { album_id: 100, artist_name: 'A', album_title: 'X' },
      { album_id: 200, artist_name: 'B', album_title: 'Y' },
    ];
    const mock = db.execute as jest.Mock;
    for (const v of [
      ...wrappedSelect([{ album_id: 100 }, { album_id: 200 }]),
      ...wrappedSelect(resolved),
      ...wrappedSelect([{ flipped: 0 }]),
    ]) {
      mock.mockResolvedValueOnce(v);
    }
    mockBulkLookupMetadata.mockRejectedValueOnce(
      Object.assign(new Error('LML request timed out'), { name: 'LmlClientError' })
    );

    const stdoutLines = captureStdoutJson();
    const stderrLines = captureStderrJson();
    await runBackfill(baseOptions({ batchSize: 2 }));

    const failed = [...stdoutLines, ...stderrLines].find((l) => l.step === 'lml_batch_failed');
    expect(failed).toBeDefined();
    // The plain-text line at jobs/album-level-backfill/job.ts (pre-#1179)
    // packed first/last_album_id + error into a flat string; the runbook
    // can't tail-and-filter it. Now structured so `jq` can.
    expect(failed?.size).toBe(2);
    expect(failed?.first_album_id).toBe(100);
    expect(failed?.last_album_id).toBe(200);
    expect(failed?.error_message).toMatch(/LmlClientError: LML request timed out/);
    expect(failed?.level).toBe('warn');
  });
});

describe('runbook log contract — post_pass_update_done', () => {
  it('emits post_pass_update_done after the post-pass UPDATE (Step 5 grep target)', async () => {
    const resolved = [{ album_id: 1, artist_name: 'A', album_title: 'X' }];
    const mock = db.execute as jest.Mock;
    for (const v of [
      ...wrappedSelect([{ album_id: 1 }]),
      ...wrappedSelect(resolved),
      ...wrappedSelect([{ flipped: 42 }]),
    ]) {
      mock.mockResolvedValueOnce(v);
    }
    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    const stdoutLines = captureStdoutJson();
    await runBackfill(baseOptions({ batchSize: 1 }));

    // Runbook Step 5 (line 155): grep '"step":"post_pass_update_done"' /tmp/...
    const done = stdoutLines.find((l) => l.step === 'post_pass_update_done');
    expect(done).toBeDefined();
    expect(done?.flipped).toBe(42);
    expect(typeof done?.wall_clock_ms).toBe('number');
  });
});
