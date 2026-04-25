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
  djName: 'DJ Bluejay',
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
  ...overrides,
});

// Import after mocks are set up
import { runIncremental } from '../../../../jobs/flowsheet-etl/job';

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
});
