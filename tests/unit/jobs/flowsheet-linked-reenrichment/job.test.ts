/**
 * Unit tests for the flowsheet-linked-reenrichment job (BS#1638).
 *
 * Covers the acceptance criteria: the frozen cohort predicate on every
 * SELECT/UPDATE, Lane A flip semantics (batched, no metadata_attempt_at
 * write), Lane B residual enumeration, the fill-null album_metadata UPSERT
 * (COALESCE + excluded, updated_at explicit NOW()), per-item LML failure
 * isolation, the BS#1088 result.index defense, idempotency, and dry-run.
 *
 * SQL is asserted via text inspection (same pattern as the donor
 * tests/unit/jobs/album-level-backfill/job.test.ts).
 */

import { jest } from '@jest/globals';

const mockBulkLookupMetadata = jest.fn<(items: unknown, opts?: unknown) => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  __esModule: true,
  bulkLookupMetadata: mockBulkLookupMetadata,
}));

jest.mock('@sentry/node', () => ({
  __esModule: true,
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  init: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import * as Sentry from '@sentry/node';
import { db, album_metadata, checkLiveActivity } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  COHORT_ADD_TIME_CUTOFF,
  countPopulatedFlipCandidates,
  flipBatch,
  flipPopulatedCohort,
  enumerateResidualAlbumIds,
  resolveAlbums,
  buildBulkItems,
  upsertAlbumMatchFillNull,
  analyzeFlowsheet,
  analyzeAlbumMetadata,
  awaitQuietWindow,
  runBatch,
  resolveDryRun,
  resolveOptions,
  runReenrichment,
  computeBulkTimeoutMs,
  BULK_BATCH_SIZE_DEFAULT,
  BULK_BATCH_SIZE_ENV,
  BULK_RATE_PER_MIN_DEFAULT,
  BULK_RATE_PER_MIN_ENV,
  BULK_BUDGET_MS_DEFAULT,
  BULK_PER_ITEM_TIMEOUT_MS,
  BULK_TIMEOUT_SLACK_MS,
  FLIP_BATCH_SIZE_DEFAULT,
  FLIP_BATCH_SIZE_ENV,
  FLIP_TIMEOUT_DEFAULT,
  READ_TIMEOUT_DEFAULT,
  ALBUM_AFTER_ID_ENV,
  LIVE_ACTIVITY_LOOKBACK_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_ENV,
  type ResolvedAlbum,
  type ReenrichmentOptions,
} from '../../../../jobs/flowsheet-linked-reenrichment/job';

// The unit drizzle-orm mock (tests/__mocks__/drizzle-orm.ts) shapes the `sql`
// tag as `{ sql: TemplateStringsArray, values }`. Interpolated values —
// including nested `sql` fragments like our shared `cohortPredicate` — live
// in `values`, NOT interleaved in `sql`. Interleave them and recurse so the
// composed WHERE renders. Bound scalars (numbers) render empty; assertions
// key off the literal SQL text, not param values.
const renderSql = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const obj = value as { raw?: string; sql?: string | string[]; values?: unknown[] };
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) {
    const strings = obj.sql;
    const values = obj.values ?? [];
    let out = '';
    for (let i = 0; i < strings.length; i += 1) {
      out += strings[i];
      if (i < values.length) out += renderSql(values[i]);
    }
    return out;
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined =>
  (db.execute as jest.Mock).mock.calls.find((call) => pattern.test(renderSql(call[0])));

const renderInsertChain = (): { valuesArg: unknown; conflictArg: unknown } => {
  const insertChain = (db as unknown as { _chain: Record<string, jest.Mock> })._chain;
  return {
    valuesArg: insertChain.values.mock.calls[0]?.[0],
    conflictArg: insertChain.onConflictDoUpdate.mock.calls[0]?.[0],
  };
};

const RESET_ENV_KEYS = [
  BULK_BATCH_SIZE_ENV,
  BULK_RATE_PER_MIN_ENV,
  FLIP_BATCH_SIZE_ENV,
  ALBUM_AFTER_ID_ENV,
  LIVE_ACTIVITY_LOOKBACK_ENV,
];
const stripEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out = { ...env };
  for (const k of RESET_ENV_KEYS) delete out[k];
  return out;
};

beforeEach(() => {
  jest.clearAllMocks();
  (checkLiveActivity as jest.Mock).mockResolvedValue(false);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const lookupWithArtwork = (overrides: Record<string, unknown> = {}): LookupResponse =>
  ({
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
  }) as LookupResponse;

// ---------------------------------------------------------------------------
// Frozen cohort predicate — every SELECT/UPDATE must carry all four clauses.
// ---------------------------------------------------------------------------

const expectCohortPredicate = (text: string): void => {
  expect(text).toMatch(/"?metadata_status"?\s*=\s*'enriched_no_match'/i);
  expect(text).toMatch(/"?album_id"?\s+IS\s+NOT\s+NULL/i);
  expect(text).toMatch(/"?artist_name"?\s+IS\s+NOT\s+NULL/i);
  expect(text).toMatch(/"?add_time"?\s*<\s*\$?\d*.*timestamptz/i);
  // No entry_type narrow — the frozen predicate is exactly four clauses.
  expect(text).not.toMatch(/entry_type/i);
};

describe('COHORT_ADD_TIME_CUTOFF', () => {
  it('is the frozen BS#1443 cutoff', () => {
    expect(COHORT_ADD_TIME_CUTOFF).toBe('2026-06-16T17:53:53Z');
  });
});

describe('countPopulatedFlipCandidates', () => {
  it('COUNTs cohort rows joined to populated album_metadata inside a timeout tx', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ count: 15231 }]);

    const n = await countPopulatedFlipCandidates();

    expect(n).toBe(15231);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    const call = findExecuteCallMatching(/count\(\*\)/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expectCohortPredicate(text);
    expect(text).toMatch(/JOIN\s+"?wxyc_schema"?\."?album_metadata"?/i);
    expect(text).toMatch(/am\."?discogs_url"?\s+IS\s+NOT\s+NULL\s+OR\s+am\."?artwork_url"?\s+IS\s+NOT\s+NULL/i);
    const setLocal = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(setLocal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lane A / Lane B flip.
// ---------------------------------------------------------------------------

describe('flipBatch', () => {
  it('UPDATEs flowsheet via JOIN to populated album_metadata, SET enriched_match, no metadata_attempt_at, batched', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const n = await flipBatch(5000, 60_000);

    expect(n).toBe(2);
    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expectCohortPredicate(text);
    expect(text).toMatch(/SET\s+"?metadata_status"?\s*=\s*'enriched_match'/i);
    expect(text).toMatch(/am\."?discogs_url"?\s+IS\s+NOT\s+NULL\s+OR\s+am\."?artwork_url"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/LIMIT/i);
    expect(text).toMatch(/ORDER\s+BY\s+f\."?id"?/i);
    // BS#1011/BS#895 invariant: the flip must not touch metadata_attempt_at.
    expect(text).not.toMatch(/metadata_attempt_at/i);
    // BS#1443 invariant: must not re-arm the cron by setting 'pending'.
    expect(text).not.toMatch(/'pending'/i);
  });

  it('runs inside a transaction with the parameterized statement timeout', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await flipBatch(5000, 123_456);
    const setLocal = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(renderSql(setLocal?.[0])).toMatch(/123456ms/);
  });
});

describe('flipPopulatedCohort', () => {
  it('loops flipBatch until a batch flips 0 rows and returns the total', async () => {
    const exec = db.execute as jest.Mock;
    // batch 1: SET LOCAL, UPDATE→3 rows; batch 2: SET LOCAL, UPDATE→0 rows.
    exec
      .mockResolvedValueOnce([]) // SET LOCAL
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]) // UPDATE
      .mockResolvedValueOnce([]) // SET LOCAL
      .mockResolvedValueOnce([]); // UPDATE → 0

    const total = await flipPopulatedCohort('lane_a', 5000, 60_000, 0, 1);

    expect(total).toBe(3);
    // Two flipBatch iterations = two transactions.
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(2);
  });

  it('checks the cooperative pause before each batch', async () => {
    const exec = db.execute as jest.Mock;
    exec.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // one empty batch
    await flipPopulatedCohort('lane_b', 5000, 60_000, 60, 1);
    // awaitQuietWindow → checkLiveActivity called at least once before the batch.
    expect((checkLiveActivity as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Lane B residual enumeration.
// ---------------------------------------------------------------------------

describe('enumerateResidualAlbumIds', () => {
  it('selects DISTINCT album_id for cohort rows with no populated album_metadata, cursored + ordered', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: 10 }, { album_id: 20 }]);

    const ids = await enumerateResidualAlbumIds(5, 90_000);

    expect(ids).toEqual([10, 20]);
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+f\."?album_id"?/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expectCohortPredicate(text);
    expect(text).toMatch(/LEFT\s+JOIN\s+"?wxyc_schema"?\."?album_metadata"?/i);
    // residual = absent OR both-null.
    expect(text).toMatch(
      /am\."?album_id"?\s+IS\s+NULL\s+OR\s+\(\s*am\."?discogs_url"?\s+IS\s+NULL\s+AND\s+am\."?artwork_url"?\s+IS\s+NULL/i
    );
    expect(text).toMatch(/f\."?album_id"?\s*>/i); // resume cursor
    expect(text).toMatch(/ORDER\s+BY\s+f\."?album_id"?/i);
    const setLocal = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(renderSql(setLocal?.[0])).toMatch(/90000ms/);
  });

  it('returns album_ids as numbers', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: '101' }, { album_id: 202 }]);
    expect(await enumerateResidualAlbumIds()).toEqual([101, 202]);
  });
});

// ---------------------------------------------------------------------------
// Resolution (copied from donor) — pin the load-bearing invariants.
// ---------------------------------------------------------------------------

describe('resolveAlbums', () => {
  it('returns empty without hitting the DB for no ids', async () => {
    expect(await resolveAlbums([])).toEqual([]);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
  });

  it('joins library+artists with COALESCE, binds the int[] array literal, drops both-null artists', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ album_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' }]);

    await resolveAlbums([1, 2, 3]);

    const call = findExecuteCallMatching(/FROM\s+"?wxyc_schema"?\."?library"?/i);
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/LEFT\s+JOIN\s+"?wxyc_schema"?\."?artists"?/i);
    expect(text).toMatch(/COALESCE\s*\(\s*a\."?artist_name"?\s*,\s*l\."?artist_name"?\s*\)\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/l\."?album_title"?\s+AS\s+album_title/i);
    expect(text).toMatch(/=\s*ANY\(/i);
    const values = (call?.[0] as { values?: unknown[] } | undefined)?.values ?? [];
    expect(values).toContain('{1,2,3}');
    expect(values).not.toContain(1);
  });
});

describe('buildBulkItems', () => {
  it('shapes each album into { artist, album, raw_message }', () => {
    const albums: ResolvedAlbum[] = [
      { album_id: 1, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ];
    expect(buildBulkItems(albums)).toEqual([
      {
        artist: 'Jessica Pratt',
        album: 'On Your Own Love Again',
        raw_message: 'Jessica Pratt - On Your Own Love Again',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fill-null album_metadata UPSERT.
// ---------------------------------------------------------------------------

describe('upsertAlbumMatchFillNull', () => {
  it('INSERTs the 10-column payload and fill-null COALESCEs each on conflict', async () => {
    const wrote = await upsertAlbumMatchFillNull(42, lookupWithArtwork());

    expect(wrote).toBe(true);
    expect(db.insert as jest.Mock).toHaveBeenCalledWith(album_metadata);
    const { valuesArg, conflictArg } = renderInsertChain();

    // INSERT path writes LML's values (the 6 absent-album case).
    expect(valuesArg).toMatchObject({
      album_id: 42,
      artwork_url: 'https://img.discogs.com/release/1.jpg',
      discogs_url: 'https://www.discogs.com/release/1',
      release_year: 2024,
      artist_bio: 'Bio with Stereolab markup.', // [a=...] stripped
      artist_wikipedia_url: 'https://en.wikipedia.org/wiki/X',
    });

    const set = (conflictArg as { set: Record<string, unknown> }).set;
    // Each of the 10 metadata columns is fill-null: COALESCE(existing, excluded).
    for (const col of [
      'artwork_url',
      'discogs_url',
      'release_year',
      'spotify_url',
      'apple_music_url',
      'youtube_music_url',
      'bandcamp_url',
      'soundcloud_url',
      'artist_bio',
      'artist_wikipedia_url',
    ]) {
      const rendered = renderSql(set[col]);
      expect(rendered).toMatch(/COALESCE/i);
      expect(rendered).toMatch(new RegExp(`excluded\\."${col}"`, 'i'));
    }
    // updated_at is explicit NOW(), never COALESCE'd (else the race guard freezes).
    expect(renderSql(set.updated_at)).toMatch(/NOW\(\)/i);
    expect(renderSql(set.updated_at)).not.toMatch(/COALESCE/i);
    // The 8 BS#1336 extended columns are absent from the set (never clobbered).
    for (const col of [
      'discogs_artist_id',
      'label',
      'full_release_date',
      'genres',
      'styles',
      'tracklist',
      'artist_image_url',
      'bio_tokens',
    ]) {
      expect(set[col]).toBeUndefined();
    }
    // Race guard.
    expect(renderSql((conflictArg as { setWhere: unknown }).setWhere)).toMatch(/<\s*NOW\(\)/i);
    expect((conflictArg as { target: unknown }).target).toBe(album_metadata.album_id);
  });

  it('drops spacer.gif artwork to null and coerces release_year=0 to null', async () => {
    await upsertAlbumMatchFillNull(
      42,
      lookupWithArtwork({ artwork_url: 'https://img.discogs.com/spacer.gif', release_year: 0 })
    );
    const { valuesArg } = renderInsertChain();
    expect(valuesArg).toMatchObject({ artwork_url: null, release_year: null });
  });

  it('returns false without writing when the top-1 has no artwork', async () => {
    expect(await upsertAlbumMatchFillNull(42, { results: [] } as LookupResponse)).toBe(false);
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ANALYZE.
// ---------------------------------------------------------------------------

describe('ANALYZE', () => {
  // BS#1638 prod run 1: ANALYZE ran on the raw connection under the @wxyc/database
  // 5s statement_timeout and was cancelled on the 2.6M-row flowsheet, aborting the
  // whole job after Lane A. Both ANALYZEs must run inside a transaction that raises
  // statement_timeout (mirroring the flip batches), and a stats-refresh failure must
  // never abort a completed data lane.
  it('analyzeFlowsheet issues ANALYZE flowsheet inside a raised-timeout transaction', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await analyzeFlowsheet(300_000);
    expect(renderSql(findExecuteCallMatching(/ANALYZE/i)?.[0])).toMatch(/flowsheet/i);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    expect(renderSql(findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i)?.[0])).toMatch(/300000ms/);
  });
  it('analyzeAlbumMetadata issues ANALYZE album_metadata inside a raised-timeout transaction', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await analyzeAlbumMetadata(300_000);
    expect(renderSql(findExecuteCallMatching(/ANALYZE/i)?.[0])).toMatch(/album_metadata/i);
    expect(renderSql(findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i)?.[0])).toMatch(/300000ms/);
  });
  it('is non-fatal: a failing ANALYZE is swallowed (a stats refresh must not abort a completed lane)', async () => {
    (db.transaction as jest.Mock).mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    await expect(analyzeFlowsheet(300_000)).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// awaitQuietWindow.
// ---------------------------------------------------------------------------

describe('awaitQuietWindow', () => {
  it('returns immediately when no activity', async () => {
    (checkLiveActivity as jest.Mock).mockResolvedValue(false);
    await awaitQuietWindow(60, 1);
    expect((checkLiveActivity as jest.Mock).mock.calls.length).toBe(1);
  });
  it('loops until the probe returns false', async () => {
    (checkLiveActivity as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await awaitQuietWindow(60, 1);
    expect((checkLiveActivity as jest.Mock).mock.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Lane B per-batch orchestration.
// ---------------------------------------------------------------------------

describe('runBatch', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockImplementation(() =>
      Promise.resolve([
        { album_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' },
        { album_id: 2, artist_name: 'Jessica Pratt', album_title: 'OYOLA' },
      ])
    );
  });

  it('dry-run calls neither LML nor the writer', async () => {
    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: true });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ match: 0, no_match: 0, lml_error: 0, db_error: 0, upserts: 0 });
  });

  it('forwards resolved items + budgetMs + dynamic timeout to bulkLookupMetadata', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'no_match', lookup: { results: [] } },
        { index: 1, status: 'no_match', lookup: { results: [] } },
      ],
    });
    await runBatch([1, 2], { budgetMs: 25000, dryRun: false });
    const [items, opts] = mockBulkLookupMetadata.mock.calls[0];
    expect(items).toEqual([
      { artist: 'Juana Molina', album: 'DOGA', raw_message: 'Juana Molina - DOGA' },
      { artist: 'Jessica Pratt', album: 'OYOLA', raw_message: 'Jessica Pratt - OYOLA' },
    ]);
    expect(opts).toEqual({
      budgetMs: 25000,
      timeoutMs: computeBulkTimeoutMs(2),
      caller: 'flowsheet-linked-reenrichment',
    });
  });

  it('counts match / no_match / lml_error and UPSERTs only matches', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'match', lookup: lookupWithArtwork() },
        { index: 1, status: 'error', lookup: null, message: 'TimeoutError' },
      ],
    });
    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: false });
    expect(out).toMatchObject({ match: 1, no_match: 0, lml_error: 1, upserts: 1 });
    expect((db.insert as jest.Mock).mock.calls.length).toBe(1);
  });

  it('an UPSERT throw is isolated as db_error and does not abort sibling writes', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'match', lookup: lookupWithArtwork() },
        { index: 1, status: 'match', lookup: lookupWithArtwork() },
      ],
    });
    // First insert throws, second succeeds. The mock's insert() returns the
    // chain; make the first call's terminal onConflictDoUpdate reject.
    let call = 0;
    (db.insert as jest.Mock).mockImplementation(() => {
      const thisCall = call++;
      const chain = (db as unknown as { _chain: Record<string, jest.Mock> })._chain;
      return {
        values: () => ({
          onConflictDoUpdate: () => (thisCall === 0 ? Promise.reject(new Error('boom')) : Promise.resolve(chain)),
        }),
      };
    });
    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: false });
    expect(out).toMatchObject({ match: 2, db_error: 1, upserts: 1 });
  });

  it('BS#1076: an HTTP-level bulkLookupMetadata throw counts the whole batch as lml_error', async () => {
    mockBulkLookupMetadata.mockRejectedValueOnce(
      Object.assign(new Error('LML request timed out'), { name: 'LmlClientError', statusCode: 504 })
    );
    const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: false });
    expect(out).toMatchObject({ batchSize: 2, match: 0, lml_error: 2, upserts: 0 });
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });

  it('short-circuits when resolveAlbums returns empty (orphaned album_ids)', async () => {
    (db.execute as jest.Mock).mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const out = await runBatch([99999], { budgetMs: 25000, dryRun: false });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(out).toMatchObject({ batchSize: 0, match: 0 });
  });

  describe('BS#1088 result.index defense', () => {
    it.each([
      {
        name: 'in-order',
        results: [
          { index: 0, status: 'match' as const, lookup: lookupWithArtwork() },
          { index: 1, status: 'match' as const, lookup: lookupWithArtwork() },
        ],
        expect: { match: 2, upserts: 2, unexpected_index: 0 },
      },
      {
        name: 'out-of-order',
        results: [
          { index: 1, status: 'match' as const, lookup: lookupWithArtwork() },
          { index: 0, status: 'match' as const, lookup: lookupWithArtwork() },
        ],
        expect: { match: 0, upserts: 0, unexpected_index: 2 },
      },
      {
        name: 'missing-index',
        results: [{ index: 0, status: 'match' as const, lookup: lookupWithArtwork() }],
        expect: { match: 1, upserts: 1, unexpected_index: 1 },
      },
    ])('parameterized: $name', async ({ results, expect: expected }) => {
      mockBulkLookupMetadata.mockResolvedValue({ results });
      const out = await runBatch([1, 2], { budgetMs: 25000, dryRun: false });
      expect(out.match).toBe(expected.match);
      expect(out.upserts).toBe(expected.upserts);
      expect(out.unexpected_index).toBe(expected.unexpected_index);
      expect((db.insert as jest.Mock).mock.calls.length).toBe(expected.upserts);
      // A non-zero unexpected_index must surface to Sentry with a stable
      // fingerprint (donor parity — the signal otherwise evaporates at exit).
      if (expected.unexpected_index > 0) {
        expect(Sentry.captureMessage as jest.Mock).toHaveBeenCalledWith(
          'flowsheet-linked-reenrichment.unexpected_index',
          expect.objectContaining({
            level: 'warning',
            fingerprint: ['flowsheet-linked-reenrichment', 'unexpected_index'],
          })
        );
      } else {
        expect(Sentry.captureMessage as jest.Mock).not.toHaveBeenCalled();
      }
    });
  });
});

describe('computeBulkTimeoutMs', () => {
  it('is linear in batchSize', () => {
    for (const n of [1, 5, 10, 20]) {
      expect(computeBulkTimeoutMs(n)).toBe(n * BULK_PER_ITEM_TIMEOUT_MS + BULK_TIMEOUT_SLACK_MS);
    }
  });
  it('keeps the default batch under one per-item budget + slack', () => {
    expect(computeBulkTimeoutMs(BULK_BATCH_SIZE_DEFAULT)).toBeLessThanOrEqual(
      BULK_BUDGET_MS_DEFAULT + BULK_TIMEOUT_SLACK_MS
    );
  });
});

// ---------------------------------------------------------------------------
// Flag + env resolution.
// ---------------------------------------------------------------------------

describe('resolveDryRun', () => {
  it('defaults to dry-run (true) when neither flag is passed', () => {
    expect(resolveDryRun([])).toBe(true);
  });
  it('is false only with --execute', () => {
    expect(resolveDryRun(['node', 'job.js', '--execute'])).toBe(false);
  });
  it('accepts --dry-run as an explicit no-op', () => {
    expect(resolveDryRun(['node', 'job.js', '--dry-run'])).toBe(true);
  });
  it('throws on contradictory flags', () => {
    expect(() => resolveDryRun(['--execute', '--dry-run'])).toThrow(/Contradictory/);
  });
});

describe('resolveOptions', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses defaults when env is unset', () => {
    const opts = resolveOptions(stripEnv(process.env), []);
    expect(opts.bulkBatchSize).toBe(BULK_BATCH_SIZE_DEFAULT);
    expect(opts.ratePerMin).toBe(BULK_RATE_PER_MIN_DEFAULT);
    expect(opts.flipBatchSize).toBe(FLIP_BATCH_SIZE_DEFAULT);
    expect(opts.flipTimeoutMs).toBe(FLIP_TIMEOUT_DEFAULT);
    expect(opts.readTimeoutMs).toBe(READ_TIMEOUT_DEFAULT);
    expect(opts.albumAfterId).toBe(0);
    expect(opts.liveActivityLookbackSeconds).toBe(LIVE_ACTIVITY_LOOKBACK_DEFAULT);
    expect(opts.dryRun).toBe(true);
  });

  it('honors env overrides and the resume cursor', () => {
    const env = {
      ...stripEnv(process.env),
      [BULK_BATCH_SIZE_ENV]: '10',
      [FLIP_BATCH_SIZE_ENV]: '2000',
      [ALBUM_AFTER_ID_ENV]: '500',
    };
    const opts = resolveOptions(env, ['--execute']);
    expect(opts.bulkBatchSize).toBe(10);
    expect(opts.flipBatchSize).toBe(2000);
    expect(opts.albumAfterId).toBe(500);
    expect(opts.dryRun).toBe(false);
  });

  it('allows LIVE_ACTIVITY_LOOKBACK_SECONDS=0 (catch-up)', () => {
    expect(
      resolveOptions({ ...stripEnv(process.env), [LIVE_ACTIVITY_LOOKBACK_ENV]: '0' }, []).liveActivityLookbackSeconds
    ).toBe(0);
  });

  it('throws on invalid env', () => {
    expect(() => resolveOptions({ ...stripEnv(process.env), [BULK_BATCH_SIZE_ENV]: '0' }, [])).toThrow(
      /positive integer/
    );
    expect(() => resolveOptions({ ...stripEnv(process.env), [FLIP_BATCH_SIZE_ENV]: '-1' }, [])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Top-level orchestration.
// ---------------------------------------------------------------------------

const baseOptions = (over: Partial<ReenrichmentOptions> = {}): ReenrichmentOptions => ({
  bulkBatchSize: 1,
  ratePerMin: 600,
  budgetMs: 25000,
  flipBatchSize: 5000,
  flipTimeoutMs: 60_000,
  readTimeoutMs: 300_000,
  albumAfterId: 0,
  liveActivityLookbackSeconds: 0,
  liveActivityPauseMs: 1,
  dryRun: false,
  ...over,
});

describe('runReenrichment', () => {
  it('dry-run: scope count + residual enumeration only, no LML, no writes, no flips', async () => {
    const exec = db.execute as jest.Mock;
    exec
      .mockResolvedValueOnce([]) // SET LOCAL (count)
      .mockResolvedValueOnce([{ count: 15231 }]) // count
      .mockResolvedValueOnce([]) // SET LOCAL (enumerate)
      .mockResolvedValueOnce([{ album_id: 1 }, { album_id: 2 }, { album_id: 3 }]); // residual

    const summary = await runReenrichment(baseOptions({ dryRun: true, bulkBatchSize: 2 }));

    expect(summary.lane_a_candidates).toBe(15231);
    expect(summary.residual_albums).toBe(3);
    expect(summary.batches).toBe(2);
    expect(summary.flipped_from_album_metadata).toBe(0);
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
    // No UPDATE...flowsheet (no flip) and no ANALYZE in dry-run.
    expect(findExecuteCallMatching(/UPDATE[\s\S]*flowsheet/i)).toBeUndefined();
    expect(findExecuteCallMatching(/ANALYZE/i)).toBeUndefined();
  });

  it('execute: Lane A flips first, Lane B re-looks-up, flipped total sums both lanes', async () => {
    const exec = db.execute as jest.Mock;
    exec
      .mockResolvedValueOnce([]) // SET LOCAL (count)
      .mockResolvedValueOnce([{ count: 2 }]) // count
      .mockResolvedValueOnce([]) // SET LOCAL (lane A flip batch 1)
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }]) // lane A UPDATE → 2
      .mockResolvedValueOnce([]) // SET LOCAL (lane A flip batch 2)
      .mockResolvedValueOnce([]) // lane A UPDATE → 0
      .mockResolvedValueOnce([]) // SET LOCAL (ANALYZE flowsheet, lane A)
      .mockResolvedValueOnce([]) // ANALYZE flowsheet (lane A)
      .mockResolvedValueOnce([]) // SET LOCAL (enumerate)
      .mockResolvedValueOnce([{ album_id: 7 }]) // residual → 1 album
      .mockResolvedValueOnce([]) // SET LOCAL (resolveAlbums)
      .mockResolvedValueOnce([{ album_id: 7, artist_name: 'Chuquimamani-Condori', album_title: 'Edits' }]) // resolve
      .mockResolvedValueOnce([]) // SET LOCAL (ANALYZE album_metadata)
      .mockResolvedValueOnce([]) // ANALYZE album_metadata
      .mockResolvedValueOnce([]) // SET LOCAL (lane B scope count)
      .mockResolvedValueOnce([{ count: 1 }]) // lane B scope count
      .mockResolvedValueOnce([]) // SET LOCAL (lane B flip batch 1)
      .mockResolvedValueOnce([{ id: 9 }]) // lane B UPDATE → 1
      .mockResolvedValueOnce([]) // SET LOCAL (lane B flip batch 2)
      .mockResolvedValueOnce([]) // lane B UPDATE → 0
      .mockResolvedValueOnce([]) // SET LOCAL (ANALYZE flowsheet, lane B)
      .mockResolvedValueOnce([]); // ANALYZE flowsheet (lane B)

    mockBulkLookupMetadata.mockResolvedValue({ results: [{ index: 0, status: 'match', lookup: lookupWithArtwork() }] });

    const summary = await runReenrichment(baseOptions({ bulkBatchSize: 1 }));

    expect(summary.lane_a_flipped).toBe(2);
    expect(summary.residual_albums).toBe(1);
    expect(summary.lml_match).toBe(1);
    expect(summary.upserts).toBe(1);
    expect(summary.lane_b_candidates).toBe(1);
    expect(summary.lane_b_flipped).toBe(1);
    expect(summary.flipped_from_album_metadata).toBe(3);
    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(1);
    expect((db.insert as jest.Mock).mock.calls.length).toBe(1);
  });

  it('execute: no residual matches → no Lane B flip, no album_metadata ANALYZE', async () => {
    const exec = db.execute as jest.Mock;
    exec
      .mockResolvedValueOnce([]) // SET LOCAL (count)
      .mockResolvedValueOnce([{ count: 0 }]) // count
      .mockResolvedValueOnce([]) // SET LOCAL (lane A flip batch 1)
      .mockResolvedValueOnce([]) // lane A UPDATE → 0
      .mockResolvedValueOnce([]) // SET LOCAL (enumerate)
      .mockResolvedValueOnce([{ album_id: 7 }]) // residual
      .mockResolvedValueOnce([]) // SET LOCAL (resolveAlbums)
      .mockResolvedValueOnce([{ album_id: 7, artist_name: 'A', album_title: 'B' }]); // resolve

    mockBulkLookupMetadata.mockResolvedValue({ results: [{ index: 0, status: 'no_match', lookup: { results: [] } }] });

    const summary = await runReenrichment(baseOptions({ bulkBatchSize: 1 }));

    expect(summary.lane_a_flipped).toBe(0);
    expect(summary.lml_no_match).toBe(1);
    expect(summary.upserts).toBe(0);
    // upserts=0 → the Lane B flip block (scope count + flip + ANALYZE) is skipped.
    expect(summary.lane_b_candidates).toBe(0);
    expect(summary.lane_b_flipped).toBe(0);
    expect(summary.flipped_from_album_metadata).toBe(0);
    // upserts=0 → album_metadata ANALYZE skipped.
    expect(findExecuteCallMatching(/ANALYZE\s+"?wxyc_schema"?\."?album_metadata"?/i)).toBeUndefined();
  });
});
