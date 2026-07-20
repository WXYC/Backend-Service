/**
 * Unit tests for streaming-url-remediation orchestrate.ts (BS#1715).
 *
 * Pins the behaviors the durable data fix depends on:
 *
 *   1. Candidate net — a row is a candidate iff a non-null spotify_url is NOT
 *      Spotify-hosted OR a non-null apple_music_url is NOT Apple-hosted
 *      (`NOT ILIKE '%spotify.com%'` / `%apple.com%`, case-insensitive). The
 *      phase-start COUNT, the batch SELECT, and the verification re-count all
 *      share the same net (asserted via renderSql on the composed query).
 *   2. applyBatch — one VALUES-join UPDATE per page, `::int`/`::varchar` casts,
 *      album_metadata bumps `updated_at = NOW()` while flowsheet does NOT (its
 *      `bump_flowsheet_updated_at` trigger owns the stamp), WHERE joins on the
 *      per-target PK.
 *   3. Two-phase flow: album_metadata drains fully before flowsheet; per-row
 *      cleared/recovered tallies distinguish a relocation from an unrecoverable
 *      clear.
 *   4. Dry-run (the default mode wired by job.ts) performs the same paged scan
 *      and ZERO writes — applyBatch/analyzeTable never fire.
 *   5. Resumability: REMEDIATION_*_AFTER_ID cursors narrow the SELECT; the
 *      per-phase last_id resume cursor rides out on the run result.
 *   6. Post-run verification re-counts the net (execute + full-scope only) and
 *      fails the run when a residual remains.
 *   7. Cooperative pause and SIGTERM stop mirror the sibling backfills.
 *
 * applyBatch / analyzeTable are injected into runRemediation so the orchestration
 * assertions don't route writes through the db mock; the real implementations
 * keep their own direct SQL-shape tests below.
 */
import { jest } from '@jest/globals';

import { db, checkLiveActivity as mockCheckLiveActivity } from '@wxyc/database';
import {
  BATCH_SIZE,
  SAMPLE_SIZE_DEFAULT,
  UPDATE_TIMEOUT_MS_DEFAULT,
  ANALYZE_TIMEOUT_MS_DEFAULT,
  analyzeTable,
  applyBatch,
  requestStop,
  resolveAfterId,
  resolveAnalyzeTimeoutMs,
  resolveBatchSize,
  resolveDryRun,
  resolveMaxRowsPerTable,
  resolveSampleSize,
  resolveUpdateTimeoutMs,
  runRemediation,
  __resetStopForTesting,
  type ApplyBatchFn,
  type AnalyzeFn,
  type FixedRow,
  type RemediationTarget,
} from '../../../../jobs/streaming-url-remediation/orchestrate';

type SqlLike = { sql?: string | string[]; values?: unknown[]; raw?: string; join?: unknown[]; sep?: unknown };
/**
 * Render the tests/__mocks__/drizzle-orm.ts sql-tag shape ({ sql: strings,
 * values }) to a flat string, recursing into nested fragments, sql.raw
 * identifiers, and sql.join fragment lists so predicate / cast / cursor
 * assertions can see the composed query.
 */
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.join)) {
    const sep = renderSql(obj.sep);
    return obj.join.map(renderSql).join(sep);
  }
  if (Array.isArray(obj.sql)) {
    const values = obj.values ?? [];
    return obj.sql.map((chunk, i) => chunk + (i < values.length ? renderSql(values[i]) : '')).join('');
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};

const APPLE_URL = 'https://music.apple.com/us/album/on-your-own-love-again/1234';
const DEEZER_URL = 'https://www.deezer.com/album/999';

/** An Apple link mis-filed in the spotify slot → transform relocates it to apple. */
const appleInSpotifyRow = (id: number) => ({ id, spotify_url: APPLE_URL, apple_music_url: null });
/** A Deezer link in the spotify slot with no recoverable value → transform clears it. */
const deezerRow = (id: number) => ({ id, spotify_url: DEEZER_URL, apple_music_url: null });

/**
 * Queue db.execute results in call order. A single-page phase is:
 * phase count, page rows, empty page. Verification (execute + full scope) adds
 * a trailing re-count per target.
 */
const queueExecute = (...results: unknown[]): void => {
  const mock = db.execute as jest.Mock;
  for (const result of results) {
    mock.mockResolvedValueOnce(result as never);
  }
};

/** Injected no-op write path: reports every fix as written. */
const passThroughApply: ApplyBatchFn = jest.fn((_t, fixes) => Promise.resolve(fixes.length));
const noopAnalyze: AnalyzeFn = jest.fn(async () => {});

const baseOpts = (overrides: Partial<Parameters<typeof runRemediation>[0]> = {}) => ({
  dryRun: false,
  batchSize: 100,
  liveActivityLookbackSeconds: 0,
  applyBatch: passThroughApply,
  analyzeTable: noopAnalyze,
  ...overrides,
});

const executeCall = (index: number): string => renderSql((db.execute as jest.Mock).mock.calls[index]?.[0]);
const findExecuteCall = (pattern: RegExp): string =>
  (db.execute as jest.Mock).mock.calls.map((c) => renderSql(c?.[0])).find((s) => pattern.test(s)) ?? '';

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
    expect(() => resolveBatchSize('0')).toThrow(/REMEDIATION_BATCH_SIZE/);
  });

  it('resolveMaxRowsPerTable defaults to 0 (unlimited) and accepts positive caps', () => {
    expect(resolveMaxRowsPerTable(undefined)).toBe(0);
    expect(resolveMaxRowsPerTable('250')).toBe(250);
    expect(() => resolveMaxRowsPerTable('-1')).toThrow(/REMEDIATION_MAX_ROWS_PER_TABLE/);
  });

  it('resolveUpdateTimeoutMs falls back to the default and rejects non-positive', () => {
    expect(resolveUpdateTimeoutMs(undefined)).toBe(UPDATE_TIMEOUT_MS_DEFAULT);
    expect(resolveUpdateTimeoutMs('60000')).toBe(60000);
    expect(() => resolveUpdateTimeoutMs('0')).toThrow(/REMEDIATION_UPDATE_TIMEOUT_MS/);
  });

  it('resolveAnalyzeTimeoutMs falls back to the default and rejects non-positive', () => {
    expect(resolveAnalyzeTimeoutMs(undefined)).toBe(ANALYZE_TIMEOUT_MS_DEFAULT);
    expect(resolveAnalyzeTimeoutMs('45000')).toBe(45000);
    expect(() => resolveAnalyzeTimeoutMs('-5')).toThrow(/REMEDIATION_ANALYZE_TIMEOUT_MS/);
  });

  it('resolveSampleSize defaults to SAMPLE_SIZE_DEFAULT and accepts 0', () => {
    expect(resolveSampleSize(undefined)).toBe(SAMPLE_SIZE_DEFAULT);
    expect(resolveSampleSize('0')).toBe(0);
    expect(resolveSampleSize('5')).toBe(5);
  });

  it('resolveAfterId defaults to 0 and rejects negatives', () => {
    expect(resolveAfterId('REMEDIATION_ALBUM_AFTER_ID', undefined)).toBe(0);
    expect(resolveAfterId('REMEDIATION_ALBUM_AFTER_ID', '150')).toBe(150);
    expect(() => resolveAfterId('REMEDIATION_ALBUM_AFTER_ID', '-1')).toThrow(/REMEDIATION_ALBUM_AFTER_ID/);
  });
});

describe('applyBatch — VALUES-join UPDATE shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  const fixes: FixedRow[] = [
    { id: 5, spotify_url: null, apple_music_url: APPLE_URL },
    { id: 7, spotify_url: null, apple_music_url: null },
  ];

  it('album_metadata: VALUES-join with casts, bumps updated_at, joins on album_id', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 2 } as never);
    const written = await applyBatch('album_metadata', fixes, 300_000);

    expect(written).toBe(2);
    const updateSql = findExecuteCall(/UPDATE/);
    expect(updateSql).toMatch(/album_metadata/);
    expect(updateSql).toMatch(/SET "spotify_url" = v\."spotify_url"/);
    expect(updateSql).toMatch(/"apple_music_url" = v\."apple_music_url"/);
    expect(updateSql).toMatch(/"updated_at" = NOW\(\)/);
    expect(updateSql).toMatch(/FROM \(VALUES/);
    expect(updateSql).toMatch(/::int/);
    expect(updateSql).toMatch(/::varchar/);
    expect(updateSql).toMatch(/WHERE t\."album_id" = v\."id"/);
  });

  it('flowsheet: same shape but does NOT set updated_at, joins on id', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 2 } as never);
    await applyBatch('flowsheet', fixes, 300_000);

    const updateSql = findExecuteCall(/UPDATE/);
    expect(updateSql).toMatch(/flowsheet/);
    expect(updateSql).not.toMatch(/"updated_at" = NOW\(\)/);
    expect(updateSql).toMatch(/WHERE t\."id" = v\."id"/);
  });

  it('raises the statement_timeout to the passed literal inside the transaction', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 2 } as never);
    await applyBatch('flowsheet', fixes, 123_456);

    const setLocalSql = findExecuteCall(/SET LOCAL statement_timeout/);
    expect(setLocalSql).toMatch(/statement_timeout = 123456/);
    expect(db.transaction as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op that touches no rows for an empty fix list', async () => {
    const written = await applyBatch('flowsheet', [], 300_000);
    expect(written).toBe(0);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('analyzeTable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('runs ANALYZE on the target table in a raised-timeout transaction', async () => {
    await analyzeTable('flowsheet', 300_000);
    expect(db.transaction as jest.Mock).toHaveBeenCalledTimes(1);
    const analyzeSql = findExecuteCall(/ANALYZE/);
    expect(analyzeSql).toMatch(/ANALYZE/);
    expect(analyzeSql).toMatch(/flowsheet/);
    expect(findExecuteCall(/SET LOCAL statement_timeout/)).toMatch(/statement_timeout = 300000/);
  });
});

describe('runRemediation — candidate net', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('album_metadata SELECT: NOT ILIKE both hosts, id cursor, ORDER BY, no LIKE-search shape', async () => {
    queueExecute([{ count: 1 }], [appleInSpotifyRow(5)], [], [{ count: 0 }], []);

    await runRemediation(baseOpts());

    const batchSql = executeCall(1);
    expect(batchSql).toMatch(/album_metadata/);
    expect(batchSql).toMatch(/"spotify_url" NOT ILIKE/);
    expect(batchSql).toMatch(/%spotify\.com%/);
    expect(batchSql).toMatch(/"apple_music_url" NOT ILIKE/);
    expect(batchSql).toMatch(/%apple\.com%/);
    expect(batchSql).toMatch(/ORDER BY/);
    expect(batchSql).not.toMatch(/LIKE '?%?open\.spotify\.com\/search/);
  });

  it('flowsheet SELECT reads the id PK and the same net', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 1 }], [appleInSpotifyRow(9)], []);

    await runRemediation(baseOpts());

    const batchSql = executeCall(3);
    expect(batchSql).toMatch(/flowsheet/);
    expect(batchSql).toMatch(/"spotify_url" NOT ILIKE/);
    expect(batchSql).toMatch(/"apple_music_url" NOT ILIKE/);
    expect(batchSql).toMatch(/f\."id"/);
  });

  it('count queries share the net and populate per-phase candidate totals', async () => {
    queueExecute([{ count: 7 }], [], [{ count: 3 }], []);

    const result = await runRemediation(baseOpts());

    const countSql = executeCall(0);
    expect(countSql).toMatch(/COUNT/i);
    expect(countSql).toMatch(/NOT ILIKE/);
    expect(result.album_metadata.candidates).toBe(7);
    expect(result.flowsheet.candidates).toBe(3);
  });
});

describe('runRemediation — two-phase flow and tallies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('processes album_metadata fully before flowsheet', async () => {
    const apply = jest.fn<ApplyBatchFn>((_t, fixes) => Promise.resolve(fixes.length));
    queueExecute([{ count: 1 }], [appleInSpotifyRow(5)], [], [{ count: 1 }], [appleInSpotifyRow(9)], []);

    await runRemediation(baseOpts({ applyBatch: apply }));

    expect(apply.mock.calls[0]?.[0]).toBe('album_metadata');
    expect(apply.mock.calls[apply.mock.calls.length - 1]?.[0]).toBe('flowsheet');
  });

  it('a relocation tallies spotify_cleared + apple_recovered; the fixes carry the healed columns', async () => {
    const apply = jest.fn<ApplyBatchFn>((_t, fixes) => Promise.resolve(fixes.length));
    queueExecute([{ count: 1 }], [appleInSpotifyRow(5)], [], [{ count: 0 }], []);

    const result = await runRemediation(baseOpts({ applyBatch: apply }));

    expect(result.album_metadata.changed).toBe(1);
    expect(result.album_metadata.written).toBe(1);
    expect(result.album_metadata.spotify_cleared).toBe(1);
    expect(result.album_metadata.apple_recovered).toBe(1);
    expect(apply.mock.calls[0]?.[1]).toEqual([{ id: 5, spotify_url: null, apple_music_url: APPLE_URL }]);
  });

  it('an unrecoverable foreign host tallies spotify_cleared only and nulls both columns', async () => {
    const apply = jest.fn<ApplyBatchFn>((_t, fixes) => Promise.resolve(fixes.length));
    queueExecute([{ count: 1 }], [deezerRow(5)], [], [{ count: 0 }], []);

    const result = await runRemediation(baseOpts({ applyBatch: apply }));

    expect(result.album_metadata.spotify_cleared).toBe(1);
    expect(result.album_metadata.apple_recovered).toBe(0);
    expect(apply.mock.calls[0]?.[1]).toEqual([{ id: 5, spotify_url: null, apple_music_url: null }]);
  });

  it('ANALYZE runs once per table that actually wrote', async () => {
    const analyze = jest.fn<AnalyzeFn>(async () => {});
    queueExecute([{ count: 1 }], [appleInSpotifyRow(5)], [], [{ count: 1 }], [appleInSpotifyRow(9)], []);

    await runRemediation(baseOpts({ analyzeTable: analyze }));

    const targets = analyze.mock.calls.map((c) => c[0]);
    expect(targets).toEqual<RemediationTarget[]>(['album_metadata', 'flowsheet']);
  });

  it('ID cursor advances across batches and the loop terminates on an empty batch', async () => {
    queueExecute(
      [{ count: 3 }],
      [appleInSpotifyRow(10), appleInSpotifyRow(20)],
      [appleInSpotifyRow(30)],
      [],
      [{ count: 0 }],
      []
    );

    const result = await runRemediation(baseOpts({ batchSize: 2 }));

    const secondBatchSql = executeCall(2);
    expect(secondBatchSql).toMatch(/20/);
    expect(result.album_metadata.scanned).toBe(3);
    expect(result.album_metadata.last_id).toBe(30);
  });
});

describe('runRemediation — dry-run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('performs the paged scan but ZERO writes and no ANALYZE', async () => {
    const apply = jest.fn<ApplyBatchFn>((_t, fixes) => Promise.resolve(fixes.length));
    const analyze = jest.fn<AnalyzeFn>(async () => {});
    queueExecute([{ count: 1 }], [appleInSpotifyRow(5)], [], [{ count: 1 }], [appleInSpotifyRow(9)], []);

    const result = await runRemediation(baseOpts({ dryRun: true, applyBatch: apply, analyzeTable: analyze }));

    expect(apply).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.album_metadata.changed).toBe(1);
    expect(result.album_metadata.written).toBe(0);
    expect(result.flowsheet.changed).toBe(1);
  });

  it('does not run the post-run verification in dry-run (remaining stays -1)', async () => {
    queueExecute([{ count: 1 }], [appleInSpotifyRow(5)], [], [{ count: 1 }], [appleInSpotifyRow(9)], []);

    const result = await runRemediation(baseOpts({ dryRun: true }));

    expect(result.album_metadata.remaining).toBe(-1);
    expect(result.flowsheet.remaining).toBe(-1);
    // Exactly 6 executes: 2 counts + 2 pages + 2 empty terminators. No re-count.
    expect((db.execute as jest.Mock).mock.calls.length).toBe(6);
  });
});

describe('runRemediation — resumability and caps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('albumAfterId and flowsheetAfterId narrow the respective SELECTs', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 0 }], []);

    await runRemediation(baseOpts({ albumAfterId: 123, flowsheetAfterId: 456 }));

    expect(executeCall(0)).toMatch(/123/); // album count
    expect(executeCall(2)).toMatch(/456/); // flowsheet count
  });

  it('an unstarted phase logs the operator cursor back out as last_id', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 0 }], []);

    const result = await runRemediation(baseOpts({ albumAfterId: 123, flowsheetAfterId: 456 }));

    expect(result.album_metadata.last_id).toBe(123);
    expect(result.flowsheet.last_id).toBe(456);
  });

  it('maxRowsPerTable caps a phase at a batch boundary but the next phase still runs', async () => {
    queueExecute([{ count: 3 }], [appleInSpotifyRow(10), appleInSpotifyRow(20)], [{ count: 0 }], []);

    const result = await runRemediation(baseOpts({ batchSize: 2, maxRowsPerTable: 2 }));

    expect(result.album_metadata.scanned).toBe(2);
    expect(result.album_metadata.last_id).toBe(20);
    // Capped run skips post-run verification.
    expect(result.album_metadata.remaining).toBe(-1);
  });
});

describe('runRemediation — post-run verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('re-counts the net after a full execute run and passes when zero remains', async () => {
    queueExecute(
      [{ count: 1 }],
      [appleInSpotifyRow(5)],
      [],
      [{ count: 0 }],
      [],
      [{ count: 0 }], // album re-count
      [{ count: 0 }] // flowsheet re-count
    );

    const result = await runRemediation(baseOpts());

    expect(result.failed).toBe(false);
    expect(result.album_metadata.remaining).toBe(0);
    expect(result.flowsheet.remaining).toBe(0);
  });

  it('fails the run when a residual candidate remains after remediation', async () => {
    queueExecute(
      [{ count: 1 }],
      [appleInSpotifyRow(5)],
      [],
      [{ count: 0 }],
      [],
      [{ count: 4 }], // album re-count: 4 stragglers
      [{ count: 0 }]
    );

    const result = await runRemediation(baseOpts());

    expect(result.failed).toBe(true);
    expect(result.album_metadata.remaining).toBe(4);
  });
});

describe('runRemediation — write failure does not advance the cursor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('a thrown applyBatch flags failed and leaves last_id at the pre-page cursor', async () => {
    const apply = jest.fn<ApplyBatchFn>(() => Promise.reject(new Error('connection reset')));
    // Exactly two execute calls happen before applyBatch throws (count + one
    // page load); the phase breaks on failure, so do NOT queue an empty-page
    // load — an unconsumed mockResolvedValueOnce bleeds into the next test
    // (clearMocks/clearAllMocks do not drain the Once queue).
    queueExecute([{ count: 1 }], [appleInSpotifyRow(50)]);

    const result = await runRemediation(baseOpts({ albumAfterId: 10, applyBatch: apply }));

    expect(result.failed).toBe(true);
    expect(result.album_metadata.written).toBe(0);
    // Cursor stays at the operator's start (10), NOT the failed page's max (50).
    expect(result.album_metadata.last_id).toBe(10);
  });
});

describe('runRemediation — cooperative pause', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('defers when live activity is detected, continues when quiet', async () => {
    (mockCheckLiveActivity as jest.Mock).mockResolvedValueOnce(true as never).mockResolvedValue(false as never);
    queueExecute([{ count: 1 }], [appleInSpotifyRow(5)], [], [{ count: 0 }], []);

    const result = await runRemediation(
      baseOpts({
        liveActivityLookbackSeconds: 60,
        liveActivityPauseMs: 0,
        checkLiveActivity: mockCheckLiveActivity,
      })
    );

    expect((mockCheckLiveActivity as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.album_metadata.written).toBe(1);
  });

  it('skips the probe when liveActivityLookbackSeconds=0', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 0 }], []);

    await runRemediation(baseOpts({ checkLiveActivity: mockCheckLiveActivity }));

    expect(mockCheckLiveActivity).not.toHaveBeenCalled();
  });
});

describe('runRemediation — cooperative stop (SIGTERM)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });
  afterEach(() => {
    __resetStopForTesting();
  });

  it('finishes the in-flight page then stops; result.stopped=true, flowsheet skipped', async () => {
    const apply = jest.fn<ApplyBatchFn>((_t, fixes) => {
      requestStop();
      return Promise.resolve(fixes.length);
    });
    queueExecute([{ count: 2 }], [appleInSpotifyRow(5)]);

    const result = await runRemediation(baseOpts({ applyBatch: apply }));

    expect(result.stopped).toBe(true);
    expect(result.album_metadata.scanned).toBe(1);
    expect(result.album_metadata.written).toBe(1);
    // flowsheet phase never ran (no count query issued for it).
    expect(result.flowsheet.candidates).toBe(0);
  });
});
