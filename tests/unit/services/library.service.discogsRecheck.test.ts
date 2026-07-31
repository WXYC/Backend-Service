/**
 * Unit tests for `recheckDiscogsAvailability` (BS#1283 / epic #1280
 * sub-issue 3), the apps/backend-side twin of the
 * `jobs/library-discogs-unavailable-recheck` cron's per-row path, used by
 * `POST /library/:id/discogs-recheck`.
 *
 * Covers the same three outcome shapes and the sticky-false-match /
 * multi-rotation-row correctness properties the cron's own writer tests pin
 * (`tests/unit/jobs/library-discogs-unavailable-recheck/writer.test.ts`),
 * plus `forceLookup: true` always being set on the wire call.
 *
 * Uses ONLY the shared `db._chain` singleton from `tests/mocks/database.mock
 * .ts` (never `db.update.mockReturnValue(otherChain)`) — every chain method
 * already auto-returns the singleton `_chain`, and overriding `db.update`'s
 * return value on one test would leak into every later test in this file
 * (`mockReturnValue` survives `clearAllMocks()`; only `mockReset()` clears
 * it).
 */

import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockLookupBySong = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
const mockGetRelease = jest.fn<() => Promise<unknown>>();
const mockResolveIdentity = jest.fn<() => Promise<unknown>>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  lookupBySong: mockLookupBySong,
  isLmlConfigured: mockIsLmlConfigured,
  getRelease: mockGetRelease,
  resolveIdentity: mockResolveIdentity,
  envInt: (_name: string, fallback: number) => fallback,
}));

jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: () => Promise.resolve(null) },
}));

const mockSentryMetricsCount = jest.fn<(name: string, value: number, opts: unknown) => void>();
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: unknown, callback: () => T | Promise<T>): Promise<T> => Promise.resolve(callback()),
  getActiveSpan: () => ({ setAttribute: jest.fn(), setAttributes: jest.fn() }),
  metrics: { count: mockSentryMetricsCount },
}));

import { recheckDiscogsAvailability } from '../../../apps/backend/services/library.service';

type SqlLike = {
  sql?: string | string[];
  raw?: string;
  queryChunks?: Array<string | { value?: unknown; raw?: string }>;
};

/**
 * Renders a real drizzle-orm SQL fragment (or a nested Param's raw value) to
 * a searchable string. Mirrors the `renderSql` helper in the
 * `jobs/library-discogs-unavailable-recheck` job's writer test — this test
 * file exercises the REAL `eq`/`sql` from drizzle-orm (not the
 * `tests/__mocks__/drizzle-orm.ts` automock some other service test files
 * opt into), same as `library.service.addToRotation.test.ts`.
 */
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (typeof chunk.raw === 'string') return chunk.raw;
        if (chunk.value !== undefined) return JSON.stringify(chunk.value);
        return '';
      })
      .join(' ');
  }
  return JSON.stringify(obj);
};

const chainSet = (db as unknown as { _chain: { set: jest.Mock } })._chain.set;
const chainWhere = (db as unknown as { _chain: { where: jest.Mock } })._chain.where;
const chainReturning = (db as unknown as { _chain: { returning: jest.Mock } })._chain.returning;

describe('recheckDiscogsAvailability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // `.returning()`'s default resolved value (from createMockQueryChain's
    // constructor arg, `[]`) doesn't fit every path here — reset so each
    // test queues exactly the return sequence its code path needs.
    chainReturning.mockReset();
    chainReturning.mockResolvedValue([{ id: 42 }]);
  });

  it('always passes forceLookup: true on the wire call', async () => {
    (mockLookupMetadata as jest.Mock).mockResolvedValue({ results: [{ artwork: { release_id: 1, confidence: 0.5 } }] });

    await recheckDiscogsAvailability(42, 'Some Artist', 'Some Album');

    expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
    const [artist, album, song, options] = (mockLookupMetadata as jest.Mock).mock.calls[0] as [
      string,
      string,
      undefined,
      Record<string, unknown>,
    ];
    expect(artist).toBe('Some Artist');
    expect(album).toBe('Some Album');
    expect(song).toBeUndefined();
    expect(options.forceLookup).toBe(true);
    expect(options.caller).toBe('library-discogs-unavailable-recheck');
  });

  it('matched (confidence >= 0.95): overwrites rotation.discogs_release_id with no IS NULL guard, clears the flag/note, returns the matched shape', async () => {
    (mockLookupMetadata as jest.Mock).mockResolvedValue({
      results: [{ artwork: { release_id: 99999, confidence: 0.98 } }],
    });
    // db.transaction's mock passes the shared mockDb through as `tx`, so the
    // rotation UPDATE (no .returning()) then the library UPDATE's single
    // .returning() call resolve from this queue in call order.
    chainReturning.mockResolvedValueOnce([{ id: 42 }]);

    const result = await recheckDiscogsAvailability(42, 'Some Artist', 'Some Album');

    expect(result).toEqual({ outcome: 'matched', discogsReleaseId: 99999, confidence: 0.98 });
    expect(db.transaction).toHaveBeenCalledTimes(1);

    const rotationSetArg = chainSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(rotationSetArg.discogs_release_id).toBe(99999);
    expect(rotationSetArg.discogs_release_id_source).toBe('recheck_after_unavailable');

    const librarySetArg = chainSet.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(librarySetArg.discogs_unavailable).toBe(false);
    expect(librarySetArg.discogs_unavailable_note).toBeNull();

    // Neither UPDATE's WHERE arg mentions an IS NULL guard on discogs_release_id.
    for (const call of chainWhere.mock.calls) {
      expect(renderSql(call[0])).not.toMatch(/IS NULL/i);
    }
    // The rotation UPDATE's WHERE keys on album_id (not id).
    expect(renderSql(chainWhere.mock.calls[0]?.[0])).toContain('album_id');
  });

  it('low_confidence_match (< 0.95): does not write rotation/library, fires the Sentry counter, stamps the timestamp', async () => {
    (mockLookupMetadata as jest.Mock).mockResolvedValue({
      results: [{ artwork: { release_id: 55555, confidence: 0.85 } }],
    });

    const result = await recheckDiscogsAvailability(42, 'Some Artist', 'Some Album');

    expect(result).toEqual({ outcome: 'low_confidence_match', confidence: 0.85 });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockSentryMetricsCount).toHaveBeenCalledWith(
      'lml.lookup.recheck.match_found_on_flagged',
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ confidence: 0.85, library_id: 42 }),
      })
    );
    // Only the timestamp UPDATE ran (db.update once, no transaction).
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(chainSet).toHaveBeenCalledWith(expect.objectContaining({ last_discogs_recheck_at: expect.anything() }));
    expect(Object.keys(chainSet.mock.calls[0]?.[0] as Record<string, unknown>)).toEqual(['last_discogs_recheck_at']);
  });

  it('no_match: stamps only the timestamp, no Sentry counter', async () => {
    (mockLookupMetadata as jest.Mock).mockResolvedValue({ results: [] });

    const result = await recheckDiscogsAvailability(42, 'Some Artist', 'Some Album');

    expect(result).toEqual({ outcome: 'no_match' });
    expect(mockSentryMetricsCount).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('treats the BS#1185 streaming-only sentinel (release_id 0) as no_match', async () => {
    (mockLookupMetadata as jest.Mock).mockResolvedValue({
      results: [{ artwork: { release_id: 0, confidence: 0.9 } }],
    });

    const result = await recheckDiscogsAvailability(42, 'Some Artist', 'Some Album');

    expect(result).toEqual({ outcome: 'no_match' });
  });

  it('multi-rotation-row: updates ALL rotation rows for the album_id in one statement (issue test 9)', async () => {
    (mockLookupMetadata as jest.Mock).mockResolvedValue({
      results: [{ artwork: { release_id: 12345, confidence: 0.99 } }],
    });
    // The writer never calls .returning() on the rotation UPDATE — the
    // "multi-row" property is that the WHERE clause has no per-row
    // narrowing, not a returned row count. The single .returning() call is
    // the library UPDATE.
    chainReturning.mockResolvedValueOnce([{ id: 42 }]);

    const result = await recheckDiscogsAvailability(42, 'Some Artist', 'Some Album');

    expect(result).toEqual({ outcome: 'matched', discogsReleaseId: 12345, confidence: 0.99 });

    // The rotation UPDATE's WHERE keys only on album_id — no id/limit
    // narrowing that would cap it to a single row.
    expect(renderSql(chainWhere.mock.calls[0]?.[0])).toContain('album_id');
  });
});
