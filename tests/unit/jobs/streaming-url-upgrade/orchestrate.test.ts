/**
 * Unit tests for streaming-url-upgrade orchestrate.ts (BS#1672).
 *
 * Pins the behaviors the remediation depends on:
 *
 *   1. Candidate selection predicates for both phases — a row is a candidate
 *      iff spotify_url OR bandcamp_url is search-shaped (LIKE the provider
 *      search prefix). No apple_music_url / discogs signal (this job is
 *      shape-driven, not absence-driven).
 *      - album_metadata: (spotify_url LIKE … OR bandcamp_url LIKE …) AND the
 *        album_id cursor AND artist_name IS NOT NULL.
 *      - flowsheet: entry_type='track' AND the same OR-pair AND artist_name
 *        IS NOT NULL AND add_time >= cutoff AND the id cursor.
 *   2. Dry-run (the default mode wired by job.ts) performs LML lookups but
 *      ZERO writes; would_upgrade rows are counted per service.
 *   3. Multi-column: ONE lookup can upgrade both spotify and bandcamp on a
 *      single row via two independent guarded UPDATEs.
 *   4. Never-downgrade: a row that stopped being search-shaped between SELECT
 *      and UPDATE reports skipped_not_search (apply seam's LIKE guard), and
 *      extractStreamingUrls never surfaces a search→search "upgrade".
 *   5. Second-pass logic: a second LML lookup fires only when the first
 *      returned no verified URL for any still-pending column (LML#706 fill).
 *   6. Resumability: UPGRADE_*_AFTER_ID cursors narrow the SELECT; per-phase
 *      last_id resume cursors ride out on the run result.
 *   7. Error arms (lml_error row-level / db_error per-service) count and
 *      continue; loadBatch retry exhaustion flags failed=true.
 *   8. Cooperative pause and SIGTERM stop mirror the sibling backfills.
 */
import { jest } from '@jest/globals';

import { db, checkLiveActivity as mockCheckLiveActivity } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  BATCH_SIZE,
  FLOWSHEET_SINCE_DEFAULT,
  SECOND_PASS_DELAY_MS,
  requestStop,
  resolveAfterId,
  resolveBatchSize,
  resolveDryRun,
  resolveFlowsheetSince,
  resolveMaxRowsPerTable,
  resolveSecondPassDelayMs,
  runUpgrade,
  __resetStopForTesting,
  type ApplyFn,
  type LookupFn,
} from '../../../../jobs/streaming-url-upgrade/orchestrate';

type SqlLike = { sql?: string | string[]; values?: unknown[]; raw?: string };
/**
 * Render the tests/__mocks__/drizzle-orm.ts sql-tag shape ({ sql: strings,
 * values }) to a flat string, recursing into nested fragments and sql.raw
 * identifiers so predicate and cursor assertions can see the composed query.
 */
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) {
    const values = obj.values ?? [];
    return obj.sql.map((chunk, i) => chunk + (i < values.length ? renderSql(values[i]) : '')).join('');
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};

const SPOTIFY_SEARCH = 'https://open.spotify.com/search/Juana%20Molina%20DOGA';
const BANDCAMP_SEARCH = 'https://bandcamp.com/search?q=Juana%20Molina%20DOGA';
const SPOTIFY_VERIFIED = 'https://open.spotify.com/album/5aBcDeFgHiJkLmNoPqRsT';
const BANDCAMP_VERIFIED = 'https://juanamolina.bandcamp.com/album/doga';

const lookupResult = (spotify: string | null, bandcamp: string | null): LookupResponse => ({
  results: [
    {
      library_item: { id: 1 },
      artwork: {
        release_id: 100,
        release_url: 'https://www.discogs.com/release/100',
        spotify_url: spotify,
        bandcamp_url: bandcamp,
      },
    },
  ],
  search_type: 'direct',
});

/** Both columns resolve to verified links. */
const withBoth: LookupResponse = lookupResult(SPOTIFY_VERIFIED, BANDCAMP_VERIFIED);
/** Neither column resolves (still search-shaped upstream → coerced null). */
const withNeither: LookupResponse = lookupResult(null, null);
/** Only spotify resolves. */
const withSpotifyOnly: LookupResponse = lookupResult(SPOTIFY_VERIFIED, null);

const albumRow = (
  id: number,
  overrides: { artist?: string; album?: string; spotify_url?: string | null; bandcamp_url?: string | null } = {}
) => ({
  id,
  artist_name: overrides.artist ?? 'Juana Molina',
  album_title: overrides.album ?? 'DOGA',
  spotify_url: 'spotify_url' in overrides ? overrides.spotify_url : SPOTIFY_SEARCH,
  bandcamp_url: 'bandcamp_url' in overrides ? overrides.bandcamp_url : BANDCAMP_SEARCH,
});

const flowsheetRow = (
  id: number,
  overrides: {
    artist?: string;
    album?: string;
    track?: string;
    spotify_url?: string | null;
    bandcamp_url?: string | null;
  } = {}
) => ({
  id,
  artist_name: overrides.artist ?? 'Jessica Pratt',
  album_title: overrides.album ?? 'On Your Own Love Again',
  track_title: overrides.track ?? 'Back, Baby',
  spotify_url: 'spotify_url' in overrides ? overrides.spotify_url : SPOTIFY_SEARCH,
  bandcamp_url: 'bandcamp_url' in overrides ? overrides.bandcamp_url : BANDCAMP_SEARCH,
});

/**
 * Queue db.execute results in call order: phase A count, phase A batches
 * (until empty), phase B count, phase B batches (until empty).
 */
const queueExecute = (...results: unknown[]): void => {
  const mock = db.execute as jest.Mock;
  for (const result of results) {
    mock.mockResolvedValueOnce(result as never);
  }
};

/** Both phases empty — for tests that only exercise resolvers/edges. */
const emptyRun = (): void => {
  queueExecute([{ count: 0 }], [], [{ count: 0 }], []);
};

const baseOpts = (lookup: LookupFn, apply?: ApplyFn) => ({
  lookup,
  ...(apply ? { apply } : {}),
  dryRun: false,
  batchSize: 100,
  secondPassDelayMs: 0,
  liveActivityLookbackSeconds: 0,
});

describe('resolveDryRun', () => {
  it('defaults to dry-run when no flag is passed', () => {
    expect(resolveDryRun(['node', 'job.js'])).toBe(true);
  });

  it('explicit --dry-run stays dry-run', () => {
    expect(resolveDryRun(['node', 'job.js', '--dry-run'])).toBe(true);
  });

  it('--execute switches writes on', () => {
    expect(resolveDryRun(['node', 'job.js', '--execute'])).toBe(false);
  });

  it('throws on contradictory flags', () => {
    expect(() => resolveDryRun(['node', 'job.js', '--execute', '--dry-run'])).toThrow(/contradictory/i);
  });
});

describe('env resolvers', () => {
  it('resolveBatchSize falls back to BATCH_SIZE and parses positive integers', () => {
    expect(resolveBatchSize(undefined)).toBe(BATCH_SIZE);
    expect(resolveBatchSize('200')).toBe(200);
    expect(() => resolveBatchSize('0')).toThrow(/UPGRADE_BATCH_SIZE/);
  });

  it('resolveSecondPassDelayMs falls back to SECOND_PASS_DELAY_MS and accepts 0', () => {
    expect(resolveSecondPassDelayMs(undefined)).toBe(SECOND_PASS_DELAY_MS);
    expect(resolveSecondPassDelayMs('0')).toBe(0);
    expect(resolveSecondPassDelayMs('5000')).toBe(5000);
  });

  it('resolveMaxRowsPerTable defaults to 0 (unlimited) and accepts positive caps', () => {
    expect(resolveMaxRowsPerTable(undefined)).toBe(0);
    expect(resolveMaxRowsPerTable('250')).toBe(250);
  });

  it('resolveAfterId defaults to 0 and rejects negatives', () => {
    expect(resolveAfterId('UPGRADE_ALBUM_AFTER_ID', undefined)).toBe(0);
    expect(resolveAfterId('UPGRADE_ALBUM_AFTER_ID', '150')).toBe(150);
    expect(() => resolveAfterId('UPGRADE_ALBUM_AFTER_ID', '-1')).toThrow(/UPGRADE_ALBUM_AFTER_ID/);
  });

  it('resolveFlowsheetSince defaults and validates YYYY-MM-DD', () => {
    expect(resolveFlowsheetSince(undefined)).toBe(FLOWSHEET_SINCE_DEFAULT);
    expect(resolveFlowsheetSince('')).toBe(FLOWSHEET_SINCE_DEFAULT);
    expect(resolveFlowsheetSince('2026-01-15')).toBe('2026-01-15');
    expect(resolveFlowsheetSince('nonsense')).toBe(FLOWSHEET_SINCE_DEFAULT);
  });
});

describe('runUpgrade — candidate selection predicates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('album_metadata SELECT: (spotify_url LIKE OR bandcamp_url LIKE) search prefixes, no apple signal', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    await runUpgrade(baseOpts(lookup, apply));

    const batchSql = renderSql((db.execute as jest.Mock).mock.calls[1]?.[0]);
    expect(batchSql).toMatch(/album_metadata/);
    expect(batchSql).toMatch(/"spotify_url" LIKE/);
    expect(batchSql).toMatch(/"bandcamp_url" LIKE/);
    expect(batchSql).toMatch(/open\.spotify\.com\/search\//);
    expect(batchSql).toMatch(/bandcamp\.com\/search\?q=/);
    expect(batchSql).not.toMatch(/apple_music_url/);
    expect(batchSql).toMatch(/ORDER BY/);
  });

  it('flowsheet SELECT: entry_type=track AND OR-pair AND artist_name IS NOT NULL AND add_time cutoff', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    await runUpgrade({ ...baseOpts(lookup, apply), flowsheetSince: '2026-05-01' });

    const batchSql = renderSql((db.execute as jest.Mock).mock.calls[3]?.[0]);
    expect(batchSql).toMatch(/flowsheet/);
    expect(batchSql).toMatch(/entry_type.*track/s);
    expect(batchSql).toMatch(/"spotify_url" LIKE/);
    expect(batchSql).toMatch(/"bandcamp_url" LIKE/);
    expect(batchSql.toLowerCase()).toMatch(/artist_name.*is not null/s);
    expect(batchSql).toMatch(/add_time/);
    expect(batchSql).toMatch(/2026-05-01/);
  });

  it('count queries share the batch predicates and populate per-phase candidate totals', async () => {
    queueExecute([{ count: 7 }], [], [{ count: 3 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    const countASql = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(countASql).toMatch(/COUNT/i);
    expect(countASql).toMatch(/"spotify_url" LIKE/);
    expect(result.album_metadata.candidates).toBe(7);
    expect(result.flowsheet.candidates).toBe(3);
  });

  it('processes album_metadata fully before flowsheet', async () => {
    queueExecute(
      [{ count: 1 }],
      [albumRow(5, { artist: 'Stereolab', album: 'Aluminum Tunes' })],
      [],
      [{ count: 1 }],
      [flowsheetRow(9)],
      []
    );
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    await runUpgrade(baseOpts(lookup, apply));

    expect(lookup.mock.calls[0]?.[0]).toBe('Stereolab');
    expect(lookup.mock.calls[1]?.[0]).toBe('Jessica Pratt');
    expect(apply.mock.calls[0]?.[0]).toBe('album_metadata');
    expect(apply.mock.calls[apply.mock.calls.length - 1]?.[0]).toBe('flowsheet');
  });

  it('flowsheet lookups carry the row track_title', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledWith('Jessica Pratt', 'On Your Own Love Again', 'Back, Baby');
  });

  it('ID cursor advances across batches and the loop terminates on an empty batch', async () => {
    queueExecute([{ count: 3 }], [albumRow(10), albumRow(20)], [albumRow(30)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withNeither);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade({ ...baseOpts(lookup, apply), batchSize: 2 });

    const secondBatchSql = renderSql((db.execute as jest.Mock).mock.calls[2]?.[0]);
    expect(secondBatchSql).toMatch(/20/);
    expect(result.album_metadata.scanned).toBe(3);
    expect(result.album_metadata.last_id).toBe(30);
  });
});

describe('runUpgrade — multi-column upgrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('one lookup upgrades BOTH spotify and bandcamp on a row (two guarded UPDATEs)', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith('album_metadata', 5, 'spotify', SPOTIFY_VERIFIED);
    expect(apply).toHaveBeenCalledWith('album_metadata', 5, 'bandcamp', BANDCAMP_VERIFIED);
    expect(result.album_metadata.spotify.upgraded).toBe(1);
    expect(result.album_metadata.bandcamp.upgraded).toBe(1);
  });

  it('only upgrades the columns that were search-shaped on the row', async () => {
    // bandcamp already verified on the row → not a pending column; spotify search-shaped.
    queueExecute([{ count: 1 }], [albumRow(5, { bandcamp_url: BANDCAMP_VERIFIED })], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('album_metadata', 5, 'spotify', SPOTIFY_VERIFIED);
    expect(result.album_metadata.spotify.candidates).toBe(1);
    expect(result.album_metadata.bandcamp.candidates).toBe(0);
    expect(result.album_metadata.spotify.upgraded).toBe(1);
    expect(result.album_metadata.bandcamp.upgraded).toBe(0);
  });

  it('a lookup that resolves only spotify leaves bandcamp counted still_search', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withSpotifyOnly);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('album_metadata', 5, 'spotify', SPOTIFY_VERIFIED);
    expect(result.album_metadata.spotify.upgraded).toBe(1);
    expect(result.album_metadata.bandcamp.still_search).toBe(1);
  });
});

describe('runUpgrade — dry-run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('performs lookups but ZERO writes: would_upgrade counted per service', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);

    const result = await runUpgrade({
      lookup,
      dryRun: true,
      batchSize: 100,
      secondPassDelayMs: 0,
      liveActivityLookbackSeconds: 0,
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(db.update as jest.Mock).not.toHaveBeenCalled();
    expect(db.insert as jest.Mock).not.toHaveBeenCalled();
    expect(result.album_metadata.spotify.would_upgrade).toBe(1);
    expect(result.album_metadata.bandcamp.would_upgrade).toBe(1);
    expect(result.flowsheet.spotify.would_upgrade).toBe(1);
    expect(result.album_metadata.spotify.upgraded).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it('counts still_search rows in dry-run', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withNeither);

    const result = await runUpgrade({
      lookup,
      dryRun: true,
      batchSize: 100,
      secondPassDelayMs: 0,
      liveActivityLookbackSeconds: 0,
    });

    expect(db.update as jest.Mock).not.toHaveBeenCalled();
    expect(result.album_metadata.spotify.still_search).toBe(1);
    expect(result.album_metadata.bandcamp.still_search).toBe(1);
    expect(result.album_metadata.spotify.would_upgrade).toBe(0);
  });
});

describe('runUpgrade — second-pass logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('skips the second lookup when the first returns a URL', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.album_metadata.second_pass_attempts).toBe(0);
  });

  it('fires a second lookup when the first returns nothing; second URL upgrades', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValueOnce(withNeither).mockResolvedValueOnce(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.album_metadata.second_pass_attempts).toBe(1);
    expect(result.album_metadata.second_pass_resolved).toBe(1);
    expect(result.album_metadata.spotify.upgraded).toBe(1);
  });

  it('counts still_search when both passes return no URL', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withNeither);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.album_metadata.spotify.still_search).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('runUpgrade — dedup cache (keyed on artist+album+track)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('re-uses a resolved URL set for repeat (artist, album, track) triples', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 2 }], [flowsheetRow(9), flowsheetRow(11)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(4); // 2 rows × 2 columns
    expect(result.flowsheet.cache_hits).toBe(1);
    expect(result.flowsheet.spotify.upgraded).toBe(2);
  });

  it('does NOT share a URL across rows with different track titles', async () => {
    queueExecute(
      [{ count: 0 }],
      [],
      [{ count: 2 }],
      [
        flowsheetRow(9, { artist: 'Chuquimamani-Condori', album: 'Edits', track: 'Call Your Name' }),
        flowsheetRow(11, { artist: 'Chuquimamani-Condori', album: 'Edits', track: 'Prayer' }),
      ],
      []
    );
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.flowsheet.cache_hits).toBe(0);
  });

  it('caches a both-passes-null verdict so repeat triples skip LML entirely', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 2 }], [flowsheetRow(9), flowsheetRow(11)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withNeither);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(lookup).toHaveBeenCalledTimes(2); // two passes for row 9 only
    expect(result.flowsheet.cache_hits).toBe(1);
    expect(result.flowsheet.spotify.still_search).toBe(2);
  });
});

describe('runUpgrade — never-overwrite (raced verify)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('a row verified between SELECT and UPDATE reports skipped_not_search, not a write', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withSpotifyOnly);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('skipped_not_search');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(result.album_metadata.spotify.skipped_not_search).toBe(1);
    expect(result.album_metadata.spotify.upgraded).toBe(0);
  });
});

describe('runUpgrade — resumability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('albumAfterId and flowsheetAfterId narrow the respective SELECTs', async () => {
    queueExecute([{ count: 0 }], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    await runUpgrade({ ...baseOpts(lookup, apply), albumAfterId: 123, flowsheetAfterId: 456 });

    const albumBatchSql = renderSql((db.execute as jest.Mock).mock.calls[1]?.[0]);
    const flowsheetBatchSql = renderSql((db.execute as jest.Mock).mock.calls[3]?.[0]);
    expect(albumBatchSql).toMatch(/123/);
    expect(flowsheetBatchSql).toMatch(/456/);
  });

  it('maxRowsPerTable caps a phase but the next phase still runs', async () => {
    queueExecute([{ count: 3 }], [albumRow(10), albumRow(20), albumRow(30)], [{ count: 1 }], [flowsheetRow(9)], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade({ ...baseOpts(lookup, apply), maxRowsPerTable: 2 });

    expect(result.album_metadata.scanned).toBe(2);
    expect(result.album_metadata.last_id).toBe(20);
    expect(result.flowsheet.scanned).toBe(1);
  });
});

describe('runUpgrade — error arms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('lml_error: lookup throws → no apply, row-level counter increments, loop continues', async () => {
    queueExecute(
      [{ count: 2 }],
      [albumRow(5), albumRow(6, { artist: 'Sessa', album: 'Pequena Vertigem de Amor' })],
      [],
      [{ count: 0 }],
      []
    );
    const lookup = jest.fn<LookupFn>().mockRejectedValueOnce(new Error('LML timeout')).mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(result.album_metadata.lml_error).toBe(1);
    expect(result.album_metadata.spotify.upgraded).toBe(1);
    expect(result.album_metadata.scanned).toBe(2);
  });

  it('db_error: apply throws → per-service counter increments, loop continues', async () => {
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    // spotify UPDATE throws, bandcamp UPDATE succeeds
    const apply = jest
      .fn<ApplyFn>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(result.album_metadata.spotify.db_error).toBe(1);
    expect(result.album_metadata.bandcamp.upgraded).toBe(1);
    expect(result.album_metadata.scanned).toBe(1);
  });

  it('loadBatch retry exhaustion marks the run failed (exit-code path) without throwing', async () => {
    const err = new Error('sustained outage');
    (db.execute as jest.Mock).mockReset();
    (db.execute as jest.Mock).mockResolvedValueOnce([{ count: 1 }] as never);
    (db.execute as jest.Mock).mockRejectedValue(err as never);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(result.failed).toBe(true);
    expect(result.album_metadata.scanned).toBe(0);
  }, 30_000);
});

describe('runUpgrade — cooperative pause', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });

  it('defers when live activity is detected, continues when quiet', async () => {
    (mockCheckLiveActivity as jest.Mock).mockResolvedValueOnce(true as never).mockResolvedValue(false as never);
    queueExecute([{ count: 1 }], [albumRow(5)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade({
      ...baseOpts(lookup, apply),
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 0,
      checkLiveActivity: mockCheckLiveActivity,
    });

    expect((mockCheckLiveActivity as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.album_metadata.spotify.upgraded).toBe(1);
  });

  it('skips the probe when liveActivityLookbackSeconds=0', async () => {
    emptyRun();
    const lookup = jest.fn<LookupFn>().mockResolvedValue(withBoth);
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    await runUpgrade({ ...baseOpts(lookup, apply), checkLiveActivity: mockCheckLiveActivity });

    expect(mockCheckLiveActivity).not.toHaveBeenCalled();
  });
});

describe('runUpgrade — cooperative stop (SIGTERM)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStopForTesting();
  });
  afterEach(() => {
    __resetStopForTesting();
  });

  it('finishes the in-flight row then stops; result.stopped=true', async () => {
    queueExecute([{ count: 2 }], [albumRow(5), albumRow(6)], [], [{ count: 0 }], []);
    const lookup = jest.fn<LookupFn>().mockImplementation(() => {
      requestStop();
      return Promise.resolve(withBoth);
    });
    const apply = jest.fn<ApplyFn>().mockResolvedValue('upgraded');

    const result = await runUpgrade(baseOpts(lookup, apply));

    expect(result.stopped).toBe(true);
    expect(result.album_metadata.scanned).toBe(1);
    expect(result.album_metadata.spotify.upgraded).toBe(1);
  });
});
