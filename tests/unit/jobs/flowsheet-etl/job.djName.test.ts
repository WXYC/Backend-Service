/**
 * ETL: dj_name denormalization on insert (step 5b.2).
 *
 * The flowsheet ETL imports rows from the legacy tubafrenzy database. After
 * inserting/upserting rows, it must populate flowsheet.dj_name so the search
 * service no longer needs to join shows -> auth_user. The simplest source of
 * truth is the same SQL the migration uses, run as a post-import UPDATE.
 */
const mockFetchLegacyShows = jest.fn();
const mockFetchLegacyEntries = jest.fn();

jest.mock('../../../../jobs/flowsheet-etl/fetch-legacy', () => ({
  fetchLegacyShows: mockFetchLegacyShows,
  fetchLegacyEntries: mockFetchLegacyEntries,
  closeLegacyConnection: jest.fn(),
}));

import { db, getLastRunTimestamp } from '@wxyc/database';
import type { LegacyShowRow, LegacyEntryRow } from '../../../../jobs/flowsheet-etl/fetch-legacy';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;
chain.then = jest.fn().mockReturnValue(chain);
chain.onConflictDoUpdate.mockResolvedValue(undefined);

const makeShow = (overrides: Partial<LegacyShowRow> = {}): LegacyShowRow => ({
  id: 1001,
  startTime: 1706799600000,
  endTime: 1706803200000,
  showName: 'The Nest',
  timeLastModified: 1706799700000,
  djName: 'DJ Bluejay',
  djId: 42,
  ...overrides,
});

const makeEntry = (overrides: Partial<LegacyEntryRow> = {}): LegacyEntryRow => ({
  id: 2001,
  showId: 1001,
  entryTypeCode: 0,
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

import { runIncremental } from '../../../../jobs/flowsheet-etl/job';

/**
 * Render a drizzle `sql` template object to a string for substring assertions.
 * Drizzle's SQL serializes via toJSON() to `{ sql: string[], values: unknown[] }`,
 * with the literal fragments split across the `sql` array.
 */
type SqlLike = { sql?: string | string[]; queryChunks?: Array<string | { value?: string | string[] }> };
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

describe('runIncremental: dj_name backfill (step 5b.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLastRunTimestamp as jest.Mock).mockResolvedValue(null);

    chain.then
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([{ id: 10, legacyId: 1001 }]))
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]));
  });

  it('runs the dj_name backfill UPDATE after importing new entries', async () => {
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry()]);

    await runIncremental();

    const djNameUpdate = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*dj_name[\s\S]*COALESCE/i);
    expect(djNameUpdate).toBeDefined();
  });

  it('skips the dj_name backfill UPDATE when no entries are imported', async () => {
    mockFetchLegacyShows.mockResolvedValue([]);
    mockFetchLegacyEntries.mockResolvedValue([]);

    chain.then
      .mockReset()
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]))
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]));

    await runIncremental();

    const djNameUpdate = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*dj_name[\s\S]*COALESCE/i);
    expect(djNameUpdate).toBeUndefined();
  });
});
