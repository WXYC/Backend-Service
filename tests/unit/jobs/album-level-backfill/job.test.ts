/**
 * Unit tests for the album-level-backfill job (BS#1041).
 *
 * Covers the BS#1041 acceptance criteria: batching, partial LML failure
 * isolation, idempotency on re-run, and the post-pass SQL UPDATE shape.
 * Also pins the build-graph-isolated helpers (cleanDiscogsBio,
 * filterSpacerGif) to the same shapes as their canonical sources.
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
  cleanDiscogsBio,
  filterSpacerGif,
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
  POST_PASS_TIMEOUT_DEFAULT,
  POST_PASS_TIMEOUT_ENV,
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
// Inlined helpers — parity with the canonical sources.
// ---------------------------------------------------------------------------

describe('cleanDiscogsBio (inlined for build-graph isolation)', () => {
  it('strips [a=...], [l=...], [r=...], [m=...] markup', () => {
    expect(cleanDiscogsBio('Member of [a=Stereolab]')).toBe('Member of Stereolab');
    expect(cleanDiscogsBio('Released on [l=Drag City]')).toBe('Released on Drag City');
    expect(cleanDiscogsBio('See [r=12345]')).toBe('See 12345');
    expect(cleanDiscogsBio('See also [m=67890]')).toBe('See also 67890');
  });

  it('strips [url=...]label[/url] markup', () => {
    expect(cleanDiscogsBio('Bio link [url=https://example.com]here[/url]')).toBe('Bio link here');
  });

  it('returns text unchanged when no markup is present', () => {
    expect(cleanDiscogsBio('Juana Molina is an Argentine musician.')).toBe('Juana Molina is an Argentine musician.');
  });
});

describe('filterSpacerGif (inlined for build-graph isolation)', () => {
  it('returns null for null / undefined / empty', () => {
    expect(filterSpacerGif(null)).toBeNull();
    expect(filterSpacerGif(undefined)).toBeNull();
    expect(filterSpacerGif('')).toBeNull();
  });

  it('returns null when the URL contains "spacer.gif"', () => {
    expect(filterSpacerGif('https://img.discogs.com/spacer.gif')).toBeNull();
  });

  it('returns the URL unchanged when it does not reference spacer.gif', () => {
    const url = 'https://img.discogs.com/release/12345.jpg';
    expect(filterSpacerGif(url)).toBe(url);
  });
});

// ---------------------------------------------------------------------------
// Source query.
// ---------------------------------------------------------------------------

describe('enumeratePendingAlbumIds', () => {
  it('selects DISTINCT album_id from flowsheet with all four required predicates and ORDER BY', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: 1 }, { album_id: 2 }]);

    await enumeratePendingAlbumIds();

    const call = (db.execute as jest.Mock).mock.calls[0];
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/SELECT\s+DISTINCT\s+"?album_id"?/i);
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
});

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

describe('resolveAlbums', () => {
  it('returns an empty array without hitting the DB when given no ids', async () => {
    const out = await resolveAlbums([]);
    expect(out).toEqual([]);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
  });

  it('joins library + artists with COALESCE on artist_name and filters out null title', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' }]);

    await resolveAlbums([1]);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?library"?/i);
    expect(text).toMatch(/LEFT\s+JOIN\s+"?wxyc_schema"?\."?artists"?/i);
    expect(text).toMatch(/COALESCE\s*\(\s*a\."?artist_name"?\s*,\s*l\."?artist_name"?\s*\)/i);
    expect(text).toMatch(/l\."?title"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/=\s*ANY\(/i);
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

  it('forwards the resolved items + budgetMs to bulkLookupMetadata', async () => {
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
    expect(opts).toEqual({ budgetMs: 25000 });
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
    (db.execute as jest.Mock).mockResolvedValueOnce([]); // resolveAlbums → []
    const out = await runBatch([99999], { budgetMs: 25000, dryRun: false });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(out).toMatchObject({ batchSize: 0, match: 0 });
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
  liveActivityLookbackSeconds: 0, // disable pause for tests
  liveActivityPauseMs: 1,
  dryRun: false,
  ...over,
});

describe('runBackfill', () => {
  it('dry-run only enumerates and logs the planned batch count; no LML calls, no writes', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([1, 2, 3, 4, 5].map((album_id) => ({ album_id })));

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
    // First execute = enumerate → 5 ids.
    // Subsequent execute calls = resolveAlbums returning the same shape each.
    const resolved = [
      { album_id: 1, artist_name: 'A', album_title: 'X' },
      { album_id: 2, artist_name: 'B', album_title: 'Y' },
    ];
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([1, 2, 3, 4, 5].map((album_id) => ({ album_id })))
      // 3 resolves (3 batches), then post-pass calls (SET LOCAL + UPDATE)
      .mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce({}) // SET LOCAL
      .mockResolvedValueOnce([{ flipped: 0 }]);

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
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ album_id: 1 }]) // enumerate
      .mockResolvedValueOnce(resolved) // resolveAlbums
      .mockResolvedValueOnce({}) // SET LOCAL
      .mockResolvedValueOnce([{ flipped: 1234 }]); // post-pass UPDATE returning count

    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    const summary = await runBackfill(baseOptions({ batchSize: 1 }));

    expect(summary.flipped).toBe(1234);
    // Transaction was opened for the post-pass UPDATE.
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
  });

  it('skips ANALYZE when no UPSERTs landed (avoid pointless table-wide stats refresh)', async () => {
    const resolved = [{ album_id: 1, artist_name: 'A', album_title: 'X' }];
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ album_id: 1 }])
      .mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ flipped: 0 }]);
    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    await runBackfill(baseOptions({ batchSize: 1 }));

    const analyzeCall = findExecuteCallMatching(/ANALYZE/i);
    expect(analyzeCall).toBeUndefined();
  });

  it('runs ANALYZE when any UPSERT landed', async () => {
    const resolved = [{ album_id: 1, artist_name: 'A', album_title: 'X' }];
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ album_id: 1 }])
      .mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce({}) // ANALYZE
      .mockResolvedValueOnce({}) // SET LOCAL
      .mockResolvedValueOnce([{ flipped: 1 }]);
    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'match', lookup: lookupWithArtwork() }],
    });

    await runBackfill(baseOptions({ batchSize: 1 }));

    const analyzeCall = findExecuteCallMatching(/ANALYZE/i);
    expect(analyzeCall).toBeDefined();
  });
});
