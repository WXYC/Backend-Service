/**
 * Unit tests for apple-music-url-backfill orchestrate.ts (BS#1631).
 *
 * Pins the behaviors the remediation depends on:
 *
 *   1. Candidate selection predicates for both phases:
 *      - album_metadata: apple_music_url IS NULL AND (discogs_url IS NOT
 *        NULL OR library.on_streaming) — plus the album_id cursor.
 *      - flowsheet: entry_type='track' AND apple_music_url IS NULL AND
 *        (discogs_url IS NOT NULL OR linked library.on_streaming) AND
 *        artist_name IS NOT NULL — plus the id cursor.
 *   2. Dry-run (the default mode wired by job.ts) performs LML lookups but
 *      ZERO database writes; would-change rows are counted.
 *   3. Second-pass logic: a second LML lookup fires only when the first
 *      returned no URL (catches LML#706's eventually-consistent fill).
 *   4. Resumability: BACKFILL_*_AFTER_ID cursors narrow the SELECT; the
 *      run result carries per-phase last_id resume cursors.
 *   5. Idempotency: a re-run over an already-filled row reports
 *      skipped_non_null (never a second write) via the SQL guard.
 *   6. Error arms (lml_error / db_error) count and continue; loadBatch
 *      retry exhaustion flags failed=true for the exit-code path.
 *   7. Cooperative pause and SIGTERM stop mirror the sibling backfills.
 */
import { jest } from '@jest/globals';

import { db, checkLiveActivity as mockCheckLiveActivity } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  BATCH_SIZE,
  SECOND_PASS_DELAY_MS,
  requestStop,
  resolveAfterId,
  resolveBatchSize,
  resolveDryRun,
  resolveMaxRowsPerTable,
  resolveSecondPassDelayMs,
  runBackfill,
  __resetStopForTesting,
  type ApplyFn,
  type LookupFn,
} from '../../../../jobs/apple-music-url-backfill/orchestrate';

type SqlLike = { sql?: string | string[]; values?: unknown[]; raw?: string };
/**
 * Render the tests/__mocks__/drizzle-orm.ts sql-tag shape ({ sql: strings,
 * values }) to a flat string, recursing into nested fragments (the shared
 * WHERE/FROM chunks) and sql.raw identifiers ({ raw }) so predicate and
 * cursor assertions can see the fully composed query text.
 */
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) {
    const values = obj.values ?? [];
    return obj.sql.map((chunk, i) => chunk + (i < values.length ? renderSql(values[i]) : '')).join('');
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};

const APPLE_URL = 'https://music.apple.com/us/album/doga/1748219473';

const withUrl: LookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: { release_id: 100, release_url: 'https://www.discogs.com/release/100', apple_music_url: APPLE_URL },
    },
  ],
  search_type: 'direct',
};

const withoutUrl: LookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: { release_id: 100, release_url: 'https://www.discogs.com/release/100', apple_music_url: null },
    },
  ],
  search_type: 'direct',
};

const albumRow = (id: number, artist = 'Juana Molina', album = 'DOGA') => ({
  id,
  artist_name: artist,
  album_title: album,
});

const flowsheetRow = (
  id: number,
  artist = 'Jessica Pratt',
  album = 'On Your Own Love Again',
  track = 'Back, Baby'
) => ({
  id,
  artist_name: artist,
  album_title: album,
  track_title: track,
});

/**
 * Queue db.execute results in call order. The orchestrator's call order is
 * deterministic: phase A count, phase A batches (until empty), phase B
 * count, phase B batches (until empty).
 */
const queueExecute = (...results: unknown[]): void => {
  const mock = db.execute as jest.Mock;
  for (const result of results) {
    mock.mockResolvedValueOnce(result as never);
  }
};

/** Both phases empty — for tests that only exercise resolvers/edges. */
const emptyRun = (): void => {
  queueExecute([{ count: 0 }], [], [{ count: 0 }], []);
};

const baseOpts = (lookup: LookupFn, apply?: ApplyFn) => ({
  lookup,
  ...(apply ? { apply } : {}),
  dryRun: false,
  batchSize: 100,
  secondPassDelayMs: 0,
  liveActivityLookbackSeconds: 0,
});

describe('resolveDryRun', () => {
  it('defaults to dry-run when no flag is passed', () => {
    expect(resolveDryRun(['node', 'job.js'])).toBe(true);
  });

  it('explicit --dry-run stays dry-run', () => {
    expect(resolveDryRun(['node', 'job.js', '--dry-run'])).toBe(true);
  });

  it('--execute switches writes on', () => {
    expect(resolveDryRun(['node', 'job.js', '--execute'])).toBe(false);
  });

  it('throws on contradictory flags', () => {
    expect(() => resolveDryRun(['node', 'job.js', '--execute', '--dry-run'])).toThrow(/contradictory/i);
  });
});

describe('env resolvers', () => {
  it('resolveBatchSize falls back to BATCH_SIZE and parses positive integers', () => {
    expect(resolveBatchSize(undefined)).toBe(BATCH_SIZE);
    expect(resolveBatchSize('200')).toBe(200);
    expect(() => resolveBatchSize('0')).toThrow(/BACKFILL_BATCH_SIZE/);
  });

  it('resolveSecondPassDelayMs falls back to SECOND_PASS_DELAY_MS and accepts 0', () => {
    expect(resolveSecondPassDelayMs(undefined)).toBe(SECOND_PASS_DELAY_MS);
    expect(resolveSecondPassDelayMs('0')).toBe(0);
    expect(resolveSecondPassDelayMs('5000')).toBe(5000);
  });

  it('resolveMaxRowsPerTable defaults to 0 (unlimited) and accepts positive caps', () => {
    expect(resolveMaxRowsPerTable(undefined)).toBe(0);
    expect(resolveMaxRowsPerTable('250')).toBe(250);
  });

  it('resolveAfterId defaults to 0 and rejects negatives', () => {
    expect(resolveAfterId('BACKFILL_ALBUM_AFTER_ID', undefined)).toBe(0);
    expect(resolveAfterId('BACKFILL_ALBUM_AFTER_ID', '150')).toBe(150);
    expect(() => resolveAfterId('BACKFILL_ALBUM_AFTER_ID', '-1')).toThrow(/BACKFILL_ALBUM_AFTER_ID/);
  });
});

describe('runBackfill — candidate selection predicates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('album_metadata SELECT: apple_music_url IS NULL AND (discogs_url IS NOT NULL OR on_streaming)', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    await runBackfill(baseOpts(lookup, apply));

    const batchSql = renderSql((db.execute as jest.Mock).mock.calls[1]?.[0]);
    expect(batchSql).toMatch(/album_metadata/);
    expect(batchSql).toMatch(/"apple_music_url" IS NULL/);
    expect(batchSql).toMatch(/"discogs_url" IS NOT NULL/);
    expect(batchSql).toMatch(/on_streaming/);
    expect(batchSql).toMatch(/ORDER BY/);
  });

  it('flowsheet SELECT: entry_type=track AND apple_music_url IS NULL AND signal OR-pair AND artist_name IS NOT NULL', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    await runBackfill(baseOpts(lookup, apply));

    const batchSql = renderSql((db.execute as jest.Mock).mock.calls[3]?.[0]);
    expect(batchSql).toMatch(/flowsheet/);
    expect(batchSql).toMatch(/entry_type.*track/s);
    expect(batchSql).toMatch(/"apple_music_url" IS NULL/);
    expect(batchSql).toMatch(/"discogs_url" IS NOT NULL/);
    expect(batchSql).toMatch(/on_streaming/);
    expect(batchSql.toLowerCase()).toMatch(/artist_name.*is not null/s);
  });

  it('count queries share the batch predicates and populate per-phase candidate totals', async () => {
    queueExecute([{ count: 7 }], [], [{ count: 3 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    const countASql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(countASql).toMatch(/COUNT/i);
    expect(countASql).toMatch(/"apple_music_url" IS NULL/);
    expect(result.album_metadata.candidates).toBe(7);
    expect(result.flowsheet.candidates).toBe(3);
  });

  it('processes album_metadata fully before flowsheet', async () => {
    queueExecute(
      [{ count: 1 }],
      [albumRow(5, 'Stereolab', 'Aluminum Tunes')],
      [],
      [{ count: 1 }],
      [flowsheetRow(9)],
      []
    );
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    await runBackfill(baseOpts(lookup, apply));

    expect(lookup.mock.calls[0]?.[0]).toBe('Stereolab');
    expect(lookup.mock.calls[1]?.[0]).toBe('Jessica Pratt');
    expect(apply).toHaveBeenNthCalledWith(1, 'album_metadata', 5, APPLE_URL);
    expect(apply).toHaveBeenNthCalledWith(2, 'flowsheet', 9, APPLE_URL);
  });

  it('flowsheet lookups carry the row track_title (apple URLs are track-aware, BS#1192)', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    await runBackfill(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledWith('Jessica Pratt', 'On Your Own Love Again', 'Back, Baby');
  });

  it('ID cursor advances across batches and the loop terminates on an empty batch', async () => {
    queueExecute([{ count: 3 }], [albumRow(10), albumRow(20)], [albumRow(30)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withoutUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill({ ...baseOpts(lookup, apply), batchSize: 2 });

    const secondBatchSql = renderSql((db.execute as jest.Mock).mock.calls[2]?.[0]);
    expect(secondBatchSql).toMatch(/20/);
    expect(result.album_metadata.scanned).toBe(3);
    expect(result.album_metadata.last_id).toBe(30);
  });
});

describe('runBackfill — dry-run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('performs lookups but ZERO writes (default apply, real db handle): would_resolve counted', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);

    const result = await runBackfill({
      lookup,
      dryRun: true,
      batchSize: 100,
      secondPassDelayMs: 0,
      liveActivityLookbackSeconds: 0,
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(db.update as jest.Mock).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
    expect(result.album_metadata.would_resolve).toBe(1);
    expect(result.flowsheet.would_resolve).toBe(1);
    expect(result.album_metadata.resolved).toBe(0);
    expect(result.flowsheet.resolved).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it('still counts still_null rows in dry-run', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withoutUrl);

    const result = await runBackfill({
      lookup,
      dryRun: true,
      batchSize: 100,
      secondPassDelayMs: 0,
      liveActivityLookbackSeconds: 0,
    });

    expect(db.update as jest.Mock).not.toHaveBeenCalled();
    expect(result.album_metadata.still_null).toBe(1);
    expect(result.album_metadata.would_resolve).toBe(0);
  });
});

describe('runBackfill — second-pass logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('skips the second lookup when the first returns a URL', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.album_metadata.second_pass_attempts).toBe(0);
    expect(result.album_metadata.resolved).toBe(1);
  });

  it('fires a second lookup when the first returns null; second URL resolves the row', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValueOnce(withoutUrl).mockResolvedValueOnce(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.album_metadata.second_pass_attempts).toBe(1);
    expect(result.album_metadata.second_pass_resolved).toBe(1);
    expect(result.album_metadata.resolved).toBe(1);
    expect(apply).toHaveBeenCalledWith('album_metadata', 5, APPLE_URL);
  });

  it('counts still_null when both passes return no URL', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withoutUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.album_metadata.still_null).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('runBackfill — dedup cache (BS#1192: keyed on artist+album+track)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('re-uses a resolved URL for repeat (artist, album, track) triples without new lookups', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 2 }], [flowsheetRow(9), flowsheetRow(11)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(result.flowsheet.cache_hits).toBe(1);
    expect(result.flowsheet.resolved).toBe(2);
  });

  it('does NOT share a URL across rows with different track titles', async () => {
    queueExecute(
      [{ count: 0 }],
      [],
      [{ count: 2 }],
      [
        flowsheetRow(9, 'Chuquimamani-Condori', 'Edits', 'Call Your Name'),
        flowsheetRow(11, 'Chuquimamani-Condori', 'Edits', 'Prayer'),
      ],
      []
    );
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.flowsheet.cache_hits).toBe(0);
  });

  it('caches a both-passes-null verdict so repeat triples skip LML entirely', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 2 }], [flowsheetRow(9), flowsheetRow(11)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withoutUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2); // two passes for row 9 only
    expect(result.flowsheet.cache_hits).toBe(1);
    expect(result.flowsheet.still_null).toBe(2);
  });
});

describe('runBackfill — idempotency & never-overwrite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('a raced/already-filled row reports skipped_non_null and is never re-written', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('skipped_non_null');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(result.album_metadata.skipped_non_null).toBe(1);
    expect(result.album_metadata.resolved).toBe(0);
  });
});

describe('runBackfill — resumability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('albumAfterId and flowsheetAfterId narrow the respective SELECTs', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    await runBackfill({ ...baseOpts(lookup, apply), albumAfterId: 123, flowsheetAfterId: 456 });

    const albumBatchSql = renderSql((db.execute as jest.Mock).mock.calls[1]?.[0]);
    const flowsheetBatchSql = renderSql((db.execute as jest.Mock).mock.calls[3]?.[0]);
    expect(albumBatchSql).toMatch(/123/);
    expect(flowsheetBatchSql).toMatch(/456/);
  });

  it('maxRowsPerTable caps a phase but the next phase still runs', async () => {
    queueExecute([{ count: 3 }], [albumRow(10), albumRow(20), albumRow(30)], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill({ ...baseOpts(lookup, apply), maxRowsPerTable: 2 });

    expect(result.album_metadata.scanned).toBe(2);
    expect(result.album_metadata.last_id).toBe(20);
    expect(result.flowsheet.scanned).toBe(1);
  });
});

describe('runBackfill — error arms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('lml_error: lookup throws → no apply, counter increments, loop continues', async () => {
    queueExecute(
      [{ count: 2 }],
      [albumRow(5), albumRow(6, 'Sessa', 'Pequena Vertigem de Amor')],
      [],
      [{ count: 0 }],
      []
    );
    const lookup = jest.fn<LookupFn>().mockRejectedValueOnce(new Error('LML timeout')).mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(result.album_metadata.lml_error).toBe(1);
    expect(result.album_metadata.resolved).toBe(1);
    expect(result.album_metadata.scanned).toBe(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('lml_error on the second pass is counted too (first-pass null is not cached)', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValueOnce(withoutUrl).mockRejectedValueOnce(new Error('boom'));
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(result.album_metadata.lml_error).toBe(1);
    expect(result.album_metadata.still_null).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('db_error: apply throws → counter increments, loop continues', async () => {
    queueExecute([{ count: 2 }], [albumRow(5), albumRow(6)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(result.album_metadata.db_error).toBe(1);
    expect(result.album_metadata.resolved).toBe(1);
    expect(result.album_metadata.scanned).toBe(2);
  });

  it('loadBatch retry exhaustion marks the run failed (exit-code path) without throwing', async () => {
    const err = new Error('sustained outage');
    (db.execute as jest.Mock).mockReset();
    (db.execute as jest.Mock).mockResolvedValueOnce([{ count: 1 }] as never);
    (db.execute as jest.Mock).mockRejectedValue(err as never);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(result.failed).toBe(true);
    expect(result.album_metadata.scanned).toBe(0);
  }, 30_000);
});

describe('runBackfill — cooperative pause', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('defers when live activity is detected, continues when quiet', async () => {
    (mockCheckLiveActivity as jest.Mock).mockResolvedValueOnce(true as never).mockResolvedValue(false as never);
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill({
      ...baseOpts(lookup, apply),
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 0,
      checkLiveActivity: mockCheckLiveActivity,
    });

    expect((mockCheckLiveActivity as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.album_metadata.resolved).toBe(1);
  });

  it('skips the probe when liveActivityLookbackSeconds=0', async () => {
    emptyRun();
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withUrl);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    await runBackfill({ ...baseOpts(lookup, apply), checkLiveActivity: mockCheckLiveActivity });

    expect(mockCheckLiveActivity).not.toHaveBeenCalled();
  });
});

describe('runBackfill — cooperative stop (SIGTERM)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });
  afterEach(() => {
    __resetStopForTesting();
  });

  it('finishes the in-flight row then stops; result.stopped=true', async () => {
    queueExecute([{ count: 2 }], [albumRow(5), albumRow(6)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockImplementation(() => {
      requestStop();
      return Promise.resolve(withUrl);
    });
    const apply = jest.fn<ApplyFn>().mockResolvedValue('resolved');

    const result = await runBackfill(baseOpts(lookup, apply));

    expect(result.stopped).toBe(true);
    expect(result.album_metadata.scanned).toBe(1);
    expect(result.album_metadata.resolved).toBe(1);
  });
});
