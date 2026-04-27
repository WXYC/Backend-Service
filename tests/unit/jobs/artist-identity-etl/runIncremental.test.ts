/**
 * Orchestration tests for artist-identity-etl runIncremental.
 *
 * These exercise the per-run loop body in isolation:
 *   - bookkeeping (matched / conflicts / columnsWritten / fillCandidates)
 *   - the fillCandidates filter that mirrors the previous "if toFill is
 *     empty, continue" semantics
 *   - empty-input early return
 *   - last-run timestamp update on every successful path
 *
 * The COALESCE-in-SET correctness guarantee — that duplicate-name rows
 * each retain their existing non-null values across the bulk UPDATE — is
 * a SQL-level invariant. Postgres's COALESCE semantics are well defined
 * and the wire-format of the UPDATE is hand-validated in PR #513's
 * review-amend (945ae18). Real-DB validation of that invariant would
 * need a different test scaffold than the mocked-DB unit setup; tracked
 * separately if the hand-validation ever proves insufficient.
 */

import { jest } from '@jest/globals';

// ---- Mocks (must be declared before runIncremental is imported) ----

// drizzle-orm's compiled exports don't expose `sql.join` cleanly under
// ts-jest's transform. The bulk-UPDATE path in runIncremental builds a
// VALUES fragment via `sql.join(...)`. We don't need to assert on the
// SQL string itself in this test — orchestration is the focus — so a
// minimal stub that returns the same opaque SQL marker is enough.
jest.mock('drizzle-orm', () => {
  const sqlTag = (() => {
    const fn: unknown = () => ({ __sql: true });
    (fn as Record<string, unknown>).join = () => ({ __sql: true });
    (fn as Record<string, unknown>).raw = () => ({ __sql: true });
    return fn;
  })();
  return {
    sql: sqlTag,
    inArray: () => ({ __cond: true }),
    eq: () => ({ __cond: true }),
  };
});

const mockGetLastRunTimestamp = jest.fn<() => Promise<number | null>>();
const mockUpdateLastRun = jest.fn<() => Promise<void>>();
const mockSelectExisting = jest.fn();
const mockExecuteUpdate = jest.fn();

// Drizzle's chained query builder for the bulk SELECT. Each method
// returns the chain itself; the terminal `.where(...)` returns the
// resolved row array via mockSelectExisting().
const selectChain = {
  select: jest.fn(),
  from: jest.fn(),
  where: jest.fn(),
};
selectChain.select.mockReturnValue(selectChain);
selectChain.from.mockReturnValue(selectChain);
selectChain.where.mockImplementation(() => Promise.resolve(mockSelectExisting()));

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => selectChain.select(...args),
    execute: (...args: unknown[]) => mockExecuteUpdate(...args),
  },
  artists: {
    artist_name: 'artist_name',
    discogs_artist_id: 'discogs_artist_id',
    musicbrainz_artist_id: 'musicbrainz_artist_id',
    wikidata_qid: 'wikidata_qid',
    spotify_artist_id: 'spotify_artist_id',
    apple_music_artist_id: 'apple_music_artist_id',
    bandcamp_id: 'bandcamp_id',
  },
  getLastRunTimestamp: (...args: unknown[]) => mockGetLastRunTimestamp(...args),
  updateLastRun: (...args: unknown[]) => mockUpdateLastRun(...args),
}));

const mockFetchLml = jest.fn();
jest.mock('../../../../jobs/artist-identity-etl/fetch-lml', () => ({
  fetchLmlIdentities: (...args: unknown[]) => mockFetchLml(...args),
  closeLmlConnection: jest.fn(),
}));

// runIncremental must be imported *after* the mocks are registered
// (Jest hoists jest.mock calls but the imported symbols would otherwise
// resolve to the real modules first).
import { runIncremental } from '../../../../jobs/artist-identity-etl/runIncremental';

const lmlRow = (library_name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  library_name,
  discogs_artist_id: null,
  musicbrainz_artist_id: null,
  wikidata_qid: null,
  spotify_artist_id: null,
  apple_music_artist_id: null,
  bandcamp_id: null,
  ...overrides,
});

const existingRow = (artist_name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  artist_name,
  discogs_artist_id: null,
  musicbrainz_artist_id: null,
  wikidata_qid: null,
  spotify_artist_id: null,
  apple_music_artist_id: null,
  bandcamp_id: null,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLastRunTimestamp.mockResolvedValue(null);
  mockUpdateLastRun.mockResolvedValue(undefined);
  mockSelectExisting.mockReturnValue([]);
  mockExecuteUpdate.mockResolvedValue([]);
});

describe('runIncremental', () => {
  test('returns zeroed result and does no SELECT/UPDATE on empty LML response', async () => {
    mockFetchLml.mockResolvedValue([]);

    const result = await runIncremental();

    expect(result).toEqual({ scanned: 0, matched: 0, updated: 0, columnsWritten: 0, conflicts: 0 });
    expect(selectChain.select).not.toHaveBeenCalled();
    expect(mockExecuteUpdate).not.toHaveBeenCalled();
    expect(mockUpdateLastRun).toHaveBeenCalledTimes(1);
  });

  test('counts matched LML rows whose name appears in artists', async () => {
    mockFetchLml.mockResolvedValue([
      lmlRow('Stereolab', { discogs_artist_id: 5371 }),
      lmlRow('Cat Power', { discogs_artist_id: 19324 }),
      lmlRow('Unknown Artist', { discogs_artist_id: 99999 }),
    ]);
    mockSelectExisting.mockReturnValue([existingRow('Stereolab'), existingRow('Cat Power')]);
    mockExecuteUpdate.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const result = await runIncremental();

    expect(result.scanned).toBe(3);
    expect(result.matched).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.columnsWritten).toBe(2);
    expect(result.conflicts).toBe(0);
  });

  test('logs a conflict and increments counter when existing differs from LML', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchLml.mockResolvedValue([lmlRow('Stereolab', { discogs_artist_id: 999 })]);
    mockSelectExisting.mockReturnValue([existingRow('Stereolab', { discogs_artist_id: 5371 })]);

    const result = await runIncremental();

    expect(result.matched).toBe(1);
    expect(result.conflicts).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[artist-identity-etl] Conflict on Stereolab.discogs_artist_id: existing=5371 lml=999 (skipped)'
      )
    );
    warn.mockRestore();
  });

  test('does not issue an UPDATE when every matching row already has the LML values', async () => {
    mockFetchLml.mockResolvedValue([lmlRow('Stereolab', { discogs_artist_id: 5371 })]);
    mockSelectExisting.mockReturnValue([
      existingRow('Stereolab', { discogs_artist_id: 5371 }), // already populated and matches
    ]);

    const result = await runIncremental();

    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.columnsWritten).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(mockExecuteUpdate).not.toHaveBeenCalled();
  });

  test('counts columnsWritten across multiple keys per LML row', async () => {
    mockFetchLml.mockResolvedValue([
      lmlRow('Stereolab', {
        discogs_artist_id: 5371,
        musicbrainz_artist_id: 'd2bb3a2c-9d6a-4f6b-9a6c-c9a8d1e0a1f2',
        wikidata_qid: 'Q483507',
      }),
    ]);
    mockSelectExisting.mockReturnValue([existingRow('Stereolab')]);
    mockExecuteUpdate.mockResolvedValue([{ id: 1 }]);

    const result = await runIncremental();

    expect(result.matched).toBe(1);
    expect(result.columnsWritten).toBe(3);
  });

  test('passes only fillable LML rows into the bulk UPDATE', async () => {
    mockFetchLml.mockResolvedValue([
      lmlRow('Stereolab', { discogs_artist_id: 5371 }),
      lmlRow('Cat Power', { discogs_artist_id: 19324 }),
    ]);
    mockSelectExisting.mockReturnValue([
      existingRow('Stereolab'), // null → will fill
      existingRow('Cat Power', { discogs_artist_id: 19324 }), // already correct → no fill
    ]);
    mockExecuteUpdate.mockResolvedValue([{ id: 1 }]);

    const result = await runIncremental();

    expect(result.matched).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.columnsWritten).toBe(1);
    expect(mockExecuteUpdate).toHaveBeenCalledTimes(1);
  });

  test('updates the last-run timestamp on every successful path', async () => {
    // empty path
    mockFetchLml.mockResolvedValue([]);
    await runIncremental();
    expect(mockUpdateLastRun).toHaveBeenCalledTimes(1);

    // matched-but-no-fill path
    mockFetchLml.mockResolvedValue([lmlRow('Stereolab', { discogs_artist_id: 5371 })]);
    mockSelectExisting.mockReturnValue([existingRow('Stereolab', { discogs_artist_id: 5371 })]);
    await runIncremental();
    expect(mockUpdateLastRun).toHaveBeenCalledTimes(2);

    // fill path
    mockSelectExisting.mockReturnValue([existingRow('Stereolab')]);
    mockExecuteUpdate.mockResolvedValue([{ id: 1 }]);
    await runIncremental();
    expect(mockUpdateLastRun).toHaveBeenCalledTimes(3);
  });
});
