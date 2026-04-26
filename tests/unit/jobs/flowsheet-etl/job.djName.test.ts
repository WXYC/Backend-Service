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
import * as fs from 'fs';
import * as path from 'path';

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

describe('runIncremental: dj_name on insert (step 5b.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLastRunTimestamp as jest.Mock).mockResolvedValue(null);

    chain.then
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([{ id: 10, legacyId: 1001 }]))
      .mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]));
  });

  it('runs the dj_name UPDATE scoped to just-imported legacy_entry_ids', async () => {
    // After the 2026-04 wedge incident, the ETL no longer rewrites every
    // NULL-dj_name row on every cron tick. It only updates the rows it just
    // inserted; legacy rows are handled once by the backfill job.
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry({ id: 2001 })]);

    await runIncremental();

    const djNameUpdate = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*dj_name[\s\S]*COALESCE/i);
    expect(djNameUpdate).toBeDefined();
    const sql = renderSql(djNameUpdate?.[0]);
    // Must scope by the just-imported legacy_entry_ids (passed in via the IN/ANY clause),
    // not rewrite every NULL-dj_name row in the table.
    expect(sql).toMatch(/legacy_entry_id/);
    expect(sql).toMatch(/=\s*ANY/i);
  });

  it('does not run the dj_name UPDATE when no rows were newly inserted', async () => {
    // When fetchLegacyEntries returns rows that are all already in the DB
    // (i.e., updates only), there is nothing to populate dj_name on.
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

  it('does not run an unbounded UPDATE (dj_name IS NULL) without a row-id scope', async () => {
    // Regression guard for the wedge: the original resolveDjNames had no
    // row-id scope and rewrote every NULL-dj_name row in flowsheet on each
    // call. Ensure no execute call matches that shape.
    mockFetchLegacyShows.mockResolvedValue([makeShow()]);
    mockFetchLegacyEntries.mockResolvedValue([makeEntry()]);

    await runIncremental();

    const calls = (db.execute as jest.Mock).mock.calls;
    for (const call of calls) {
      const sql = renderSql(call[0]);
      if (/UPDATE[\s\S]*flowsheet[\s\S]*dj_name/i.test(sql)) {
        // Must have an explicit row-id scope; the legacy `dj_name IS NULL`
        // alone is not sufficient because it touches every legacy row.
        expect(sql).toMatch(/=\s*ANY|IN\s*\(/i);
      }
    }
  });
});

describe('runBulkLoad: dj_name backfill ownership', () => {
  // Source-grep assertions on the bulk-load path. We verify by reading the
  // source rather than executing runBulkLoad because mocking the fs module
  // (to feed it a fake dump) is flaky across Jest worker boundaries — the
  // mock leaks into other test files when Jest reuses a worker. The source
  // check is deterministic and locks the design intent equally well: the
  // bulk-load path does not own dj_name backfill (the dedicated backfill
  // job at jobs/backfills/flowsheet-dj-name-backfill does).
  const jobSourcePath = path.resolve(__dirname, '../../../../jobs/flowsheet-etl/job.ts');
  const jobSource = fs.readFileSync(jobSourcePath, 'utf-8');

  /** Extract the body of a top-level `const NAME = async (...): RetType => { ... };`. */
  const extractFunctionBody = (name: string): string => {
    // Allow an optional return type annotation between the parameter list
    // and the arrow (e.g. `async (): Promise<SyncResult> => {`). The
    // non-greedy `.*?` matches up through `=> {` on the same logical line.
    const startMatch = jobSource.match(
      new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*async\\s*\\([^)]*\\)[^={]*=>\\s*\\{`)
    );
    if (!startMatch || startMatch.index === undefined) {
      throw new Error(`Could not locate function ${name} in job.ts`);
    }
    let depth = 1;
    let i = startMatch.index + startMatch[0].length;
    while (i < jobSource.length && depth > 0) {
      const ch = jobSource[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    return jobSource.slice(startMatch.index, i);
  };

  it('runBulkLoad does not call resolveDjNames (backfill job owns that pass)', () => {
    // The bulk-load path imports millions of legacy rows. Calling
    // resolveDjNames there would re-create the wedge from issue #511 because
    // every row is NULL-dj_name immediately after import — the unbounded
    // post-pass UPDATE would block reads and orphan database backends.
    // Backfill is the dedicated job's responsibility.
    const body = extractFunctionBody('runBulkLoad');
    expect(body).not.toMatch(/\bresolveDjNames\s*\(/);
  });

  it('runIncremental still calls resolveDjNames with a row-id list', () => {
    // Counterpart assertion: incremental sync DOES populate dj_name on the
    // rows it just inserted (a small batch per cron tick). Verifies the
    // call site exists and passes an argument (so it remains scoped, not
    // unbounded).
    const body = extractFunctionBody('runIncremental');
    expect(body).toMatch(/\bresolveDjNames\s*\(\s*[A-Za-z_]/);
  });
});
