/**
 * Log-contract pin for streaming-url-upgrade (BS#1672).
 *
 * The README's post-run jq sources the run totals from the summary line's
 * NESTED per-phase objects (`.album_metadata.candidates`,
 * `.flowsheet.last_id`, the per-service `.album_metadata.spotify.upgraded`,
 * ...) plus the top-level `dry_run`. Renaming any contracted field without
 * updating the runbook would silently break the post-run procedure — this
 * suite makes that a CI failure instead. Mirrors
 * tests/unit/jobs/apple-music-url-backfill/runbook-log-contract.test.ts.
 *
 * Contracted shapes:
 *   - `step: 'phase_started'` per phase: target (string), candidates
 *     (number), after_id (number).
 *   - `step: 'batch_done'` per batch: target, batch_index, wall_clock_ms,
 *     last_id, per-batch deltas (scanned / lml_error / cache_hits /
 *     {spotify,bandcamp}_{upgraded,would_upgrade,still_search}),
 *     total_scanned.
 *   - `step: 'finished' | 'stopped' | 'failed'` once: dry_run (boolean),
 *     album_metadata + flowsheet (objects, each carrying numeric candidates /
 *     scanned / lml_error / cache_hits / last_id and per-service spotify +
 *     bandcamp objects), stopped + failed (booleans), error_message on
 *     failed.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  requestStop,
  runUpgrade,
  __resetStopForTesting,
  type ApplyFn,
  type LookupFn,
} from '../../../../jobs/streaming-url-upgrade/orchestrate';
import { initLogger, closeLogger } from '../../../../jobs/streaming-url-upgrade/logger';

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

const SPOTIFY_SEARCH = 'https://open.spotify.com/search/Stereolab';
const BANDCAMP_SEARCH = 'https://bandcamp.com/search?q=Stereolab';
const SPOTIFY_VERIFIED = 'https://open.spotify.com/album/5aBcDeFgHiJkLmNoPqRsT';
const BANDCAMP_VERIFIED = 'https://stereolab.bandcamp.com/album/aluminum-tunes';

const lookupResult = (spotify: string | null, bandcamp: string | null): LookupResponse => ({
  results: [
    {
      library_item: { id: 1 },
      artwork: { release_id: 1, release_url: 'u', spotify_url: spotify, bandcamp_url: bandcamp },
    },
  ],
  search_type: 'direct',
});
const withBoth: LookupResponse = lookupResult(SPOTIFY_VERIFIED, BANDCAMP_VERIFIED);
const withNeither: LookupResponse = lookupResult(null, null);

const albumRow = (id: number, artist = 'Stereolab', album = 'Aluminum Tunes') => ({
  id,
  artist_name: artist,
  album_title: album,
  spotify_url: SPOTIFY_SEARCH,
  bandcamp_url: BANDCAMP_SEARCH,
});

const flowsheetRow = (id: number) => ({
  id,
  artist_name: 'Jessica Pratt',
  album_title: 'On Your Own Love Again',
  track_title: 'Back, Baby',
  spotify_url: SPOTIFY_SEARCH,
  bandcamp_url: BANDCAMP_SEARCH,
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

const expectServiceTotalsShape = (svc: unknown): void => {
  const st = svc as Record<string, unknown>;
  expect(typeof st.candidates).toBe('number');
  expect(typeof st.upgraded).toBe('number');
  expect(typeof st.would_upgrade).toBe('number');
  expect(typeof st.still_search).toBe('number');
  expect(typeof st.skipped_not_search).toBe('number');
  expect(typeof st.db_error).toBe('number');
};

/** The nested per-phase fields the README's jq interpolates. */
const expectPhaseTotalsShape = (phase: unknown): void => {
  const totals = phase as Record<string, unknown>;
  expect(typeof totals.candidates).toBe('number');
  expect(typeof totals.scanned).toBe('number');
  expect(typeof totals.lml_error).toBe('number');
  expect(typeof totals.cache_hits).toBe('number');
  expect(typeof totals.last_id).toBe('number');
  expectServiceTotalsShape(totals.spotify);
  expectServiceTotalsShape(totals.bandcamp);
};

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset wipes any unconsumed mockResolvedValueOnce queue from an
  // earlier test (clearAllMocks only clears call history).
  (db.execute as jest.Mock).mockReset();
  __resetStopForTesting();
  delete process.env.SENTRY_DSN;
  initLogger({ repo: 'Backend-Service', tool: 'streaming-url-upgrade', runId: 'test-run' });
});

afterEach(async () => {
  __resetStopForTesting();
  jest.restoreAllMocks();
  await closeLogger();
});

describe('runbook log contract — phase_started', () => {
  it('emits one phase_started per phase, album_metadata first, with numeric candidates + after_id', async () => {
    queueExecute([{ count: 2 }], [albumRow(5)], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const stdoutLines = captureJson('stdout');
    await runUpgrade(baseOpts(lookup, apply));

    const phaseStarted = stdoutLines.filter((l) => l.step === 'phase_started');
    expect(phaseStarted.map((l) => l.target)).toEqual(['album_metadata', 'flowsheet']);
    expect(phaseStarted[0].candidates).toBe(2);
    expect(phaseStarted[1].candidates).toBe(1);
    expect(typeof phaseStarted[0].after_id).toBe('number');
  });
});

describe('runbook log contract — batch_done', () => {
  it('emits one batch_done per batch with the contracted numeric fields and base tags', async () => {
    queueExecute([{ count: 2 }], [albumRow(5), albumRow(6, 'Juana Molina', 'DOGA')], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const stdoutLines = captureJson('stdout');
    await runUpgrade(baseOpts(lookup, apply));

    const batchDone = stdoutLines.filter((l) => l.step === 'batch_done');
    expect(batchDone.length).toBe(1);

    const rec = batchDone[0];
    expect(rec.target).toBe('album_metadata');
    expect(typeof rec.batch_index).toBe('number');
    expect(typeof rec.wall_clock_ms).toBe('number');
    expect(typeof rec.last_id).toBe('number');
    expect(typeof rec.total_scanned).toBe('number');
    expect(rec.repo).toBe('Backend-Service');
    expect(rec.tool).toBe('streaming-url-upgrade');
    expect(rec.run_id).toBe('test-run');
    expect(rec.scanned).toBe(2);
    expect(rec.spotify_upgraded).toBe(2);
    expect(rec.bandcamp_upgraded).toBe(2);
    expect(typeof rec.lml_error).toBe('number');
    expect(typeof rec.cache_hits).toBe('number');
    expect(typeof rec.spotify_still_search).toBe('number');
    expect(typeof rec.bandcamp_would_upgrade).toBe('number');
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
      .mockResolvedValueOnce(withBoth)
      .mockResolvedValueOnce(withNeither)
      .mockResolvedValueOnce(withNeither)
      .mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const stdoutLines = captureJson('stdout');
    await runUpgrade(baseOpts(lookup, apply));

    const finished = stdoutLines.find((l) => l.step === 'finished');
    expect(finished).toBeDefined();
    expect(finished?.dry_run).toBe(false);
    expect(finished?.stopped).toBe(false);
    expect(finished?.failed).toBe(false);

    expectPhaseTotalsShape(finished?.album_metadata);
    expectPhaseTotalsShape(finished?.flowsheet);

    const am = finished?.album_metadata as Record<string, unknown>;
    const fs = finished?.flowsheet as Record<string, unknown>;
    // Row 5 upgraded on pass 1; row 6 null on both passes → still_search.
    expect(am.candidates).toBe(2);
    expect((am.spotify as Record<string, unknown>).upgraded).toBe(1);
    expect((am.spotify as Record<string, unknown>).still_search).toBe(1);
    expect(am.last_id).toBe(6);
    // Flowsheet row 9 upgraded.
    expect(fs.candidates).toBe(1);
    expect((fs.spotify as Record<string, unknown>).upgraded).toBe(1);
    expect(fs.last_id).toBe(9);
  });

  it('dry-run finished line reports dry_run=true and would_upgrade instead of upgraded', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);

    const stdoutLines = captureJson('stdout');
    await runUpgrade({ lookup, dryRun: true, batchSize: 100, secondPassDelayMs: 0, liveActivityLookbackSeconds: 0 });

    const finished = stdoutLines.find((l) => l.step === 'finished');
    expect(finished?.dry_run).toBe(true);
    const am = finished?.album_metadata as Record<string, unknown>;
    expect((am.spotify as Record<string, unknown>).would_upgrade).toBe(1);
    expect((am.spotify as Record<string, unknown>).upgraded).toBe(0);
  });
});

describe('runbook log contract — stopped step', () => {
  it('emits step=stopped (not finished) on SIGTERM-induced early break, with resume cursors', async () => {
    queueExecute([{ count: 2 }], [albumRow(5), albumRow(6)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockImplementation(() => {
      requestStop(); // simulate SIGTERM while row 5 is in flight
      return Promise.resolve(withBoth);
    });
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const stdoutLines = captureJson('stdout');
    const result = await runUpgrade(baseOpts(lookup, apply));

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
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const stdoutLines = captureJson('stdout');
    const stderrLines = captureJson('stderr');
    await runUpgrade(baseOpts(lookup, apply));

    const failed = [...stdoutLines, ...stderrLines].find((l) => l.step === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.failed).toBe(true);
    expect(failed?.error_message).toMatch(/sustained outage/);
    expectPhaseTotalsShape(failed?.album_metadata);
    expectPhaseTotalsShape(failed?.flowsheet);
  }, 30_000);
});
