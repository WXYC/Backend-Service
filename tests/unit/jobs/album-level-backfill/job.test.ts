/**
 * Unit tests for the album-level-backfill job (BS#1041).
 *
 * Covers the BS#1041 acceptance criteria: batching, partial LML failure
 * isolation, idempotency on re-run, and the post-pass SQL UPDATE shape.
 *
 * Uses the @wxyc/database mock and a jest.mock for @wxyc/lml-client so
 * no network IO happens. SQL is asserted via text inspection (same
 * pattern as tests/unit/jobs/album-metadata-backfill/job.test.ts).
 */

import { jest } from '@jest/globals';

// Mock @wxyc/lml-client BEFORE importing the job. The job pulls in
// bulkLookupMetadata at module load.
const mockBulkLookupMetadata = jest.fn<(items: unknown, opts?: unknown) => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  __esModule: true,
  bulkLookupMetadata: mockBulkLookupMetadata,
}));

import { db, album_metadata } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  enumeratePendingAlbumIds,
  resolveAlbums,
  buildBulkItems,
  upsertAlbumMatch,
  checkLiveActivity,
  awaitQuietWindow,
  runPostPassUpdate,
  analyzeAlbumMetadata,
  runBatch,
  resolveOptions,
  runBackfill,
  BULK_BATCH_SIZE_DEFAULT,
  BULK_BATCH_SIZE_ENV,
  BULK_RATE_PER_MIN_DEFAULT,
  BULK_RATE_PER_MIN_ENV,
  BULK_BUDGET_MS_DEFAULT,
  BULK_PER_ITEM_TIMEOUT_MS,
  BULK_TIMEOUT_SLACK_MS,
  computeBulkTimeoutMs,
  POST_PASS_TIMEOUT_DEFAULT,
  POST_PASS_TIMEOUT_ENV,
  READ_TIMEOUT_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_ENV,
  type ResolvedAlbum,
  type BackfillOptions,
} from '../../../../jobs/album-level-backfill/job';

type SqlLike = {
  sql?: string | string[];
  raw?: string;
  queryChunks?: Array<string | { value?: string | string[]; raw?: string }>;
};
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
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  return (db.execute as jest.Mock).mock.calls.find((call) => pattern.test(renderSql(call[0])));
};

const renderInsertChain = (): {
  valuesArg: unknown;
  conflictArg: unknown;
} => {
  const insertChain = (db as unknown as { _chain: Record<string, jest.Mock> })._chain;
  return {
    valuesArg: insertChain.values.mock.calls[0]?.[0],
    conflictArg: insertChain.onConflictDoUpdate.mock.calls[0]?.[0],
  };
};

const RESET_ENV_KEYS = [BULK_BATCH_SIZE_ENV, BULK_RATE_PER_MIN_ENV, POST_PASS_TIMEOUT_ENV, LIVE_ACTIVITY_LOOKBACK_ENV];

const stripEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out = { ...env };
  for (const k of RESET_ENV_KEYS) delete out[k];
  return out;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Source query.
// ---------------------------------------------------------------------------

describe('enumeratePendingAlbumIds', () => {
  it('selects DISTINCT album_id from flowsheet with all four required predicates and ORDER BY', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: 1 }, { album_id: 2 }]);

    await enumeratePendingAlbumIds();

    // First mock call is `SET LOCAL statement_timeout`, second is the SELECT.
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+"?album_id"?/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"?entry_type"?\s*=\s*'track'/i);
    expect(text).toMatch(/"?artist_name"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"?metadata_status"?\s*=\s*'pending'/i);
    expect(text).toMatch(/"?album_id"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/ORDER\s+BY\s+"?album_id"?/i);
  });

  it('returns the album_id values as numbers', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: '101' }, { album_id: 202 }]);

    const ids = await enumeratePendingAlbumIds();

    expect(ids).toEqual([101, 202]);
  });

  it('wraps the SELECT in a transaction + SET LOCAL statement_timeout (BS#1041 dry-run regression)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await enumeratePendingAlbumIds(123_456);

    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    const setLocalCall = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(setLocalCall).toBeDefined();
    expect(renderSql(setLocalCall?.[0])).toMatch(/123456ms/);
  });
});

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

describe('resolveAlbums', () => {
  it('returns an empty array without hitting the DB when given no ids', async () => {
    const out = await resolveAlbums([]);
    expect(out).toEqual([]);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
    expect(db.transaction as jest.Mock).not.toHaveBeenCalled();
  });

  it('joins library + artists with COALESCE on artist_name; selects album_title from library', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' }]);

    await resolveAlbums([1, 2, 3]);

    const call = findExecuteCallMatching(/FROM\s+"?wxyc_schema"?\."?library"?/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/LEFT\s+JOIN\s+"?wxyc_schema"?\."?artists"?/i);
    expect(text).toMatch(/COALESCE\s*\(\s*a\."?artist_name"?\s*,\s*l\."?artist_name"?\s*\)/i);
    // BS#1065 regression pin: `library.album_title` is the canonical column,
    // not `library.title`. The 2026-05-24 prod canary failed with
    // `column l.title does not exist` because the original SQL used `l.title`.
    expect(text).toMatch(/l\."?album_title"?\s+AS\s+album_title/i);
    expect(text).not.toMatch(/l\."?title"?(?!_)/i); // l."title" not l."title_…"
    expect(text).toMatch(/=\s*ANY\(/i);
    // `library.artist_name` is nullable (schema.ts:346, Epic A.1 backfill
    // not yet complete); without this filter, `String(null)` would produce
    // the literal `"null"` and we'd POST it to LML as the artist.
    expect(text).toMatch(/COALESCE\s*\(\s*a\."?artist_name"?\s*,\s*l\."?artist_name"?\s*\)\s+IS\s+NOT\s+NULL/i);

    // BS#1068 + BS#1071 regression pin: positive-assert the
    // `'{1,2,3}'::int[]` array-literal binding shape. Drizzle/postgres-js
    // splats `${jsArray}` into N positional placeholders for BOTH
    // `ANY(${array}::int[])` (BS#1068, cast collides with splat) and
    // bare `ANY(${array})` (BS#1071, splat produces `ANY((p1, p2, ...))` —
    // PG rejects: "op ANY/ALL (array) requires array on right side").
    // The only shape that survives is `ANY('{1,2,3}'::int[])` — a single
    // bound text param cast to int[] inside PG.
    const values = (call?.[0] as { values?: unknown[] } | undefined)?.values ?? [];
    expect(values).toContain('{1,2,3}');
    // Anti-assert the broken shapes: no individual numeric param values
    // from a splat (the BS#1068/BS#1071 symptom).
    expect(values).not.toContain(1);
    expect(values).not.toContain(2);
    expect(values).not.toContain(3);
  });

  it('wraps the SELECT in a transaction + SET LOCAL statement_timeout (BS#1041 dry-run regression)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await resolveAlbums([1], 90_000);

    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    const setLocalCall = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(setLocalCall).toBeDefined();
    expect(renderSql(setLocalCall?.[0])).toMatch(/90000ms/);
  });
});

// ---------------------------------------------------------------------------
// Bulk item shape.
// ---------------------------------------------------------------------------

describe('buildBulkItems', () => {
  it('shapes each album into { artist, album, raw_message }', () => {
    const albums: ResolvedAlbum[] = [
      { album_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' },
      { album_id: 2, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ];

    const items = buildBulkItems(albums);

    expect(items).toEqual([
      { artist: 'Juana Molina', album: 'DOGA', raw_message: 'Juana Molina - DOGA' },
      {
        artist: 'Jessica Pratt',
        album: 'On Your Own Love Again',
        raw_message: 'Jessica Pratt - On Your Own Love Again',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// album_metadata UPSERT.
// ---------------------------------------------------------------------------

const lookupWithArtwork = (overrides: Record<string, unknown> = {}): LookupResponse => {
  // The generated LookupResponse has all-optional top-level fields and
  // accepts a partial `results[i].artwork`, so a literal that fills only
  // the fields `upsertAlbumMatch` reads typechecks directly. The override
  // record is the only field that varies between tests.
  return {
    results: [
      {
        artwork: {
          artwork_url: 'https://img.discogs.com/release/1.jpg',
          release_url: 'https://www.discogs.com/release/1',
          release_year: 2024,
          spotify_url: 'https://open.spotify.com/album/abc',
          apple_music_url: 'https://music.apple.com/album/abc',
          youtube_music_url: 'https://music.youtube.com/playlist?list=abc',
          bandcamp_url: 'https://x.bandcamp.com/album/abc',
          soundcloud_url: 'https://soundcloud.com/x/abc',
          artist_bio: 'Bio with [a=Stereolab] markup.',
          wikipedia_url: 'https://en.wikipedia.org/wiki/X',
          ...overrides,
        },
      },
    ],
  };
};

describe('upsertAlbumMatch', () => {
  it('UPSERTs the 10-column payload into album_metadata with album_id as conflict target', async () => {
    const wrote = await upsertAlbumMatch(42, lookupWithArtwork());

    expect(wrote).toBe(true);
    expect(db.insert as jest.Mock).toHaveBeenCalledWith(album_metadata);
    const { valuesArg, conflictArg } = renderInsertChain();
    expect(valuesArg).toMatchObject({
      album_id: 42,
      artwork_url: 'https://img.discogs.com/release/1.jpg',
      discogs_url: 'https://www.discogs.com/release/1',
      release_year: 2024,
      spotify_url: 'https://open.spotify.com/album/abc',
      apple_music_url: 'https://music.apple.com/album/abc',
      youtube_music_url: 'https://music.youtube.com/playlist?list=abc',
      bandcamp_url: 'https://x.bandcamp.com/album/abc',
      soundcloud_url: 'https://soundcloud.com/x/abc',
      artist_bio: 'Bio with Stereolab markup.', // [a=...] stripped by cleanDiscogsBio
      artist_wikipedia_url: 'https://en.wikipedia.org/wiki/X',
    });
    expect((conflictArg as { target: unknown }).target).toBe(album_metadata.album_id);
    // Race guard: setWhere narrows updates to older rows only. The column
    // reference (`album_metadata.updated_at`) renders as a Drizzle Column
    // object that the textual renderer can't introspect; we assert the
    // operator + RHS we control directly, and trust the LHS by construction.
    const setWhereText = renderSql((conflictArg as { setWhere: unknown }).setWhere);
    expect(setWhereText).toMatch(/<\s*NOW\(\)/i);
  });

  it('drops spacer.gif artwork URLs to null', async () => {
    await upsertAlbumMatch(42, lookupWithArtwork({ artwork_url: 'https://img.discogs.com/spacer.gif' }));
    const { valuesArg } = renderInsertChain();
    expect(valuesArg).toMatchObject({ artwork_url: null });
  });

  it('coerces release_year=0 to null (Discogs "year unknown" sentinel)', async () => {
    await upsertAlbumMatch(42, lookupWithArtwork({ release_year: 0 }));
    const { valuesArg } = renderInsertChain();
    expect(valuesArg).toMatchObject({ release_year: null });
  });

  it('returns false (no-op) when the LML response has no artwork', async () => {
    const wrote = await upsertAlbumMatch(42, { results: [] });
    expect(wrote).toBe(false);
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cooperative pause.
// ---------------------------------------------------------------------------

describe('checkLiveActivity', () => {
  it('returns false immediately and skips the DB when lookbackSeconds <= 0', async () => {
    expect(await checkLiveActivity(0)).toBe(false);
    expect(await checkLiveActivity(-1)).toBe(false);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
  });

  it('returns true when the probe query returns rows', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{}]);
    expect(await checkLiveActivity(60)).toBe(true);
  });

  it('returns false when the probe query returns no rows', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    expect(await checkLiveActivity(60)).toBe(false);
  });

  it('queries flowsheet filtered by entry_type=track and add_time within lookback', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await checkLiveActivity(60);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"?entry_type"?\s*=\s*'track'/i);
    expect(text).toMatch(/"?add_time"?\s*>\s*now\(\)\s*-\s*\(interval/i);
    expect(text).toMatch(/LIMIT\s+1/i);
  });
});

describe('awaitQuietWindow', () => {
  it('returns immediately when no activity', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await awaitQuietWindow(60, 1);
    expect(db.execute as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('loops until the probe returns empty', async () => {
    const probe = db.execute as jest.Mock;
    probe.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    await awaitQuietWindow(60, 1);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Post-pass UPDATE.
// ---------------------------------------------------------------------------

describe('runPostPassUpdate', () => {
  it('runs inside a transaction so SET LOCAL statement_timeout takes effect', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ flipped: 0 }]);
    await runPostPassUpdate(60_000);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
  });

  it('sets statement_timeout from the parameter (ms)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ flipped: 0 }]);
    await runPostPassUpdate(123_456);
    const call = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/123456ms/);
  });

  it('UPDATEs flowsheet via JOIN to album_metadata, narrowed by metadata_status=pending', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ flipped: 0 }]);
    await runPostPassUpdate(60_000);
    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*FROM[\s\S]*album_metadata/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/SET\s+"?metadata_status"?\s*=\s*'enriched_match'/i);
    expect(text).toMatch(/COALESCE\(f\."?metadata_attempt_at"?\s*,\s*now\(\)\)/i);
    expect(text).toMatch(/f\."?metadata_status"?\s*=\s*'pending'/i);
    expect(text).toMatch(/f\."?entry_type"?\s*=\s*'track'/i);
  });

  it('returns the count of flipped rows', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({}) // SET LOCAL
      .mockResolvedValueOnce([{ flipped: 7894 }]);
    const n = await runPostPassUpdate(60_000);
    expect(n).toBe(7894);
  });

  it('returns 0 when no rows match', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({}).mockResolvedValueOnce([{ flipped: 0 }]);
    expect(await runPostPassUpdate(60_000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ANALYZE.
// ---------------------------------------------------------------------------

describe('analyzeAlbumMetadata', () => {
  it('issues ANALYZE on the album_metadata table', async () => {
    await analyzeAlbumMetadata();
    const call = findExecuteCallMatching(/ANALYZE/i);
    expect(call).toBeDefined();
    expect(renderSql(call?.[0])).toMatch(/album_metadata/i);
  });
});

// ---------------------------------------------------------------------------
// Per-batch orchestration.
// ---------------------------------------------------------------------------

describe('runBatch', () => {
  beforeEach(() => {
    // resolveAlbums returns a single-row stub for the test album_id.
    (db.execute as jest.Mock).mockImplementation((_q) =>
      Promise.resolve([
        { album_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' },
        { album_id: 2, artist_name: 'Jessica Pratt', album_title: 'OYOLA' },
      ])
    );
  });

  it('dry-run does not call LML or the writer', async () => {
    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: true });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ match: 0, no_match: 0, error: 0, upserts: 0 });
  });

  it('forwards the resolved items + budgetMs + dynamic timeoutMs to bulkLookupMetadata', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'no_match', lookup: { results: [] } },
        { index: 1, status: 'no_match', lookup: { results: [] } },
      ],
    });

    await runBatch([1, 2], { budgetMs: 25000, dryRun: false });

    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(1);
    const [items, opts] = mockBulkLookupMetadata.mock.calls[0];
    expect(items).toEqual([
      { artist: 'Juana Molina', album: 'DOGA', raw_message: 'Juana Molina - DOGA' },
      { artist: 'Jessica Pratt', album: 'OYOLA', raw_message: 'Jessica Pratt - OYOLA' },
    ]);
    expect(opts).toEqual({ budgetMs: 25000, timeoutMs: computeBulkTimeoutMs(2), caller: 'album-level-backfill' });
  });

  it('counts match / no_match / error per response and UPSERTs only matches', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'match', lookup: lookupWithArtwork() },
        { index: 1, status: 'error', lookup: null, message: 'TimeoutError' },
      ],
    });

    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: false });

    expect(out).toMatchObject({ match: 1, no_match: 0, error: 1, upserts: 1 });
    expect((db.insert as jest.Mock).mock.calls.length).toBe(1);
  });

  it('an LML per-item error does not abort the batch (sibling matches still write)', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'error', lookup: null, message: 'BoomError' },
        { index: 1, status: 'match', lookup: lookupWithArtwork() },
      ],
    });

    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: false });

    expect(out).toMatchObject({ error: 1, match: 1, upserts: 1 });
    expect((db.insert as jest.Mock).mock.calls.length).toBe(1);
  });

  it('short-circuits when resolveAlbums returns an empty set (e.g. orphaned album_ids)', async () => {
    // resolveAlbums wraps in tx: tx.execute(SET LOCAL) then tx.execute(SELECT).
    // We need both calls to resolve to [] so the second (the SELECT result)
    // makes resolveAlbums return empty.
    (db.execute as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce([]) // SET LOCAL
      .mockResolvedValueOnce([]); // SELECT
    const out = await runBatch([99999], { budgetMs: 25000, dryRun: false });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(out).toMatchObject({ batchSize: 0, match: 0 });
  });

  it('BS#1076: HTTP-level bulkLookupMetadata throw is isolated; batch reports error=N and run continues', async () => {
    // Reproduces the 2026-05-24 prod failure: batch 2 hit a 30s LML
    // timeout (LmlClientError statusCode 504), which an uncaught throw
    // would propagate up and abort the entire run mid-stream. With
    // per-batch try/catch, the batch reports `error=N` and the loop
    // continues. UPSERTs from prior successful batches stay intact
    // (idempotent), and the per-row drain cron retries the failed
    // album_ids on its next sweep.
    mockBulkLookupMetadata.mockRejectedValueOnce(
      Object.assign(new Error('LML request timed out'), { name: 'LmlClientError', statusCode: 504 })
    );

    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: false });

    expect(out).toMatchObject({ batchSize: 2, match: 0, no_match: 0, error: 2, upserts: 0 });
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bulk-fetch timeout sizing.
// ---------------------------------------------------------------------------

describe('computeBulkTimeoutMs', () => {
  // Pin the linear relationship so a future bump to BULK_BATCH_SIZE_DEFAULT
  // without a paired slack bump fails loudly here, not in production as
  // `LmlClientError: LML request timed out`.
  it('is linear in batchSize: timeoutMs === batchSize × per_item + slack', () => {
    for (const n of [1, 5, 10, 15, 50, 100]) {
      expect(computeBulkTimeoutMs(n)).toBe(n * BULK_PER_ITEM_TIMEOUT_MS + BULK_TIMEOUT_SLACK_MS);
    }
  });

  // Slope-independent invariant: at the default batchSize, the client
  // timeout should not exceed one full per-item server budget plus slack.
  // Catches DEFAULT drift back to 10 (would give 55_000 ms at the post-#1198
  // slope, well over the 30_000 ms ceiling) without re-baking arithmetic
  // every time the slope or slack moves.
  it('keeps BULK_BATCH_SIZE_DEFAULT under one per-item budget + slack', () => {
    expect(computeBulkTimeoutMs(BULK_BATCH_SIZE_DEFAULT)).toBeLessThanOrEqual(
      BULK_BUDGET_MS_DEFAULT + BULK_TIMEOUT_SLACK_MS
    );
  });

  // Belt-and-suspenders cap on operator-overridden batch sizes (#1198 acceptance).
  // BACKFILL_BULK_BATCH_SIZE up to 20 — chosen to bracket plausible catch-up
  // overrides — must stay under 120 s of fetch budget. Above that we're outside
  // the regime LML's per-item cap was sized for and the failure mode shifts
  // from "slow batch" to "timeouts pile up while LML keeps doing work."
  it('caps overridden batchSize ≤ 20 at ≤ 120 s of fetch budget', () => {
    for (let n = 1; n <= 20; n++) {
      expect(computeBulkTimeoutMs(n)).toBeLessThanOrEqual(120_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Env / option resolution.
// ---------------------------------------------------------------------------

describe('resolveOptions', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses defaults when env is unset', () => {
    const opts = resolveOptions(stripEnv(process.env), []);
    expect(opts.batchSize).toBe(BULK_BATCH_SIZE_DEFAULT);
    expect(opts.ratePerMin).toBe(BULK_RATE_PER_MIN_DEFAULT);
    expect(opts.budgetMs).toBe(BULK_BUDGET_MS_DEFAULT);
    expect(opts.postPassTimeoutMs).toBe(POST_PASS_TIMEOUT_DEFAULT);
    expect(opts.readTimeoutMs).toBe(READ_TIMEOUT_DEFAULT);
    expect(opts.liveActivityLookbackSeconds).toBe(LIVE_ACTIVITY_LOOKBACK_DEFAULT);
    expect(opts.dryRun).toBe(false);
  });

  it('honors env overrides', () => {
    const env = { ...stripEnv(process.env), [BULK_BATCH_SIZE_ENV]: '25', [BULK_RATE_PER_MIN_ENV]: '2' };
    const opts = resolveOptions(env, []);
    expect(opts.batchSize).toBe(25);
    expect(opts.ratePerMin).toBe(2);
  });

  it('throws on invalid env (zero / non-integer / negative)', () => {
    expect(() => resolveOptions({ ...stripEnv(process.env), [BULK_BATCH_SIZE_ENV]: '0' }, [])).toThrow(
      /must be a positive integer/
    );
    expect(() => resolveOptions({ ...stripEnv(process.env), [BULK_BATCH_SIZE_ENV]: '0.5' }, [])).toThrow();
    expect(() => resolveOptions({ ...stripEnv(process.env), [BULK_BATCH_SIZE_ENV]: '-1' }, [])).toThrow();
  });

  it('allows LIVE_ACTIVITY_LOOKBACK_SECONDS=0 (catch-up runs disable the pause)', () => {
    const env = { ...stripEnv(process.env), [LIVE_ACTIVITY_LOOKBACK_ENV]: '0' };
    const opts = resolveOptions(env, []);
    expect(opts.liveActivityLookbackSeconds).toBe(0);
  });

  it('detects --dry-run in args', () => {
    const opts = resolveOptions(stripEnv(process.env), ['node', 'job.js', '--dry-run']);
    expect(opts.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Top-level orchestration.
// ---------------------------------------------------------------------------

const baseOptions = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  batchSize: 2,
  ratePerMin: 600, // pacing sleep = 100ms; test inserts artificial timing
  budgetMs: 25000,
  postPassTimeoutMs: 60_000,
  readTimeoutMs: 300_000,
  liveActivityLookbackSeconds: 0, // disable pause for tests
  liveActivityPauseMs: 1,
  dryRun: false,
  ...over,
});

describe('runBackfill', () => {
  // Each statement-timeout-wrapped function (enumerate, resolveAlbums,
  // post-pass UPDATE) costs 2 mock values: one for `SET LOCAL` and one for
  // the body SELECT/UPDATE. These helpers keep the queue declarations
  // readable.
  const wrappedSelect = (rows: unknown[]): [unknown, unknown] => [{}, rows];

  it('dry-run only enumerates and logs the planned batch count; no LML calls, no writes', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([1, 2, 3, 4, 5].map((album_id) => ({ album_id })));

    const summary = await runBackfill(baseOptions({ dryRun: true, batchSize: 2 }));

    expect(summary).toEqual({
      scanned: 5,
      batches: 3,
      match: 0,
      no_match: 0,
      error: 0,
      upserts: 0,
      flipped: 0,
    });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });

  it('chunks the enumerated album_ids by batchSize', async () => {
    // Queue: enumerate (SET LOCAL + SELECT) → 3× resolveAlbums (SET LOCAL +
    // SELECT each) → post-pass (SET LOCAL + UPDATE).
    const resolved = [
      { album_id: 1, artist_name: 'A', album_title: 'X' },
      { album_id: 2, artist_name: 'B', album_title: 'Y' },
    ];
    const mock = db.execute as jest.Mock;
    for (const v of [
      ...wrappedSelect([1, 2, 3, 4, 5].map((album_id) => ({ album_id }))),
      ...wrappedSelect(resolved),
      ...wrappedSelect(resolved),
      ...wrappedSelect(resolved),
      ...wrappedSelect([{ flipped: 0 }]),
    ]) {
      mock.mockResolvedValueOnce(v);
    }

    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'no_match', lookup: { results: [] } },
        { index: 1, status: 'no_match', lookup: { results: [] } },
      ],
    });

    const summary = await runBackfill(baseOptions({ batchSize: 2 }));

    expect(summary.batches).toBe(3);
    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(3);
  });

  it('runs the post-pass UPDATE after the bulk pass and reports the flipped count', async () => {
    const resolved = [{ album_id: 1, artist_name: 'A', album_title: 'X' }];
    const mock = db.execute as jest.Mock;
    for (const v of [
      ...wrappedSelect([{ album_id: 1 }]),
      ...wrappedSelect(resolved),
      ...wrappedSelect([{ flipped: 1234 }]),
    ]) {
      mock.mockResolvedValueOnce(v);
    }

    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    const summary = await runBackfill(baseOptions({ batchSize: 1 }));

    expect(summary.flipped).toBe(1234);
    // enumerate + resolveAlbums + post-pass each open a transaction.
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(3);
  });

  it('skips ANALYZE when no UPSERTs landed (avoid pointless table-wide stats refresh)', async () => {
    const resolved = [{ album_id: 1, artist_name: 'A', album_title: 'X' }];
    const mock = db.execute as jest.Mock;
    for (const v of [
      ...wrappedSelect([{ album_id: 1 }]),
      ...wrappedSelect(resolved),
      ...wrappedSelect([{ flipped: 0 }]),
    ]) {
      mock.mockResolvedValueOnce(v);
    }
    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    await runBackfill(baseOptions({ batchSize: 1 }));

    const analyzeCall = findExecuteCallMatching(/ANALYZE/i);
    expect(analyzeCall).toBeUndefined();
  });

  it('runs ANALYZE when any UPSERT landed', async () => {
    const resolved = [{ album_id: 1, artist_name: 'A', album_title: 'X' }];
    const mock = db.execute as jest.Mock;
    for (const v of [
      ...wrappedSelect([{ album_id: 1 }]),
      ...wrappedSelect(resolved),
      {}, // ANALYZE (not tx-wrapped)
      ...wrappedSelect([{ flipped: 1 }]),
    ]) {
      mock.mockResolvedValueOnce(v);
    }
    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'match', lookup: lookupWithArtwork() }],
    });

    await runBackfill(baseOptions({ batchSize: 1 }));

    const analyzeCall = findExecuteCallMatching(/ANALYZE/i);
    expect(analyzeCall).toBeDefined();
  });
});
