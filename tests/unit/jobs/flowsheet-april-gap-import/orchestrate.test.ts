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

import { db } from '@wxyc/database';
import type { LegacyEntryRow } from '../../../../jobs/flowsheet-etl/fetch-legacy';
import {
  resolveDryRun,
  resolveBatchSize,
  resolveBatchGapMs,
  resolveMinBackendIdCount,
  resolveMaxCohortSize,
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
  MAX_COHORT_SIZE_DEFAULT,
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
      { legacyShowId: 1001, backendShowId: 10, missing: 2 },
      { legacyShowId: 1002, backendShowId: null, missing: 1 },
    ]);
  });

  it('returns an empty breakdown for an empty missing set', () => {
    expect(buildShowBreakdown([], new Map())).toEqual([]);
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

  it('prefers auth_dj_name over legacy_dj_name (the PII-safe COALESCE chain)', async () => {
    chain.execute.mockResolvedValueOnce([
      { show_id: 10, auth_dj_name: 'DJ Aubrey Hearst', legacy_dj_name: 'stale handle' },
      { show_id: 11, auth_dj_name: null, legacy_dj_name: 'DJ Bluejay' },
      { show_id: 12, auth_dj_name: null, legacy_dj_name: null },
    ]);

    const result = await resolveDjNamesForShows([10, 11, 12]);

    expect(result.get(10)).toBe('DJ Aubrey Hearst');
    expect(result.get(11)).toBe('DJ Bluejay');
    expect(result.get(12)).toBeNull();
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
    insertBatchFn: jest.fn().mockResolvedValue([]),
    analyzeFlowsheetFn: jest.fn().mockResolvedValue(undefined),
    metadataStatusDistributionFn: jest.fn().mockResolvedValue({}),
  });

  it('is a clean no-op when there are no candidates in the window', async () => {
    const seams = baseSeams();
    const result = await runImport({ dryRun: true, ...seams });

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
    // Diagnostic breakdown is still populated on a ceiling refusal, without a Backend id lookup.
    expect(result.perShowBreakdown).toEqual([{ legacyShowId: 1001, backendShowId: null, missing: 3 }]);
    expect(seams.buildShowIdMapFn).not.toHaveBeenCalled();
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
    expect(result.perShowBreakdown).toEqual([{ legacyShowId: 1001, backendShowId: 10, missing: 1 }]);
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
