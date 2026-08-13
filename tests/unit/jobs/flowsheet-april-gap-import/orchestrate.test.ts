/**
 * Unit tests for jobs/flowsheet-april-gap-import/orchestrate.ts.
 *
 * `runImport`'s control flow is exercised entirely through its injectable
 * seams (discoverCandidatesFn, countBackendLegacyEntryIdsFn, ...), mirroring
 * jobs/flowsheet-ghost-row-sweep/orchestrate.test.ts's approach of injecting
 * deleteBatch/analyzeTable/checkLiveActivity rather than driving the raw db
 * mock chain for control-flow tests. The individual DB-touching helpers
 * (findExistingLegacyEntryIds, resolveDjNamesForShows,
 * resolveAlbumIdsForReleases, insertBatch, countBackendLegacyEntryIds,
 * analyzeFlowsheet, metadataStatusDistribution) get their own focused tests
 * against the db.execute/returning mock.
 */
// fetch-legacy.ts instantiates MirrorSQL.instance() at module scope, and
// MirrorSQL isn't part of the shared @wxyc/database mock (fetch-legacy is
// the only consumer). Mock the module itself, mirroring
// tests/unit/jobs/flowsheet-etl/job.djName.test.ts's approach for the same
// import chain — orchestrate.ts's default parameters reference
// fetchLegacyEntriesInWindow, but every test below supplies its own
// discoverCandidatesFn/fetchFn seam, so the stub is never actually invoked.
jest.mock('../../../../jobs/flowsheet-etl/fetch-legacy', () => ({
  fetchLegacyEntriesInWindow: jest.fn(),
  closeLegacyConnection: jest.fn(),
}));

import { db, resolveShowDjName } from '@wxyc/database';
import type { LegacyEntryRow } from '../../../../jobs/flowsheet-etl/fetch-legacy';
import {
  resolveDryRun,
  resolveBatchSize,
  resolveBatchGapMs,
  resolveMinBackendIdCount,
  resolveMinCandidateCount,
  resolveMaxCohortSize,
  resolveMaxNullKeyRows,
  countNullKeyRowsForShows,
  shouldExitNonZero,
  discoverCandidates,
  buildShowBreakdown,
  findExistingLegacyEntryIds,
  resolveDjNamesForShows,
  resolveAlbumIdsForReleases,
  countBackendLegacyEntryIds,
  analyzeFlowsheet,
  metadataStatusDistribution,
  insertBatch,
  verificationQueryText,
  runImport,
  requestStop,
  __resetStopForTesting,
  BATCH_SIZE_DEFAULT,
  MIN_BACKEND_ID_COUNT_DEFAULT,
  MIN_CANDIDATE_COUNT_DEFAULT,
  MAX_COHORT_SIZE_DEFAULT,
  MAX_NULL_KEY_ROWS_DEFAULT,
  type RunResult,
} from '../../../../jobs/flowsheet-april-gap-import/orchestrate';
import type { GapImportRow } from '../../../../jobs/flowsheet-april-gap-import/build-row';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;

const makeEntry = (overrides: Partial<LegacyEntryRow> = {}): LegacyEntryRow => ({
  id: 2001,
  showId: 1001,
  entryTypeCode: 0,
  artistName: 'Jessica Pratt',
  albumTitle: 'On Your Own Love Again',
  trackTitle: 'Back, Baby',
  label: 'Drag City',
  requestFlag: 0,
  playOrder: 3,
  startTime: 0,
  timeCreated: 1776283200000, // 2026-04-16T04:00:00.000Z
  timeLastModified: 1776283260000,
  legacyReleaseId: 555,
  radioHour: null,
  segueFlag: 0,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetStopForTesting();
});

describe('resolveDryRun', () => {
  it('defaults to dry-run when no flags are passed', () => {
    expect(resolveDryRun([])).toBe(true);
  });

  it('honors --execute', () => {
    expect(resolveDryRun(['--execute'])).toBe(false);
  });

  it('honors explicit --dry-run', () => {
    expect(resolveDryRun(['--dry-run'])).toBe(true);
  });

  it('throws on contradictory flags', () => {
    expect(() => resolveDryRun(['--execute', '--dry-run'])).toThrow(/Contradictory flags/);
  });
});

describe('env resolvers', () => {
  it('resolveBatchSize defaults and honors override', () => {
    expect(resolveBatchSize(undefined)).toBe(BATCH_SIZE_DEFAULT);
    expect(resolveBatchSize('10')).toBe(10);
  });

  it('resolveBatchGapMs defaults and allows 0 to disable', () => {
    expect(resolveBatchGapMs('0')).toBe(0);
  });

  it('resolveMinBackendIdCount defaults and allows 0 override', () => {
    expect(resolveMinBackendIdCount(undefined)).toBe(MIN_BACKEND_ID_COUNT_DEFAULT);
    expect(resolveMinBackendIdCount('0')).toBe(0);
  });

  it('resolveMinCandidateCount defaults to 1 and allows 0 override', () => {
    expect(resolveMinCandidateCount(undefined)).toBe(MIN_CANDIDATE_COUNT_DEFAULT);
    expect(MIN_CANDIDATE_COUNT_DEFAULT).toBe(1);
    expect(resolveMinCandidateCount('0')).toBe(0);
    expect(resolveMinCandidateCount('50')).toBe(50);
  });

  it('resolveMaxNullKeyRows defaults to 0 (refuse on any orphan) and honors override', () => {
    expect(resolveMaxNullKeyRows(undefined)).toBe(MAX_NULL_KEY_ROWS_DEFAULT);
    expect(MAX_NULL_KEY_ROWS_DEFAULT).toBe(0);
    expect(resolveMaxNullKeyRows('5')).toBe(5);
  });

  it('resolveMaxCohortSize defaults and honors override', () => {
    expect(resolveMaxCohortSize(undefined)).toBe(MAX_COHORT_SIZE_DEFAULT);
    expect(resolveMaxCohortSize('50')).toBe(50);
  });
});

describe('discoverCandidates', () => {
  const window = { startMs: 1000, endMs: 2000 };

  it('keeps a row whose resolved timestamp falls inside the window', async () => {
    const entry = makeEntry({ startTime: 0, timeCreated: 1500, timeLastModified: 0 });
    const fetchFn = jest.fn().mockResolvedValue([entry]);

    const result = await discoverCandidates(window, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(1000, 2000);
    expect(result).toEqual([entry]);
  });

  it('drops a row the wide SQL net over-admitted (resolved timestamp outside the window)', async () => {
    // START_TIME is non-zero and OUTSIDE the window, but TIME_LAST_MODIFIED
    // (which the wide net also matches on) happens to fall inside it. The
    // true resolved timestamp is START_TIME (resolveEntryTimestamp prefers
    // it), so this row must be excluded.
    const entry = makeEntry({ startTime: 500, timeCreated: 0, timeLastModified: 1500 });
    const fetchFn = jest.fn().mockResolvedValue([entry]);

    const result = await discoverCandidates(window, fetchFn);

    expect(result).toEqual([]);
  });

  it('drops a row with no resolvable timestamp at all', async () => {
    const entry = makeEntry({ startTime: 0, timeCreated: 0, timeLastModified: 0 });
    const fetchFn = jest.fn().mockResolvedValue([entry]);

    const result = await discoverCandidates(window, fetchFn);

    expect(result).toEqual([]);
  });

  it('drops a row exactly at the exclusive end boundary', async () => {
    const entry = makeEntry({ startTime: 0, timeCreated: 2000, timeLastModified: 0 });
    const fetchFn = jest.fn().mockResolvedValue([entry]);

    const result = await discoverCandidates(window, fetchFn);

    expect(result).toEqual([]);
  });
});

describe('buildShowBreakdown', () => {
  it('groups missing rows by legacy_show_id and resolves the Backend id', () => {
    const missing = [
      makeEntry({ id: 1, showId: 1001 }),
      makeEntry({ id: 2, showId: 1001 }),
      makeEntry({ id: 3, showId: 1002 }),
    ];
    const showIdMap = new Map([[1001, 10]]); // 1002 deliberately unmapped

    const breakdown = buildShowBreakdown(missing, showIdMap);

    expect(breakdown).toEqual([
      { legacyShowId: 1001, backendShowId: 10, missing: 2, nullKeyRows: null },
      { legacyShowId: 1002, backendShowId: null, missing: 1, nullKeyRows: null },
    ]);
  });

  it('returns an empty breakdown for an empty missing set', () => {
    expect(buildShowBreakdown([], new Map())).toEqual([]);
  });

  it('attaches per-show null-key counts when the probe ran', () => {
    const missing = [makeEntry({ id: 1, showId: 1001 }), makeEntry({ id: 3, showId: 1002 })];
    const showIdMap = new Map([
      [1001, 10],
      [1002, 11],
    ]);

    // Zero-filling is countNullKeyRowsForShows's job, not this function's —
    // a probed show with no orphans arrives here as an explicit 0, so an
    // absent key can keep meaning "not probed".
    const breakdown = buildShowBreakdown(
      missing,
      showIdMap,
      new Map([
        [10, 4],
        [11, 0],
      ])
    );

    expect(breakdown).toEqual([
      { legacyShowId: 1001, backendShowId: 10, missing: 1, nullKeyRows: 4 },
      { legacyShowId: 1002, backendShowId: 11, missing: 1, nullKeyRows: 0 },
    ]);
  });

  it('leaves nullKeyRows null for an unmapped show even when the probe ran', () => {
    const breakdown = buildShowBreakdown([makeEntry({ id: 1, showId: 1002 })], new Map(), new Map([[10, 4]]));

    expect(breakdown).toEqual([{ legacyShowId: 1002, backendShowId: null, missing: 1, nullKeyRows: null }]);
  });
});

/**
 * Finding 1 of the BS#2119 review. The cohort diff keys on
 * `legacy_entry_id`, and `ON CONFLICT (legacy_entry_id) DO NOTHING` cannot
 * dedup against a NULL key — so a dj-site-originated row whose back-stamp was
 * skipped (the orphan class `jobs/legacy-mirror-reconcile` Sweep 2 heals) is
 * invisible to the diff AND unprotected by the conflict target. The README's
 * "these shows hold only lifecycle markers" was a prior measurement; this
 * turns it into a run-time check.
 */
describe('countNullKeyRowsForShows', () => {
  it('returns an empty map without querying for an empty id list', async () => {
    const result = await countNullKeyRowsForShows([]);
    expect(result.size).toBe(0);
    expect(chain.execute).not.toHaveBeenCalled();
  });

  it('maps show_id -> count and zero-fills a probed show with no orphans', async () => {
    chain.execute.mockResolvedValueOnce([{ show_id: 10, null_key_rows: 4 }]);

    const result = await countNullKeyRowsForShows([10, 11]);

    expect(result.get(10)).toBe(4);
    expect(result.get(11)).toBe(0);
  });

  it('excludes lifecycle markers — those are expected on an all-legacy show', async () => {
    chain.execute.mockResolvedValueOnce([]);
    await countNullKeyRowsForShows([10]);

    const query = chain.execute.mock.calls[0][0] as { queryChunks?: unknown[] };
    const text = JSON.stringify(query.queryChunks ?? query);
    expect(text).toContain('show_start');
    expect(text).toContain('show_end');
    expect(text).toContain('dj_join');
    expect(text).toContain('dj_leave');
    expect(text).toContain('legacy_entry_id');
  });
});

describe('verificationQueryText', () => {
  it('embeds the id list into a re-runnable psql query', () => {
    const text = verificationQueryText([2001, 2002]);
    expect(text).toContain('wxyc_schema.flowsheet');
    expect(text).toContain('ARRAY[2001,2002]');
    expect(text).toMatch(/GROUP BY metadata_status/);
  });

  it('is stable (no trailing punctuation drift) for an empty id list', () => {
    expect(verificationQueryText([])).toContain('ARRAY[]');
  });
});

// ---- DB-touching helpers (real implementations, against the db.execute/returning mock) ----

describe('findExistingLegacyEntryIds', () => {
  it('returns an empty set without querying for an empty id list', async () => {
    const result = await findExistingLegacyEntryIds([]);
    expect(result.size).toBe(0);
    expect(chain.execute).not.toHaveBeenCalled();
  });

  it('queries via ANY(...) and returns the existing ids as a Set', async () => {
    chain.execute.mockResolvedValueOnce([{ legacy_entry_id: 2001 }, { legacy_entry_id: 2002 }]);

    const result = await findExistingLegacyEntryIds([2001, 2002, 2003]);

    expect(result).toEqual(new Set([2001, 2002]));
    expect(chain.execute).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDjNamesForShows', () => {
  it('returns an empty map without querying for an empty id list', async () => {
    const result = await resolveDjNamesForShows([]);
    expect(result.size).toBe(0);
    expect(chain.execute).not.toHaveBeenCalled();
  });

  it('prefers the linked user handle over legacy_dj_name (the PII-safe chain)', async () => {
    chain.execute.mockResolvedValueOnce([
      {
        show_id: 10,
        dj_name_override: null,
        primary_dj_id: 'user-10',
        auth_dj_name: 'DJ Aubrey Hearst',
        legacy_dj_name: 'stale handle',
      },
      { show_id: 11, dj_name_override: null, primary_dj_id: null, auth_dj_name: null, legacy_dj_name: 'DJ Bluejay' },
      { show_id: 12, dj_name_override: null, primary_dj_id: null, auth_dj_name: null, legacy_dj_name: null },
    ]);

    const result = await resolveDjNamesForShows([10, 11, 12]);

    expect(result.get(10)).toBe('DJ Aubrey Hearst');
    expect(result.get(11)).toBe('DJ Bluejay');
    expect(result.get(12)).toBeNull();
  });

  /**
   * The two links the pre-#2119-review COALESCE copy was missing. Both are
   * asserted against the canonical `resolveShowDjName` rather than a restated
   * expectation, so this test cannot drift from the chain it is pinning.
   */
  it('lets a per-show dj_name_override win over the user handle (BS#1321)', async () => {
    chain.execute.mockResolvedValueOnce([
      {
        show_id: 20,
        dj_name_override: 'The Wednesday Slot',
        primary_dj_id: 'user-20',
        auth_dj_name: 'DJ Nilüfer',
        legacy_dj_name: 'legacy handle',
      },
    ]);

    const result = await resolveDjNamesForShows([20]);

    expect(result.get(20)).toBe('The Wednesday Slot');
  });

  it('filters the literal "Anonymous" handle and falls through to legacy (BS#1286)', async () => {
    chain.execute.mockResolvedValueOnce([
      {
        show_id: 30,
        dj_name_override: null,
        primary_dj_id: 'user-30',
        auth_dj_name: '  Anonymous ',
        legacy_dj_name: 'DJ Csillagrablók',
      },
      {
        show_id: 31,
        dj_name_override: null,
        primary_dj_id: 'user-31',
        auth_dj_name: 'anonymous',
        legacy_dj_name: null,
      },
    ]);

    const result = await resolveDjNamesForShows([30, 31]);

    expect(result.get(30)).toBe('DJ Csillagrablók');
    expect(result.get(31)).toBeNull();
  });

  it('agrees with resolveShowDjName on every row it maps', async () => {
    const rows = [
      {
        show_id: 40,
        dj_name_override: '  ',
        primary_dj_id: 'user-40',
        auth_dj_name: 'DJ Hermanos',
        legacy_dj_name: 'legacy',
      },
      { show_id: 41, dj_name_override: 'Override', primary_dj_id: null, auth_dj_name: null, legacy_dj_name: 'legacy' },
      { show_id: 42, dj_name_override: null, primary_dj_id: 'user-42', auth_dj_name: '', legacy_dj_name: '  padded  ' },
    ];
    chain.execute.mockResolvedValueOnce(rows);

    const result = await resolveDjNamesForShows([40, 41, 42]);

    for (const row of rows) {
      expect(result.get(row.show_id)).toBe(
        resolveShowDjName({
          dj_name_override: row.dj_name_override,
          legacy_dj_name: row.legacy_dj_name,
          primary_dj_id: row.primary_dj_id,
          user: row.primary_dj_id == null ? null : { djName: row.auth_dj_name },
        })
      );
    }
  });

  it('selects the override and primary_dj_id columns the chain needs', async () => {
    chain.execute.mockResolvedValueOnce([]);
    await resolveDjNamesForShows([50]);

    const query = chain.execute.mock.calls[0][0] as { queryChunks?: unknown[] };
    const text = JSON.stringify(query.queryChunks ?? query);
    expect(text).toContain('dj_name_override');
    expect(text).toContain('primary_dj_id');
  });
});

describe('resolveAlbumIdsForReleases', () => {
  it('returns an empty map without querying for an empty id list', async () => {
    const result = await resolveAlbumIdsForReleases([]);
    expect(result.size).toBe(0);
    expect(chain.execute).not.toHaveBeenCalled();
  });

  it('maps legacy_release_id -> library.id', async () => {
    chain.execute.mockResolvedValueOnce([{ id: 500, legacy_release_id: 555 }]);

    const result = await resolveAlbumIdsForReleases([555]);

    expect(result.get(555)).toBe(500);
  });
});

describe('countBackendLegacyEntryIds', () => {
  it('unwraps the COUNT(*) result', async () => {
    chain.execute.mockResolvedValueOnce([{ count: 2634891 }]);

    const result = await countBackendLegacyEntryIds();

    expect(result).toBe(2634891);
  });
});

describe('analyzeFlowsheet', () => {
  it('issues an ANALYZE statement', async () => {
    chain.execute.mockResolvedValueOnce(undefined);
    await expect(analyzeFlowsheet()).resolves.toBeUndefined();
    expect(chain.execute).toHaveBeenCalledTimes(1);
  });
});

describe('metadataStatusDistribution', () => {
  it('returns an empty object without querying for an empty id list', async () => {
    const result = await metadataStatusDistribution([]);
    expect(result).toEqual({});
    expect(chain.execute).not.toHaveBeenCalled();
  });

  it('builds a status -> count map', async () => {
    chain.execute.mockResolvedValueOnce([
      { metadata_status: 'pending', count: 3 },
      { metadata_status: 'enriched_match', count: 1 },
    ]);

    const result = await metadataStatusDistribution([2001, 2002, 2003, 2004]);

    expect(result).toEqual({ pending: 3, enriched_match: 1 });
  });
});

describe('insertBatch', () => {
  const row: GapImportRow = {
    legacy_entry_id: 2001,
    legacy_release_id: 555,
    show_id: 10,
    entry_type: 'track',
    artist_name: 'Jessica Pratt',
    album_title: 'On Your Own Love Again',
    track_title: 'Back, Baby',
    record_label: 'Drag City',
    message: null,
    request_flag: false,
    segue: false,
    play_order: 3,
    add_time: new Date('2026-04-16T05:00:00.000Z'),
    radio_hour: null,
    dj_name: 'DJ Aubrey Hearst',
    album_id: 500,
  };

  it('returns an empty array without an INSERT for an empty batch', async () => {
    const result = await insertBatch([]);
    expect(result).toEqual([]);
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it('inserts and returns the RETURNING legacy_entry_id list — under ON CONFLICT DO NOTHING the attempted set is not the inserted set', async () => {
    // Only one of the two attempted rows actually landed (the other hit an
    // existing legacy_entry_id and was silently skipped by DO NOTHING).
    chain.returning.mockResolvedValueOnce([{ legacyEntryId: 2001 }]);

    const result = await insertBatch([row, { ...row, legacy_entry_id: 2002 }]);

    expect(result).toEqual([2001]);
    expect(chain.insert).toHaveBeenCalledWith(expect.anything());
    expect(chain.onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({ target: expect.anything() }));
  });
});

/**
 * The exit-code predicate lives here rather than in job.ts because job.ts
 * calls `void main()` at module scope — importing it to test would run the
 * job. Same reason the flowsheet-etl mappers were extracted in the first
 * place.
 */
describe('shouldExitNonZero', () => {
  const base: RunResult = {
    dryRun: true,
    window: { startMs: 0, endMs: 1 },
    candidateCount: 0,
    missingCount: 0,
    excludedUnmappedShowCount: 0,
    insertedCount: 0,
    insertedIds: [],
    perShowBreakdown: [],
    metadataStatusSnapshot: {},
    refused: false,
    refusalReason: null,
    stopped: false,
    failed: false,
  };

  it('is false for a clean run', () => {
    expect(shouldExitNonZero(base)).toBe(false);
  });

  it.each([['failed'], ['refused'], ['stopped']] as const)('is true when %s', (flag) => {
    expect(shouldExitNonZero({ ...base, [flag]: true })).toBe(true);
  });

  /**
   * `stopped` is the one a wrapping script is most likely to get wrong: a
   * SIGTERM'd run inserted SOME of its cohort and left the rest, which is
   * exactly the state that must not read as success.
   */
  it('is true for a partially-completed stopped run that inserted rows', () => {
    expect(shouldExitNonZero({ ...base, stopped: true, insertedCount: 120, insertedIds: [1, 2, 3] })).toBe(true);
  });
});

// ---- runImport control flow (injected seams) ----

describe('runImport', () => {
  const window = { startMs: 1000, endMs: 2000 };
  const baseSeams = () => ({
    window,
    liveActivityLookbackSeconds: 0, // disable the cooperative pause by default; dedicated tests below re-enable it
    discoverCandidatesFn: jest.fn().mockResolvedValue([]),
    countBackendLegacyEntryIdsFn: jest.fn().mockResolvedValue(MIN_BACKEND_ID_COUNT_DEFAULT),
    findExistingLegacyEntryIdsFn: jest.fn().mockResolvedValue(new Set<number>()),
    buildShowIdMapFn: jest.fn().mockResolvedValue(new Map<number, number>()),
    resolveDjNamesForShowsFn: jest.fn().mockResolvedValue(new Map<number, string | null>()),
    resolveAlbumIdsForReleasesFn: jest.fn().mockResolvedValue(new Map<number, number>()),
    // Mirrors the real probe's zero-fill: every id asked about comes back
    // with an explicit count, so `nullKeyRows: 0` (not null) is what a clean
    // run's breakdown carries.
    countNullKeyRowsForShowsFn: jest
      .fn<(ids: number[]) => Promise<Map<number, number>>>()
      .mockImplementation((ids) => Promise.resolve(new Map(ids.map((id) => [id, 0])))),
    insertBatchFn: jest.fn().mockResolvedValue([]),
    analyzeFlowsheetFn: jest.fn().mockResolvedValue(undefined),
    metadataStatusDistributionFn: jest.fn().mockResolvedValue({}),
  });

  /**
   * Zero candidates is never a legitimate outcome: discovery reads tubafrenzy,
   * whose rows do not depend on Backend state, so a re-run of a completed
   * import still finds the same cohort (it just finds it already present).
   * Nothing upstream means the window is wrong or the fetch failed — a
   * typo'd year would otherwise print "finished" and exit 0.
   */
  it('refuses when discovery returns nothing — an empty window is a bad window, not a no-op', async () => {
    const seams = baseSeams();
    const result = await runImport({ dryRun: true, ...seams });

    expect(result.candidateCount).toBe(0);
    expect(result.refused).toBe(true);
    expect(result.refusalReason).toMatch(/GAP_IMPORT_MIN_CANDIDATE_COUNT/);
    expect(result.failed).toBe(false);
    expect(seams.countBackendLegacyEntryIdsFn).not.toHaveBeenCalled();
  });

  it('allows a deliberate empty-window run when the candidate floor is set to 0', async () => {
    const seams = baseSeams();
    const result = await runImport({ dryRun: true, ...seams, minCandidateCount: 0 });

    expect(result.candidateCount).toBe(0);
    expect(result.refused).toBe(false);
    expect(result.failed).toBe(false);
    expect(seams.countBackendLegacyEntryIdsFn).not.toHaveBeenCalled();
  });

  it('refuses when the Backend-side id count is below the floor', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry()]);
    seams.countBackendLegacyEntryIdsFn.mockResolvedValue(100); // way under the floor

    const result = await runImport({ dryRun: true, ...seams, minBackendIdCount: 2_500_000 });

    expect(result.refused).toBe(true);
    expect(result.refusalReason).toMatch(/below the floor/);
    expect(seams.findExistingLegacyEntryIdsFn).not.toHaveBeenCalled();
    // Refusal still goes through the common summary/log footer, not an early bare return.
    expect(result.failed).toBe(false);
  });

  it('refuses when the missing-row cohort exceeds the ceiling', async () => {
    const seams = baseSeams();
    const candidates = [makeEntry({ id: 1 }), makeEntry({ id: 2 }), makeEntry({ id: 3 })];
    seams.discoverCandidatesFn.mockResolvedValue(candidates);
    seams.findExistingLegacyEntryIdsFn.mockResolvedValue(new Set<number>()); // none exist -> all 3 missing

    const result = await runImport({ dryRun: true, ...seams, maxCohortSize: 2 });

    expect(result.refused).toBe(true);
    expect(result.refusalReason).toMatch(/exceeds GAP_IMPORT_MAX_COHORT_SIZE/);
    expect(result.missingCount).toBe(3);
    // Diagnostic breakdown is still populated on a ceiling refusal, without a
    // Backend id lookup — so the null-key probe hasn't run either.
    expect(result.perShowBreakdown).toEqual([
      { legacyShowId: 1001, backendShowId: null, missing: 3, nullKeyRows: null },
    ]);
    expect(seams.countNullKeyRowsForShowsFn).not.toHaveBeenCalled();
    expect(seams.buildShowIdMapFn).not.toHaveBeenCalled();
  });

  it('refuses when a target show already holds non-marker rows with a NULL legacy_entry_id', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry({ id: 2001, showId: 1001 })]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.countNullKeyRowsForShowsFn.mockResolvedValue(new Map([[10, 3]]));

    const result = await runImport({ dryRun: false, ...seams });

    expect(result.refused).toBe(true);
    expect(result.refusalReason).toMatch(/GAP_IMPORT_MAX_NULL_KEY_ROWS/);
    expect(result.insertedCount).toBe(0);
    expect(seams.insertBatchFn).not.toHaveBeenCalled();
    // The operator needs to know WHICH show, so the breakdown carries it.
    expect(result.perShowBreakdown).toEqual([{ legacyShowId: 1001, backendShowId: 10, missing: 1, nullKeyRows: 3 }]);
  });

  it('refuses on the NULL-key guard in dry-run too — the report must not claim a safe import', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry({ id: 2001, showId: 1001 })]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.countNullKeyRowsForShowsFn.mockResolvedValue(new Map([[10, 1]]));

    const result = await runImport({ dryRun: true, ...seams });

    expect(result.refused).toBe(true);
  });

  it('proceeds when the probed shows hold no orphan rows', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry({ id: 2001, showId: 1001 })]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.countNullKeyRowsForShowsFn.mockResolvedValue(new Map([[10, 0]]));
    seams.insertBatchFn.mockResolvedValue([2001]);

    const result = await runImport({ dryRun: false, ...seams });

    expect(result.refused).toBe(false);
    expect(result.insertedCount).toBe(1);
    expect(seams.countNullKeyRowsForShowsFn).toHaveBeenCalledWith([10]);
  });

  it('honors a raised GAP_IMPORT_MAX_NULL_KEY_ROWS ceiling', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry({ id: 2001, showId: 1001 })]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.countNullKeyRowsForShowsFn.mockResolvedValue(new Map([[10, 2]]));
    seams.insertBatchFn.mockResolvedValue([2001]);

    const result = await runImport({ dryRun: false, ...seams, maxNullKeyRows: 5 });

    expect(result.refused).toBe(false);
    expect(result.insertedCount).toBe(1);
  });

  it('probes only the shows it is about to write to, not every unmapped one', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([
      makeEntry({ id: 2001, showId: 1001 }),
      makeEntry({ id: 2002, showId: 1002 }), // unmapped -> excluded, never written to
    ]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.insertBatchFn.mockResolvedValue([2001]);

    await runImport({ dryRun: false, ...seams });

    expect(seams.countNullKeyRowsForShowsFn).toHaveBeenCalledWith([10]);
  });

  it('is a clean no-op when every candidate is already present in Backend', async () => {
    const seams = baseSeams();
    const entry = makeEntry();
    seams.discoverCandidatesFn.mockResolvedValue([entry]);
    seams.findExistingLegacyEntryIdsFn.mockResolvedValue(new Set([entry.id]));

    const result = await runImport({ dryRun: true, ...seams });

    expect(result.missingCount).toBe(0);
    expect(seams.buildShowIdMapFn).not.toHaveBeenCalled();
  });

  it('dry-run computes the full report but calls no insert/analyze', async () => {
    const seams = baseSeams();
    const entry = makeEntry();
    seams.discoverCandidatesFn.mockResolvedValue([entry]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[entry.showId, 10]]));
    seams.resolveDjNamesForShowsFn.mockResolvedValue(new Map([[10, 'DJ Aubrey Hearst']]));
    seams.resolveAlbumIdsForReleasesFn.mockResolvedValue(new Map([[entry.legacyReleaseId ?? -1, 500]]));

    const result = await runImport({ dryRun: true, ...seams });

    expect(result.insertedCount).toBe(0);
    expect(seams.insertBatchFn).not.toHaveBeenCalled();
    expect(seams.analyzeFlowsheetFn).not.toHaveBeenCalled();
    expect(result.perShowBreakdown).toEqual([{ legacyShowId: 1001, backendShowId: 10, missing: 1, nullKeyRows: 0 }]);
  });

  it('excludes a row whose legacy_show_id has no Backend mapping, rather than inserting a null show_id', async () => {
    const seams = baseSeams();
    const entry = makeEntry();
    seams.discoverCandidatesFn.mockResolvedValue([entry]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map()); // showId 1001 unmapped

    const result = await runImport({ dryRun: false, ...seams });

    expect(result.excludedUnmappedShowCount).toBe(1);
    expect(seams.insertBatchFn).not.toHaveBeenCalled();
    expect(result.insertedCount).toBe(0);
  });

  it('--execute batches inserts, runs ANALYZE once, and reports the metadata_status snapshot', async () => {
    const seams = baseSeams();
    const entries = [makeEntry({ id: 1 }), makeEntry({ id: 2 }), makeEntry({ id: 3 })];
    seams.discoverCandidatesFn.mockResolvedValue(entries);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.insertBatchFn.mockImplementation((rows: GapImportRow[]) =>
      Promise.resolve(rows.map((r) => r.legacy_entry_id))
    );
    seams.metadataStatusDistributionFn.mockResolvedValue({ pending: 3 });

    const result = await runImport({ dryRun: false, ...seams, batchSize: 2, batchGapMs: 0 });

    // 3 rows at batch size 2 -> two batches.
    expect(seams.insertBatchFn).toHaveBeenCalledTimes(2);
    expect(seams.insertBatchFn.mock.calls[0][0]).toHaveLength(2);
    expect(seams.insertBatchFn.mock.calls[1][0]).toHaveLength(1);
    expect(result.insertedCount).toBe(3);
    expect(result.insertedIds.sort()).toEqual([1, 2, 3]);
    expect(seams.analyzeFlowsheetFn).toHaveBeenCalledTimes(1);
    expect(seams.metadataStatusDistributionFn).toHaveBeenCalledWith([1, 2, 3]);
    expect(result.metadataStatusSnapshot).toEqual({ pending: 3 });
  });

  it('reflects a partial ON CONFLICT DO NOTHING outcome — attempted set is not the inserted set', async () => {
    const seams = baseSeams();
    const entries = [makeEntry({ id: 1 }), makeEntry({ id: 2 })];
    seams.discoverCandidatesFn.mockResolvedValue(entries);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    // Only id 1 actually lands; id 2 conflicted concurrently.
    seams.insertBatchFn.mockResolvedValue([1]);

    const result = await runImport({ dryRun: false, ...seams, batchSize: 25, batchGapMs: 0 });

    expect(result.insertedCount).toBe(1);
    expect(result.insertedIds).toEqual([1]);
  });

  it('does not fail the run when ANALYZE throws — the insert already landed', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry()]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.insertBatchFn.mockResolvedValue([2001]);
    seams.analyzeFlowsheetFn.mockRejectedValue(new Error('ANALYZE timed out'));

    const result = await runImport({ dryRun: false, ...seams, batchGapMs: 0 });

    expect(result.failed).toBe(false);
    expect(result.insertedCount).toBe(1);
  });

  it('marks the run failed when discovery throws', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockRejectedValue(new Error('MirrorSQL connection refused'));

    const result = await runImport({ dryRun: true, ...seams });

    expect(result.failed).toBe(true);
    expect(result.refused).toBe(false);
  });

  it('stops cleanly on a pre-set stop request without inserting', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry()]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));

    requestStop();
    const result = await runImport({ dryRun: false, ...seams, batchGapMs: 0 });

    expect(result.stopped).toBe(true);
    expect(seams.insertBatchFn).not.toHaveBeenCalled();
  });

  it('waits out live-DJ activity before inserting (cooperative pause)', async () => {
    const seams = baseSeams();
    seams.discoverCandidatesFn.mockResolvedValue([makeEntry()]);
    seams.buildShowIdMapFn.mockResolvedValue(new Map([[1001, 10]]));
    seams.insertBatchFn.mockResolvedValue([2001]);
    const checkLiveActivity = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await runImport({
      dryRun: false,
      ...seams,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 1,
      checkLiveActivity,
      batchGapMs: 0,
    });

    expect(checkLiveActivity).toHaveBeenCalledTimes(2);
    expect(result.insertedCount).toBe(1);
  });
});
