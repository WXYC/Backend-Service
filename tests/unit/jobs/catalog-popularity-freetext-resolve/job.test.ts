/**
 * Unit tests for the catalog-popularity-freetext-resolve cron job
 * (BS#1491 / catalog-popularity Phase-2 Track 1).
 *
 * Covers: the DISTINCT enumerate SQL shape, JS-side normalized dedup, the
 * retry-eligibility filter (attempt-at + no-match TTL), LML batch handling
 * (match / no_match / error / index-mismatch), the race-guarded UPSERT shape
 * (including the discogs_master_id preservation rule), and the orchestrator.
 *
 * Uses the @wxyc/database mock and a jest.mock for @wxyc/lml-client so no
 * network or DB IO happens. SQL is asserted via text inspection, mirroring
 * tests/unit/jobs/album-level-backfill/job.test.ts.
 */

import { jest } from '@jest/globals';

const mockBulkLookupMetadata = jest.fn<(items: unknown, opts?: unknown) => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  __esModule: true,
  bulkLookupMetadata: mockBulkLookupMetadata,
}));

const mockSentryAddBreadcrumb = jest.fn<(b: unknown) => void>();
const mockSentryCaptureMessage = jest.fn<(msg: string, ctx?: unknown) => void>();
jest.mock('@sentry/node', () => ({
  __esModule: true,
  addBreadcrumb: mockSentryAddBreadcrumb,
  captureMessage: mockSentryCaptureMessage,
  init: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import { db, flowsheet_freetext_resolution } from '@wxyc/database';
import {
  enumerateFreetextPairs,
  normalizePairs,
  loadSkipKeys,
  filterEligible,
  pairKey,
  buildBulkItems,
  verdictFromLookup,
  upsertVerdict,
  checkLiveActivity,
  awaitQuietWindow,
  runBatch,
  resolveOptions,
  runResolve,
  computeBulkTimeoutMs,
  MATCH_SOURCE,
  BULK_BATCH_SIZE_DEFAULT,
  BULK_BATCH_SIZE_ENV,
  BULK_RATE_PER_MIN_DEFAULT,
  BULK_RATE_PER_MIN_ENV,
  BULK_BUDGET_MS_DEFAULT,
  BULK_BUDGET_MS_ENV,
  BULK_PER_ITEM_TIMEOUT_MS,
  BULK_TIMEOUT_SLACK_MS,
  NO_MATCH_TTL_DAYS_DEFAULT,
  NO_MATCH_TTL_DAYS_ENV,
  MAX_PAIRS_PER_RUN_DEFAULT,
  MAX_PAIRS_PER_RUN_ENV,
  READ_TIMEOUT_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_DEFAULT,
  LIVE_ACTIVITY_LOOKBACK_ENV,
  type NormalizedPair,
  type ResolveOptions,
} from '../../../../jobs/catalog-popularity-freetext-resolve/job';

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
  BULK_BUDGET_MS_ENV,
  NO_MATCH_TTL_DAYS_ENV,
  MAX_PAIRS_PER_RUN_ENV,
  LIVE_ACTIVITY_LOOKBACK_ENV,
];
const stripEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out = { ...env };
  for (const k of RESET_ENV_KEYS) delete out[k];
  return out;
};

// A lookup response carrying a real release (release_id > 0).
const lookupWithRelease = (releaseId = 12345, confidence = 0.91): { results: unknown[] } => ({
  results: [
    { artwork: { release_id: releaseId, release_url: `https://www.discogs.com/release/${releaseId}`, confidence } },
  ],
});

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

describe('enumerateFreetextPairs', () => {
  it('selects DISTINCT (artist_name, album_title) with the three required predicates', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ artist_name: 'J Dilla', album_title: 'Donuts' }]);

    await enumerateFreetextPairs();

    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+"?artist_name"?/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"?entry_type"?\s*=\s*'track'/i);
    expect(text).toMatch(/"?album_id"?\s+IS\s+NULL/i);
    expect(text).toMatch(/"?artist_name"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"?album_title"?\s+IS\s+NOT\s+NULL/i);
  });

  it('wraps the SELECT in a transaction + SET LOCAL statement_timeout', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs(99_000);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    const setLocalCall = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(renderSql(setLocalCall?.[0])).toMatch(/99000ms/);
  });

  it('maps rows to { artist, album }', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ artist_name: 'Kendrick Lamar', album_title: 'DAMN.' }]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'Kendrick Lamar', album: 'DAMN.' }]);
  });
});

// ---------------------------------------------------------------------------
// Normalized dedup.
// ---------------------------------------------------------------------------

describe('normalizePairs', () => {
  it('collapses edition variants of the same album to one normalized pair', () => {
    const out = normalizePairs([
      { artist: 'The Beach Boys', album: 'Pet Sounds' },
      { artist: 'Beach Boys', album: 'Pet Sounds (Remastered)' },
      { artist: 'beach boys', album: 'Pet Sounds - 2011 Remaster' },
    ]);
    // normalizeArtistName strips leading "The "; normalizeAlbumTitle strips
    // edition suffixes. All three collapse to (beach boys, pet sounds).
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ norm_artist: 'beach boys', norm_album: 'pet sounds' });
  });

  it('keeps the first raw pair as the representative for the LML lookup', () => {
    const out = normalizePairs([
      { artist: 'Beach Boys', album: 'Pet Sounds (Remastered)' },
      { artist: 'The Beach Boys', album: 'Pet Sounds' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ artist: 'Beach Boys', album: 'Pet Sounds (Remastered)' });
  });

  it('drops pairs whose normalized artist or album is empty', () => {
    const out = normalizePairs([
      { artist: '   ', album: 'Donuts' },
      { artist: 'J Dilla', album: '  ' },
      { artist: 'J Dilla', album: 'Donuts' },
    ]);
    expect(out).toEqual([{ norm_artist: 'j dilla', norm_album: 'donuts', artist: 'J Dilla', album: 'Donuts' }]);
  });

  it('keeps genuinely distinct albums as distinct pairs', () => {
    const out = normalizePairs([
      { artist: 'J Dilla', album: 'Donuts' },
      { artist: 'Kendrick Lamar', album: 'DAMN.' },
    ]);
    expect(out).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Retry-eligibility filter.
// ---------------------------------------------------------------------------

describe('loadSkipKeys', () => {
  it('queries resolved rows + no-match rows inside the TTL window', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ norm_artist: 'j dilla', norm_album: 'donuts' }]);
    const skip = await loadSkipKeys(30);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet_freetext_resolution"?/i);
    expect(text).toMatch(/"?attempt_at"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"?discogs_release_id"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"?attempt_at"?\s*>\s*now\(\)\s*-\s*\(interval/i);
    // Skip keys are JSON-encoded tuples (see `pairKey`), unambiguous even when
    // a normalized title contains spaces.
    expect(skip.has(pairKey('j dilla', 'donuts'))).toBe(true);
  });

  it('returns an empty set when no rows match', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    expect((await loadSkipKeys(30)).size).toBe(0);
  });
});

describe('filterEligible', () => {
  const pairs: NormalizedPair[] = [
    { norm_artist: 'j dilla', norm_album: 'donuts', artist: 'J Dilla', album: 'Donuts' },
    { norm_artist: 'kendrick lamar', norm_album: 'damn.', artist: 'Kendrick Lamar', album: 'DAMN.' },
  ];

  it('drops pairs whose key is in the skip set', () => {
    const out = filterEligible(pairs, new Set([pairKey('j dilla', 'donuts')]));
    expect(out).toEqual([pairs[1]]);
  });

  it('keeps all pairs when the skip set is empty', () => {
    expect(filterEligible(pairs, new Set())).toEqual(pairs);
  });
});

// ---------------------------------------------------------------------------
// Bulk item shape.
// ---------------------------------------------------------------------------

describe('buildBulkItems', () => {
  it('sends the RAW artist/album the DJ typed (not the normalized key)', () => {
    const items = buildBulkItems([
      {
        norm_artist: 'beach boys',
        norm_album: 'pet sounds',
        artist: 'The Beach Boys',
        album: 'Pet Sounds (Remastered)',
      },
    ]);
    expect(items).toEqual([
      {
        artist: 'The Beach Boys',
        album: 'Pet Sounds (Remastered)',
        raw_message: 'The Beach Boys - Pet Sounds (Remastered)',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Verdict extraction.
// ---------------------------------------------------------------------------

describe('verdictFromLookup', () => {
  const pair: NormalizedPair = { norm_artist: 'j dilla', norm_album: 'donuts', artist: 'J Dilla', album: 'Donuts' };

  it('extracts release_id (> 0) and confidence from the top artwork', () => {
    const v = verdictFromLookup(pair, lookupWithRelease(9999, 0.87));
    expect(v).toEqual({
      norm_artist: 'j dilla',
      norm_album: 'donuts',
      discogs_release_id: 9999,
      match_confidence: 0.87,
    });
  });

  it('treats release_id == 0 (BS#1185 streaming-only sentinel) as no usable release', () => {
    const v = verdictFromLookup(pair, lookupWithRelease(0));
    expect(v.discogs_release_id).toBeNull();
    expect(v.match_confidence).toBeNull();
  });

  it('returns a null verdict when there is no artwork', () => {
    const v = verdictFromLookup(pair, { results: [] });
    expect(v.discogs_release_id).toBeNull();
  });

  it('returns a null verdict when lookup is null', () => {
    const v = verdictFromLookup(pair, null);
    expect(v.discogs_release_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UPSERT.
// ---------------------------------------------------------------------------

describe('upsertVerdict', () => {
  it('UPSERTs a match: release id + confidence + match_source, attempt_at + resolved_at stamped', async () => {
    await upsertVerdict({
      norm_artist: 'j dilla',
      norm_album: 'donuts',
      discogs_release_id: 9999,
      match_confidence: 0.9,
    });
    expect(db.insert as jest.Mock).toHaveBeenCalledWith(flowsheet_freetext_resolution);
    const { valuesArg, conflictArg } = renderInsertChain();
    expect(valuesArg).toMatchObject({
      norm_artist: 'j dilla',
      norm_album: 'donuts',
      discogs_release_id: 9999,
      match_confidence: 0.9,
      match_source: MATCH_SOURCE,
    });
    // Composite-PK conflict target.
    expect((conflictArg as { target: unknown[] }).target).toEqual([
      flowsheet_freetext_resolution.norm_artist,
      flowsheet_freetext_resolution.norm_album,
    ]);
    // attempt_at stamped to now() on both insert and update.
    expect(renderSql((valuesArg as { attempt_at: unknown }).attempt_at)).toMatch(/now\(\)/i);
    expect(renderSql((valuesArg as { resolved_at: unknown }).resolved_at)).toMatch(/now\(\)/i);
    const setArg = (conflictArg as { set: Record<string, unknown> }).set;
    expect(renderSql(setArg.attempt_at)).toMatch(/now\(\)/i);
  });

  it('UPSERTs a no-match: null release id, resolved_at null, attempt_at still stamped', async () => {
    await upsertVerdict({
      norm_artist: 'j dilla',
      norm_album: 'donuts',
      discogs_release_id: null,
      match_confidence: null,
    });
    const { valuesArg } = renderInsertChain();
    expect(valuesArg).toMatchObject({ discogs_release_id: null, resolved_at: null });
    expect(renderSql((valuesArg as { attempt_at: unknown }).attempt_at)).toMatch(/now\(\)/i);
  });

  it('does NOT write discogs_master_id (preserves a later Track-0 write)', async () => {
    await upsertVerdict({
      norm_artist: 'j dilla',
      norm_album: 'donuts',
      discogs_release_id: 9999,
      match_confidence: 0.9,
    });
    const { valuesArg, conflictArg } = renderInsertChain();
    expect(valuesArg).not.toHaveProperty('discogs_master_id');
    const setArg = (conflictArg as { set: Record<string, unknown> }).set;
    expect(setArg).not.toHaveProperty('discogs_master_id');
  });
});

// ---------------------------------------------------------------------------
// Cooperative pause.
// ---------------------------------------------------------------------------

describe('checkLiveActivity / awaitQuietWindow', () => {
  it('checkLiveActivity returns false and skips the DB when lookbackSeconds <= 0', async () => {
    expect(await checkLiveActivity(0)).toBe(false);
    expect(db.execute as jest.Mock).not.toHaveBeenCalled();
  });

  it('checkLiveActivity returns true when the probe returns rows', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{}]);
    expect(await checkLiveActivity(60)).toBe(true);
  });

  it('awaitQuietWindow loops until the probe returns empty', async () => {
    const probe = db.execute as jest.Mock;
    probe.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    await awaitQuietWindow(60, 1);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Per-batch orchestration.
// ---------------------------------------------------------------------------

const pairA: NormalizedPair = { norm_artist: 'j dilla', norm_album: 'donuts', artist: 'J Dilla', album: 'Donuts' };
const pairB: NormalizedPair = {
  norm_artist: 'kendrick lamar',
  norm_album: 'damn.',
  artist: 'Kendrick Lamar',
  album: 'DAMN.',
};

describe('runBatch', () => {
  it('dry-run does not call LML or the writer', async () => {
    const out = await runBatch([pairA, pairB], { budgetMs: 25000, dryRun: true });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ match: 0, no_match: 0, error: 0, upserts: 0 });
  });

  it('forwards items + budgetMs + dynamic timeoutMs + caller to bulkLookupMetadata', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'no_match', lookup: { results: [] } },
        { index: 1, status: 'no_match', lookup: { results: [] } },
      ],
    });
    await runBatch([pairA, pairB], { budgetMs: 25000, dryRun: false });
    const [items, opts] = mockBulkLookupMetadata.mock.calls[0];
    expect(items).toEqual([
      { artist: 'J Dilla', album: 'Donuts', raw_message: 'J Dilla - Donuts' },
      { artist: 'Kendrick Lamar', album: 'DAMN.', raw_message: 'Kendrick Lamar - DAMN.' },
    ]);
    expect(opts).toEqual({
      budgetMs: 25000,
      timeoutMs: computeBulkTimeoutMs(2),
      caller: 'catalog-popularity-freetext-resolve',
    });
  });

  it('UPSERTs both match and no_match (both are responded outcomes); counts error separately', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'match', lookup: lookupWithRelease() },
        { index: 1, status: 'no_match', lookup: { results: [] } },
      ],
    });
    const out = await runBatch([pairA, pairB], { budgetMs: 25000, dryRun: false });
    expect(out).toMatchObject({ match: 1, no_match: 1, error: 0, upserts: 2 });
    expect((db.insert as jest.Mock).mock.calls.length).toBe(2);
  });

  it('does NOT UPSERT a per-item error (leaves it attempt_at IS NULL → retried)', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 0, status: 'error', lookup: null, message: 'BoomError' },
        { index: 1, status: 'match', lookup: lookupWithRelease() },
      ],
    });
    const out = await runBatch([pairA, pairB], { budgetMs: 25000, dryRun: false });
    expect(out).toMatchObject({ error: 1, match: 1, upserts: 1 });
    expect((db.insert as jest.Mock).mock.calls.length).toBe(1);
  });

  it('BS#1076-style: an HTTP-level throw counts the whole batch as error and writes nothing', async () => {
    mockBulkLookupMetadata.mockRejectedValueOnce(
      Object.assign(new Error('LML timed out'), { name: 'LmlClientError', statusCode: 504 })
    );
    const out = await runBatch([pairA, pairB], { budgetMs: 25000, dryRun: false });
    expect(out).toMatchObject({ batchSize: 2, match: 0, no_match: 0, error: 2, upserts: 0 });
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });

  it('skips writes on a result.index mismatch and counts unexpected_index', async () => {
    mockBulkLookupMetadata.mockResolvedValue({
      results: [
        { index: 1, status: 'match', lookup: lookupWithRelease() },
        { index: 0, status: 'match', lookup: lookupWithRelease() },
      ],
    });
    const out = await runBatch([pairA, pairB], { budgetMs: 25000, dryRun: false });
    expect(out).toMatchObject({ match: 0, upserts: 0, unexpected_index: 2 });
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      'catalog-popularity-freetext-resolve.unexpected_index',
      expect.objectContaining({ fingerprint: ['catalog-popularity-freetext-resolve', 'unexpected_index'] })
    );
  });
});

// ---------------------------------------------------------------------------
// computeBulkTimeoutMs.
// ---------------------------------------------------------------------------

describe('computeBulkTimeoutMs', () => {
  it('is linear in batchSize', () => {
    for (const n of [1, 5, 10, 50, 100]) {
      expect(computeBulkTimeoutMs(n)).toBe(n * BULK_PER_ITEM_TIMEOUT_MS + BULK_TIMEOUT_SLACK_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// Option resolution.
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
    expect(opts.noMatchTtlDays).toBe(NO_MATCH_TTL_DAYS_DEFAULT);
    expect(opts.maxPairsPerRun).toBe(MAX_PAIRS_PER_RUN_DEFAULT);
    expect(opts.readTimeoutMs).toBe(READ_TIMEOUT_DEFAULT);
    expect(opts.liveActivityLookbackSeconds).toBe(LIVE_ACTIVITY_LOOKBACK_DEFAULT);
    expect(opts.dryRun).toBe(false);
  });

  it('honors env overrides', () => {
    const env = {
      ...stripEnv(process.env),
      [BULK_BATCH_SIZE_ENV]: '10',
      [NO_MATCH_TTL_DAYS_ENV]: '7',
      [MAX_PAIRS_PER_RUN_ENV]: '0',
    };
    const opts = resolveOptions(env, []);
    expect(opts.batchSize).toBe(10);
    expect(opts.noMatchTtlDays).toBe(7);
    expect(opts.maxPairsPerRun).toBe(0); // 0 allowed (non-negative) → disables cap
  });

  it('throws on invalid batch size', () => {
    expect(() => resolveOptions({ ...stripEnv(process.env), [BULK_BATCH_SIZE_ENV]: '0' }, [])).toThrow();
  });

  it('detects --dry-run', () => {
    expect(resolveOptions(stripEnv(process.env), ['node', 'job.js', '--dry-run']).dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Top-level orchestration.
// ---------------------------------------------------------------------------

const baseOptions = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({
  batchSize: 2,
  ratePerMin: 600,
  budgetMs: 25000,
  noMatchTtlDays: 30,
  maxPairsPerRun: 0,
  readTimeoutMs: 300_000,
  liveActivityLookbackSeconds: 0,
  liveActivityPauseMs: 1,
  dryRun: false,
  ...over,
});

describe('runResolve', () => {
  // enumerate is tx-wrapped (SET LOCAL + SELECT = 2 mock values); loadSkipKeys
  // is a single execute. Helpers keep the queue declarations readable.
  const enumerateResult = (rows: unknown[]): [unknown, unknown] => [{}, rows];

  it('dry-run enumerates, normalizes, filters, and reports the plan without LML calls or writes', async () => {
    const mock = db.execute as jest.Mock;
    mock
      .mockResolvedValueOnce({}) // SET LOCAL
      .mockResolvedValueOnce([
        { artist_name: 'J Dilla', album_title: 'Donuts' },
        { artist_name: 'Kendrick Lamar', album_title: 'DAMN.' },
        { artist_name: 'The Beach Boys', album_title: 'Pet Sounds' },
      ])
      .mockResolvedValueOnce([]); // loadSkipKeys

    const summary = await runResolve(baseOptions({ dryRun: true, batchSize: 2 }));

    expect(summary).toMatchObject({ scanned: 3, eligible: 3, processed: 3, batches: 2 });
    expect(mockBulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
  });

  it('skips already-resolved pairs via loadSkipKeys', async () => {
    const mock = db.execute as jest.Mock;
    for (const v of enumerateResult([
      { artist_name: 'J Dilla', album_title: 'Donuts' },
      { artist_name: 'Kendrick Lamar', album_title: 'DAMN.' },
    ])) {
      mock.mockResolvedValueOnce(v);
    }
    mock.mockResolvedValueOnce([{ norm_artist: 'j dilla', norm_album: 'donuts' }]); // skip donuts

    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    const summary = await runResolve(baseOptions({ batchSize: 5 }));

    expect(summary.scanned).toBe(2);
    expect(summary.eligible).toBe(1); // donuts skipped
    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(1);
    const [items] = mockBulkLookupMetadata.mock.calls[0];
    expect((items as unknown[]).length).toBe(1);
  });

  it('chunks eligible pairs by batchSize and aggregates verdicts', async () => {
    const mock = db.execute as jest.Mock;
    for (const v of enumerateResult([
      { artist_name: 'A', album_title: 'X' },
      { artist_name: 'B', album_title: 'Y' },
      { artist_name: 'C', album_title: 'Z' },
    ])) {
      mock.mockResolvedValueOnce(v);
    }
    mock.mockResolvedValueOnce([]); // loadSkipKeys empty

    mockBulkLookupMetadata
      .mockResolvedValueOnce({
        results: [
          { index: 0, status: 'match', lookup: lookupWithRelease(1) },
          { index: 1, status: 'no_match', lookup: { results: [] } },
        ],
      })
      .mockResolvedValueOnce({ results: [{ index: 0, status: 'match', lookup: lookupWithRelease(3) }] });

    const summary = await runResolve(baseOptions({ batchSize: 2 }));

    expect(summary.batches).toBe(2);
    expect(summary.match).toBe(2);
    expect(summary.no_match).toBe(1);
    expect(summary.upserts).toBe(3);
    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(2);
  });

  it('caps processing at maxPairsPerRun but reports the full eligible count', async () => {
    const mock = db.execute as jest.Mock;
    for (const v of enumerateResult([
      { artist_name: 'A', album_title: 'X' },
      { artist_name: 'B', album_title: 'Y' },
      { artist_name: 'C', album_title: 'Z' },
    ])) {
      mock.mockResolvedValueOnce(v);
    }
    mock.mockResolvedValueOnce([]); // loadSkipKeys empty

    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    const summary = await runResolve(baseOptions({ batchSize: 1, maxPairsPerRun: 2 }));

    expect(summary.eligible).toBe(3);
    expect(summary.processed).toBe(2);
    expect(summary.batches).toBe(2);
    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(2);
  });
});
