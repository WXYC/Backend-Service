/**
 * Unit tests for flowsheet ETL incremental sync orchestration.
 *
 * Validates that runIncremental correctly resolves timestamps, inserts
 * entries, and distinguishes new imports from updates. The core regression
 * test ensures track entries with START_TIME=0 are imported via the
 * TIME_CREATED fallback (not silently skipped).
 */

const mockFetchLegacyShows = jest.fn();
const mockFetchLegacyEntries = jest.fn();

jest.mock('../../../../jobs/flowsheet-etl/fetch-legacy', () => ({
  fetchLegacyShows: mockFetchLegacyShows,
  fetchLegacyEntries: mockFetchLegacyEntries,
  closeLegacyConnection: jest.fn(),
}));

import { db, getLastRunTimestamp, updateLastRun, flowsheet, shows } from '@wxyc/database';
import type { LegacyShowRow, LegacyEntryRow } from '../../../../jobs/flowsheet-etl/fetch-legacy';

// Access the shared mock chain so we can configure sequential query results.
// Add a .then() method so the chain is thenable — runIncremental awaits query
// chains directly (e.g. `await db.select().from(shows)`) without a terminal.
const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;
chain.then = jest.fn().mockReturnValue(chain);

// Make onConflictDoUpdate resolve (it's the terminal for upserts)
chain.onConflictDoUpdate.mockResolvedValue(undefined);

/** Helper: build a LegacyShowRow with defaults */
const makeShow = (overrides: Partial<LegacyShowRow> = {}): LegacyShowRow => ({
  id: 1001,
  startTime: 1706799600000, // 2024-02-01T13:00:00Z
  endTime: 1706803200000,
  showName: 'The Nest',
  timeLastModified: 1706799700000,
  djHandle: 'DJ Bluejay',
  djId: 42,
  ...overrides,
});

/** Helper: build a LegacyEntryRow with defaults */
const makeEntry = (overrides: Partial<LegacyEntryRow> = {}): LegacyEntryRow => ({
  id: 2001,
  showId: 1001,
  entryTypeCode: 0, // track
  artistName: 'Autechre',
  albumTitle: 'Confield',
  trackTitle: 'VI Scose Poise',
  label: 'Warp',
  requestFlag: 0,
  playOrder: 1,
  startTime: 1706799650000,
  timeCreated: 1706799650000,
  timeLastModified: 1706799700000,
  legacyReleaseId: 101,
  segueFlag: 0,
  radioHour: null,
  ...overrides,
});

// Import after mocks are set up
import { runIncremental, importEntries } from '../../../../jobs/flowsheet-etl/job';

describe('runIncremental', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: no previous run (full sync)
    (getLastRunTimestamp as jest.Mock).mockResolvedValue(null);

    // Default: show map query returns one show mapping
    // Then: existing entry IDs query returns empty (all entries are new)
    chain.then
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([{ id: 10, legacyId: 1001 }]))
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]));
  });

  it('imports track entry when START_TIME is 0 but TIME_CREATED is valid', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry({ startTime: 0, timeCreated: 1706799650000 })]);

    const result = await runIncremental();

    expect(result.entriesImported).toBe(1);

    // Verify db.insert was called with the flowsheet table and correct values
    const insertCalls = chain.values.mock.calls;
    const flowsheetInsert = insertCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).legacy_entry_id === 2001
    );
    expect(flowsheetInsert).toBeDefined();

    const values = flowsheetInsert![0] as Record<string, unknown>;
    expect(values.entry_type).toBe('track');
    expect(values.artist_name).toBe('Autechre');
    // The key assertion: add_time should come from TIME_CREATED (the fallback),
    // not be null/skipped because START_TIME was 0
    expect(values.add_time).toEqual(new Date(1706799650000));
  });

  it('writes radio_hour from RADIO_HOUR for a breakpoint entry', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry({ id: 3003, entryTypeCode: 8, radioHour: 1718726400000 })]);

    await runIncremental();

    const flowsheetInsert = chain.values.mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).legacy_entry_id === 3003
    );
    expect(flowsheetInsert).toBeDefined();
    const values = flowsheetInsert![0] as Record<string, unknown>;
    expect(values.entry_type).toBe('breakpoint');
    expect(values.radio_hour).toEqual(new Date(1718726400000));
  });

  it('writes radio_hour: null for a track entry even when RADIO_HOUR is present', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry({ id: 3004, entryTypeCode: 0, radioHour: 1718726400000 })]);

    await runIncremental();

    const flowsheetInsert = chain.values.mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).legacy_entry_id === 3004
    );
    expect(flowsheetInsert).toBeDefined();
    const values = flowsheetInsert![0] as Record<string, unknown>;
    expect(values.entry_type).toBe('track');
    expect(values.radio_hour).toBeNull();
  });

  it('skips entry when all three timestamps are 0', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry({ startTime: 0, timeCreated: 0, timeLastModified: 0 })]);

    const result = await runIncremental();

    expect(result.entriesImported).toBe(0);
    expect(result.entriesUpdated).toBe(0);
  });

  it('clamps overlapping show end_times after importing shows', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([]);

    await runIncremental();

    // db.execute is called for the overlap clamping query when shows are imported
    const executeCalls = (db.execute as jest.Mock).mock.calls;
    expect(executeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('skips overlap clamping when no shows are imported', async () => {
    mockFetchLegacyShows.mockResolvedValue([]);
    mockFetchLegacyEntries.mockResolvedValue([]);

    // Reset chain.then for the show map + existing IDs queries
    chain.then
      .mockReset()
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]))
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]));

    await runIncremental();

    // db.execute should NOT be called for overlap clamping
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });

  it('distinguishes inserts from updates in return counts', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([
      makeEntry({ id: 2001 }), // new entry
      makeEntry({ id: 2002, trackTitle: 'Pen Expers', playOrder: 2 }), // existing entry
    ]);

    // Show map query, then existing IDs query returns one match
    chain.then
      .mockReset()
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([{ id: 10, legacyId: 1001 }]))
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([{ lid: 2002 }]));

    const result = await runIncremental();

    expect(result.entriesImported).toBe(1);
    expect(result.entriesUpdated).toBe(1);
  });

  it('persists verbatim ARTIST_NAME for show_start markers (regression #1287)', async () => {
    const marker = 'START OF SHOW: DJ Aubrey Hearst SIGNED ON at 7:43 PM (6/2/26)';
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([
      makeEntry({ id: 2003, entryTypeCode: 9, artistName: marker }), // 9 = START_OF_SHOW
    ]);

    await runIncremental();

    const insertCalls = chain.values.mock.calls;
    const showStartInsert = insertCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).legacy_entry_id === 2003
    );
    expect(showStartInsert).toBeDefined();
    const values = showStartInsert![0] as Record<string, unknown>;
    expect(values.entry_type).toBe('show_start');
    expect(values.artist_name).toBe(marker);
    expect(values.message).toBeNull();
  });

  it('persists verbatim ARTIST_NAME for show_end markers (regression #1287)', async () => {
    const marker = 'END OF SHOW: Aubrey Hearst SIGNED OFF at 7:43 PM (6/2/26)';
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([
      makeEntry({ id: 2004, entryTypeCode: 10, artistName: marker }), // 10 = END_OF_SHOW
    ]);

    await runIncremental();

    const insertCalls = chain.values.mock.calls;
    const showEndInsert = insertCalls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).legacy_entry_id === 2004
    );
    expect(showEndInsert).toBeDefined();
    const values = showEndInsert![0] as Record<string, unknown>;
    expect(values.entry_type).toBe('show_end');
    expect(values.artist_name).toBe(marker);
    expect(values.message).toBeNull();
  });

  // Shape check only — column coverage and PG semantics are pinned in
  // tests/integration/flowsheet-etl-setwhere.spec.js.
  it('passes setWhere on every onConflictDoUpdate call to skip no-op UPDATEs', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry()]);

    await runIncremental();

    const calls = chain.onConflictDoUpdate.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [arg] of calls) {
      expect(arg.setWhere).toBeTruthy();
    }
  });
});

/**
 * Regression guard for the bulk-load path's dump-column → flowsheet mapping (#1462).
 *
 * importEntries reads each field from a hard-coded FLOWSHEET_ENTRY_PROD dump-tuple
 * index (the column map documented above importEntries in job.ts). The incremental
 * path is covered above; the bulk path had no test. A future reorder of that column
 * map (tubafrenzy adds/removes a column) would silently populate every bulk-loaded
 * row from the wrong column on a full reload, with nothing failing — the exact
 * corruption #1449 fixed for radio_hour, at full-reload blast radius.
 *
 * radio_hour (tuple[9]) is the #1462 motivator, but the identical positional risk
 * applies to its neighbors, so this pins the cluster: LABEL_NAME@8, RADIO_HOUR@9,
 * START_TIME@10, RADIO_SHOW_ID@12, SEQUENCE_WITHIN_SHOW@13, ENTRY_TYPE_CODE@15,
 * plus ARTIST_NAME@1 / SONG_TITLE@3 / RELEASE_TITLE@4. The fixture is deliberately
 * discriminating — each asserted column carries a distinct, typed value (e.g.
 * RADIO_HOUR@9 ≠ START_TIME@10, START_TIME@10 ≠ its add_time fallbacks
 * TIME_LAST_MODIFIED@16 / TIME_CREATED@17, and LABEL_NAME@8 is a string) — so an
 * off-by-one drift fails an assertion rather than passing silently.
 */
describe('importEntries — bulk-load dump-column mapping (#1462)', () => {
  const RADIO_HOUR_MS = 1718726400000; // 16:00:00Z — RADIO_HOUR@9 (top of hour)
  const START_TIME_MS = 1718726460000; // 16:01:00Z — START_TIME@10 (what add_time resolves to)
  // add_time = resolveEntryTimestamp(START_TIME@10 ?? TIME_CREATED@17 ?? TIME_LAST_MODIFIED@16).
  // Give the two fallbacks values distinct from START_TIME so the add_time assertion
  // actually pins index 10 — if all three were equal a drift 10→16/17 would pass silently.
  const TIME_LAST_MODIFIED_MS = 1718726490000; // 16:01:30Z — TIME_LAST_MODIFIED@16
  const TIME_CREATED_MS = 1718726430000; // 16:00:30Z — TIME_CREATED@17

  // One INSERT, three FLOWSHEET_ENTRY_PROD tuples (21 cols, 0..20 per the dump
  // column map): a breakpoint with a real RADIO_HOUR, a track that carries a
  // RADIO_HOUR but must drop it, and a breakpoint whose RADIO_HOUR is 0.
  const dumpLine =
    'INSERT INTO `FLOWSHEET_ENTRY_PROD` VALUES ' +
    `(2006,'Top of the hour 4 PM',NULL,NULL,NULL,NULL,NULL,NULL,'Drag City',${RADIO_HOUR_MS},${START_TIME_MS},NULL,1001,5,0,8,${TIME_LAST_MODIFIED_MS},${TIME_CREATED_MS},0,9999,NULL),` +
    `(2007,'Jessica Pratt',NULL,'Back, Baby','On Your Own Love Again',NULL,NULL,NULL,'Drag City',${RADIO_HOUR_MS},${START_TIME_MS},NULL,1001,6,0,0,${TIME_LAST_MODIFIED_MS},${TIME_CREATED_MS},0,10000,NULL),` +
    `(2009,'Top of the hour 5 PM',NULL,NULL,NULL,NULL,NULL,NULL,'Drag City',0,${START_TIME_MS},NULL,1001,7,0,8,${TIME_LAST_MODIFIED_MS},${TIME_CREATED_MS},0,10001,NULL);`;

  const showIdMap = new Map<number, number>([[1001, 10]]);

  let pushed: Record<string, unknown>[];
  // Throws (failing the test with a clear message) rather than returning
  // undefined, so call sites read the row's fields without a non-null assertion.
  const byId = (id: number): Record<string, unknown> => {
    const row = pushed.find((r) => r.legacy_entry_id === id);
    if (!row) throw new Error(`no bulk-loaded row with legacy_entry_id=${id}`);
    return row;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Bulk insert terminal: importEntries awaits .onConflictDoNothing() directly,
    // so it must resolve (the chain's default .then would otherwise hang the await).
    chain.onConflictDoNothing.mockResolvedValue(undefined);

    await importEntries(db, [dumpLine], showIdMap);

    // Rows are batched into .values([...]); flatMap is robust to any batch count.
    pushed = chain.values.mock.calls.flatMap((call: unknown[]) => call[0] as Record<string, unknown>[]);
  });

  it('maps a breakpoint row from the right dump columns', () => {
    const row = byId(2006);
    expect(row.entry_type).toBe('breakpoint'); // ENTRY_TYPE_CODE@15 = 8
    // The #1462 mapping: RADIO_HOUR@9. add_time below pins START_TIME@10 to a
    // distinct value, and record_label pins LABEL_NAME@8 to a string, so a drift
    // off index 9 to either neighbor fails one of these rather than passing.
    expect(row.radio_hour).toEqual(new Date(RADIO_HOUR_MS)); // RADIO_HOUR@9
    expect(row.add_time).toEqual(new Date(START_TIME_MS)); // START_TIME@10 (≠ TIME_*@16/@17, so it pins index 10)
    expect(row.record_label).toBe('Drag City'); // LABEL_NAME@8
    expect(row.show_id).toBe(10); // RADIO_SHOW_ID@12 = 1001, mapped via showIdMap
    expect(row.play_order).toBe(5); // SEQUENCE_WITHIN_SHOW@13
    expect(row.message).toBe('Top of the hour 4 PM'); // ARTIST_NAME@1 (message text for breakpoints)
    expect(row.artist_name).toBeNull();
  });

  it('maps a track row and drops RADIO_HOUR to null', () => {
    const row = byId(2007);
    expect(row.entry_type).toBe('track'); // ENTRY_TYPE_CODE@15 = 0
    expect(row.radio_hour).toBeNull(); // RADIO_HOUR present, but only breakpoints carry it
    expect(row.artist_name).toBe('Jessica Pratt'); // ARTIST_NAME@1
    expect(row.track_title).toBe('Back, Baby'); // SONG_TITLE@3 (comma inside the quoted value)
    expect(row.album_title).toBe('On Your Own Love Again'); // RELEASE_TITLE@4
  });

  it('maps a breakpoint with RADIO_HOUR=0 to null', () => {
    const row = byId(2009);
    expect(row.entry_type).toBe('breakpoint');
    expect(row.radio_hour).toBeNull(); // RADIO_HOUR@9 = 0 → epochMsToDate(0) = null
  });
});
