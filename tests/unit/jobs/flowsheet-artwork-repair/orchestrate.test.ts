/**
 * Unit tests for flowsheet-artwork-repair `orchestrate.ts` (BS#1209).
 *
 * Pins:
 *   1. The two enumeration SELECTs carry their canonical WHERE filters
 *      (free-form residue and linked residue).
 *   2. `runRepair` drives the two phases in order (free-form first, linked
 *      second), calls `lookup` once per row, dispatches to the right
 *      writer, and accumulates the documented counters.
 *   3. LML throws are caught and bumped to the `error` counter; the writer
 *      is NOT invoked for that row.
 *   4. Cooperative pause: when `checkLiveActivity` returns true the loop
 *      defers; when it returns false, work proceeds. `lookbackSeconds=0`
 *      bypasses the probe entirely.
 *   5. Env-var resolvers reject invalid input and fall back on unset.
 */
import { jest } from '@jest/globals';

import { db, type CheckLiveActivityFn } from '@wxyc/database';
import {
  enumerateFreeFormResidue,
  enumerateLinkedResidue,
  resolveLiveActivityLookback,
  resolveLiveActivityPauseMs,
  runRepair,
  type FreeFormRepairFn,
  type LinkedRepairFn,
  type LookupFn,
} from '../../../../jobs/flowsheet-artwork-repair/orchestrate';
import type { LookupResponse } from '@wxyc/lml-client';

type SqlLike = {
  sql?: string | string[];
  raw?: string;
  queryChunks?: Array<string | { value?: string | string[]; raw?: string }>;
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  // sql.raw produces a top-level `{ raw: "..." }` chunk.
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (typeof chunk.raw === 'string') return chunk.raw;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const matchedResponse: LookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: { release_id: 100, release_url: 'https://x', artwork_url: 'https://i.discogs.com/a.jpg' },
    },
  ],
  search_type: 'direct',
};

const noMatchResponse: LookupResponse = {
  results: [],
  search_type: 'none',
};

describe('enumerateFreeFormResidue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a SELECT that pins the three-predicate WHERE clause', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreeFormResidue();

    const sql = renderSql((db.execute as jest.Mock).mock.calls.at(-1)?.[0]);
    expect(sql).toMatch(/"metadata_status"\s*=\s*'enriched_match'/);
    expect(sql).toMatch(/"artwork_url"\s+IS\s+NULL/i);
    expect(sql).toMatch(/"album_id"\s+IS\s+NULL/i);
    // We need artist_name + album_title + track_title to call LML
    expect(sql).toMatch(/"artist_name"/);
    expect(sql).toMatch(/"album_title"/);
    expect(sql).toMatch(/"track_title"/);
  });

  it('wraps the query in a SET LOCAL statement_timeout transaction (long scan-safety)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    (db.transaction as jest.Mock).mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));

    await enumerateFreeFormResidue(60_000);

    expect(db.transaction).toHaveBeenCalled();
    // First execute inside the transaction is the SET LOCAL
    const firstCall = (db.execute as jest.Mock).mock.calls[0]?.[0];
    expect(renderSql(firstCall)).toMatch(/SET LOCAL\s+statement_timeout/i);
    expect(renderSql(firstCall)).toContain('60000');
  });
});

describe('enumerateLinkedResidue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a JOIN to library and pins the album_metadata.artwork_url IS NULL predicate', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateLinkedResidue();

    // renderSql doesn't visit sql.raw chunks for schema-qualified table
    // names; assert on the column references + WHERE clauses we can see.
    const sql = renderSql((db.execute as jest.Mock).mock.calls.at(-1)?.[0]);
    expect(sql.toLowerCase()).toContain('am."album_id"');
    expect(sql.toLowerCase()).toContain('l."album_title"');
    expect(sql).toMatch(/am\."artwork_url"\s+IS\s+NULL/i);
    // album-level dedup — explicit SELECT DISTINCT or implicit via PK groupby
    expect(sql.toLowerCase()).toMatch(/distinct|group by/);
    // Need artist + title for LML
    expect(sql.toLowerCase()).toContain('artist_name');
    expect(sql.toLowerCase()).toContain('album_title');
  });
});

describe('resolveLiveActivityLookback / resolveLiveActivityPauseMs', () => {
  it('falls back to the shared 60s / 30s defaults when env var is unset', () => {
    expect(resolveLiveActivityLookback(undefined)).toBe(60);
    expect(resolveLiveActivityPauseMs(undefined)).toBe(30_000);
  });

  it('accepts valid non-negative integers (0 disables)', () => {
    expect(resolveLiveActivityLookback('0')).toBe(0);
    expect(resolveLiveActivityLookback('120')).toBe(120);
    expect(resolveLiveActivityPauseMs('0')).toBe(0);
    expect(resolveLiveActivityPauseMs('5000')).toBe(5000);
  });

  it('throws on invalid input', () => {
    expect(() => resolveLiveActivityLookback('-1')).toThrow(/LIVE_ACTIVITY_LOOKBACK_SECONDS/);
    expect(() => resolveLiveActivityLookback('abc')).toThrow(/LIVE_ACTIVITY_LOOKBACK_SECONDS/);
    expect(() => resolveLiveActivityPauseMs('-1')).toThrow(/LIVE_ACTIVITY_PAUSE_MS/);
  });
});

describe('runRepair', () => {
  const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResponse);
  const freeFormFn = jest.fn<FreeFormRepairFn>().mockResolvedValue('free_form_repaired');
  const linkedFn = jest.fn<LinkedRepairFn>().mockResolvedValue('linked_repaired');
  const checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);

  beforeEach(() => jest.clearAllMocks());

  it('runs free-form phase first, then linked phase, in single sequential order', async () => {
    const callOrder: string[] = [];
    freeFormFn.mockImplementation(() => {
      callOrder.push('free_form');
      return Promise.resolve('free_form_repaired');
    });
    linkedFn.mockImplementation(() => {
      callOrder.push('linked');
      return Promise.resolve('linked_repaired');
    });

    await runRepair({
      lookup,
      repairFreeForm: freeFormFn,
      repairLinked: linkedFn,
      checkLiveActivity,
      liveActivityLookbackSeconds: 0,
      liveActivityPauseMs: 0,
      freeFormRows: [
        { id: 1, artist_name: 'a', album_title: null, track_title: 't1' },
        { id: 2, artist_name: 'b', album_title: null, track_title: 't2' },
      ],
      linkedAlbums: [
        { album_id: 10, artist_name: 'c', album_title: 'A1' },
        { album_id: 11, artist_name: 'd', album_title: 'A2' },
      ],
    });

    expect(callOrder).toEqual(['free_form', 'free_form', 'linked', 'linked']);
  });

  it('accumulates the six counters by writer outcome', async () => {
    freeFormFn
      .mockResolvedValueOnce('free_form_repaired')
      .mockResolvedValueOnce('free_form_raced')
      .mockResolvedValueOnce('still_null_after_lml');
    linkedFn
      .mockResolvedValueOnce('linked_repaired')
      .mockResolvedValueOnce('linked_raced')
      .mockResolvedValueOnce('still_null_after_lml');

    const result = await runRepair({
      lookup,
      repairFreeForm: freeFormFn,
      repairLinked: linkedFn,
      checkLiveActivity,
      liveActivityLookbackSeconds: 0,
      liveActivityPauseMs: 0,
      freeFormRows: [
        { id: 1, artist_name: 'a', album_title: null, track_title: null },
        { id: 2, artist_name: 'b', album_title: null, track_title: null },
        { id: 3, artist_name: 'c', album_title: null, track_title: null },
      ],
      linkedAlbums: [
        { album_id: 10, artist_name: 'd', album_title: 'A' },
        { album_id: 11, artist_name: 'e', album_title: 'B' },
        { album_id: 12, artist_name: 'f', album_title: 'C' },
      ],
    });

    expect(result.totals).toMatchObject({
      free_form_scanned: 3,
      free_form_repaired: 1,
      free_form_raced: 1,
      linked_scanned: 3,
      linked_repaired: 1,
      linked_raced: 1,
      still_null_after_lml: 2,
      error: 0,
    });
  });

  it('counts LML throws against error; writers NOT invoked for that row', async () => {
    const flakyLookup = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce(matchedResponse)
      .mockRejectedValueOnce(new Error('LML 502'))
      .mockResolvedValueOnce(matchedResponse);

    const result = await runRepair({
      lookup: flakyLookup,
      repairFreeForm: freeFormFn,
      repairLinked: linkedFn,
      checkLiveActivity,
      liveActivityLookbackSeconds: 0,
      liveActivityPauseMs: 0,
      freeFormRows: [
        { id: 1, artist_name: 'a', album_title: null, track_title: null },
        { id: 2, artist_name: 'b', album_title: null, track_title: null },
      ],
      linkedAlbums: [{ album_id: 10, artist_name: 'c', album_title: 'A' }],
    });

    expect(result.totals.free_form_scanned).toBe(2);
    expect(result.totals.free_form_repaired).toBe(1);
    expect(result.totals.linked_repaired).toBe(1);
    expect(result.totals.error).toBe(1);
    // Writers called only for the non-error rows
    expect(freeFormFn).toHaveBeenCalledTimes(1);
    expect(linkedFn).toHaveBeenCalledTimes(1);
  });

  it('passes artist+album+track to lookup for free-form rows; artist+album for linked', async () => {
    await runRepair({
      lookup,
      repairFreeForm: freeFormFn,
      repairLinked: linkedFn,
      checkLiveActivity,
      liveActivityLookbackSeconds: 0,
      liveActivityPauseMs: 0,
      freeFormRows: [{ id: 1, artist_name: 'A1', album_title: 'B1', track_title: 'T1' }],
      linkedAlbums: [{ album_id: 10, artist_name: 'A2', album_title: 'B2' }],
    });

    expect(lookup).toHaveBeenNthCalledWith(1, 'A1', 'B1', 'T1');
    expect(lookup).toHaveBeenNthCalledWith(2, 'A2', 'B2', undefined);
  });

  it('defers when checkLiveActivity returns true, then resumes when it clears', async () => {
    const probe = jest
      .fn<CheckLiveActivityFn>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(false);

    await runRepair({
      lookup,
      repairFreeForm: freeFormFn,
      repairLinked: linkedFn,
      checkLiveActivity: probe,
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 0,
      freeFormRows: [{ id: 1, artist_name: 'a', album_title: null, track_title: null }],
      linkedAlbums: [],
    });

    // probe called: 3 times until cleared + 1 final pre-row probe = 3 minimum
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Probe windows are 60s
    probe.mock.calls.forEach((call) => expect(call[0]).toBe(60));
  });

  it('skips probe entirely when liveActivityLookbackSeconds is 0', async () => {
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValue(true);

    await runRepair({
      lookup,
      repairFreeForm: freeFormFn,
      repairLinked: linkedFn,
      checkLiveActivity: probe,
      liveActivityLookbackSeconds: 0,
      liveActivityPauseMs: 0,
      freeFormRows: [{ id: 1, artist_name: 'a', album_title: null, track_title: null }],
      linkedAlbums: [{ album_id: 10, artist_name: 'b', album_title: 'B' }],
    });

    expect(probe).not.toHaveBeenCalled();
  });
});
