/**
 * streaming-columns-drain — one-shot heal for the BS#2295 frozen cohort.
 *
 * ## The cohort
 *
 * An `album_metadata` row that carries a load-bearing Discogs match
 * (`artwork_url` OR `discogs_url` non-null) but has ALL FIVE streaming URL
 * columns NULL. Before BS#2295's forward fix, `precheck.ts` skipped the LML
 * call for such a row and `finalizeFromCachedMetadata` stamped the flowsheet
 * row terminal (`enriched_match`) without ever writing those columns, so
 * every client read "this album is enriched" alongside five permanent nulls.
 *
 * The forward fix (merged, PR #2298) stops the bleeding: the pre-check gate
 * now also requires at least one streaming URL, so a cohort row falls through
 * to LML the next time its album is PLAYED. This job is the other half —
 * the standing backlog does not heal on its own:
 *
 *   - the CDC consumer fires on flowsheet INSERT only;
 *   - `enrichment-worker/sweep.ts` targets stranded `enriching` claims;
 *   - `streaming-reask.ts`'s hourly sweep keys on an `'unresolved'` streaming
 *     STATUS, and this cohort has all three status columns NULL — it was
 *     never asked, so there is no verdict to re-open (see that file's header);
 *   - `flowsheet-metadata-backfill`'s cron keys on `metadata_attempt_at IS
 *     NULL`, and these rows have been attempted.
 *
 * So an album in this shape that is never played again stays frozen forever.
 * Hence a drain.
 *
 * ## What it writes, and what it deliberately does not
 *
 * ONLY the five streaming URL columns, and only where they are NULL. The
 * identity columns (`artwork_url`, `discogs_url`, `release_year`, the bio
 * fields) are never touched. That is not timidity — it is the load-bearing
 * safety property of this job. LML resolves by SEARCH, so a lookup for
 * "Funkadelic / Hardcore Jollies" can legitimately land on a DIFFERENT
 * catalog release, and writing that release's artwork over ours would put one
 * album's identity on another (the failure mode `reference_bs_prod_db_...`
 * documents, where a 102-album run caught exactly one such mis-resolution).
 * By writing only streaming URLs we keep the blast radius to a wrong link
 * rather than a wrong album, and the three synthesized URLs below are derived
 * from OUR OWN `library` text, so they cannot be mis-resolved at all.
 *
 * Per-column policy, matching `enrich.ts`'s write arms exactly:
 *
 *   - `youtube_music_url` / `bandcamp_url` / `soundcloud_url` — ALWAYS
 *     written: LML's verified URL when present, else the synthesized search
 *     URL from `@wxyc/metadata#synthesizeSearchUrls`. This is what guarantees
 *     every drained row leaves the cohort, including on a `no_match`.
 *   - `spotify_url` / `apple_music_url` — written ONLY when LML returns a
 *     real one. There is deliberately no synthesized fallback for these two
 *     (BS#1184 / BS#1192): persisting a keyword-search URL would launder
 *     "we could not verify a match" into a clickable button. They are filled
 *     at READ time by the proxy controller instead.
 *
 * Known consequence, and it is pre-existing rather than introduced here: the
 * V2 flowsheet feed is a plain `coalesce(album_metadata.X, flowsheet.X)`
 * (`apps/backend/utils/album-metadata-projection.ts`) and does NOT synthesize
 * spotify/apple at read time the way `/proxy/metadata/album` does. So a
 * drained album for which LML has no verified Spotify or Apple link still
 * serves null for those two on the V2 feed, and iOS still greys those two
 * buttons. Fixing THAT asymmetry is a read-path change, not a data change,
 * and belongs in its own ticket.
 *
 * ## Safety
 *
 * Dry-run is the DEFAULT; writes require `--execute` (the newer sibling
 * convention from `streaming-url-upgrade` / `streaming-url-remediation`, not
 * `album-level-backfill`'s older `--dry-run` opt-in). The cohort predicate is
 * defined ONCE in `cohortPredicateSql` and reused verbatim by the
 * before-count, the enumeration, the per-row UPDATE's WHERE, and the
 * after-count, so those four can never drift. Re-asserting it inside the
 * UPDATE is the TOCTOU guard: if the live worker filled a streaming column
 * between enumeration and write, the UPDATE matches zero rows and the row is
 * counted `skipped_raced` rather than overwritten.
 *
 * @see WXYC/Backend-Service#2295
 * @see WXYC/Backend-Service#1747 (the pre-check this cohort was frozen by)
 * @see WXYC/Backend-Service#1915 (the sibling bounded self-heal, which cannot reach this cohort)
 */

import { sql } from 'drizzle-orm';
import { closeDatabaseConnection, db, requireNonNegativeInt, requirePositiveInt } from '@wxyc/database';
import { bulkLookupMetadata, type BulkLookupItem, type LookupResponse } from '@wxyc/lml-client';
import { normalizeLookup, synthesizeSearchUrls, type MetadataFallbacks } from '@wxyc/metadata';
import * as Sentry from '@sentry/node';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'streaming-columns-drain';

// -- Knobs -------------------------------------------------------------------

/** Items per LML bulk request. LML hard-caps at 100; 5 is the BS#1197
 * empirical ceiling under live `enrichment-worker` contention — larger
 * batches raise the per-batch timeout rate faster than they raise
 * throughput. */
export const BATCH_SIZE_ENV = 'DRAIN_BULK_BATCH_SIZE';
export const BATCH_SIZE_DEFAULT = 5;

/** Batches per minute. At the default batch size, 1/min is ~5 albums/min. */
export const RATE_PER_MIN_ENV = 'DRAIN_BULK_RATE_PER_MIN';
export const RATE_PER_MIN_DEFAULT = 1;

/** Per-item budget forwarded to LML as `X-Caller-Budget-Ms`. This job is a
 * batch drain, not the live lane, so it keeps the header (BS#1914 / #1978). */
export const BUDGET_MS_ENV = 'DRAIN_BULK_BUDGET_MS';
export const BUDGET_MS_DEFAULT = 25_000;

/** Statement timeout for the enumeration scan and the count queries. */
export const READ_TIMEOUT_ENV = 'DRAIN_READ_TIMEOUT_MS';
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Stop after this many albums. `0` means "no cap". Exists so the first
 * production firing can be a bounded canary (e.g. `DRAIN_MAX_ALBUMS=25`)
 * before committing to the full cohort. */
export const MAX_ALBUMS_ENV = 'DRAIN_MAX_ALBUMS';
export const MAX_ALBUMS_DEFAULT = 0;

/** Cooperative-pause lookback. If a flowsheet track row landed within this
 * many seconds, a DJ is live — defer. `0` disables the probe. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 300;

export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

/** Per-item slice of the bulk fetch timeout, plus fixed slack. Mirrors
 * `album-level-backfill`: the shared LML client's 30s default would otherwise
 * fire mid-batch on a cascade-heavy chunk (BS#1178). */
export const PER_ITEM_TIMEOUT_MS = 5_000;
export const TIMEOUT_SLACK_MS = 5_000;
export const computeBulkTimeoutMs = (batchSize: number): number => batchSize * PER_ITEM_TIMEOUT_MS + TIMEOUT_SLACK_MS;

// -- The cohort predicate ----------------------------------------------------

/**
 * The BS#2295 frozen shape, as ONE definition. Reused verbatim by the
 * before/after counts, the enumeration, and the UPDATE's WHERE clause so
 * those four can never drift apart — the same discipline
 * `streaming-url-remediation` applies to its candidate net.
 *
 * Load-bearing match present, and every one of the five streaming URL
 * columns null. Note this is the exact complement of the `hasAnyStreamingUrl`
 * conjunct added to `apps/enrichment-worker/precheck.ts` by the forward fix:
 * a row matching here is precisely a row that predicate now refuses to skip.
 *
 * Parameterized by table alias so the joined enumeration and the bare counts
 * share one source of truth without string surgery on the result.
 */
export const COHORT_COLUMNS = [
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
  'bandcamp_url',
  'soundcloud_url',
] as const;

export const cohortPredicateSql = (alias = ''): string => {
  const q = (col: string) => (alias ? `${alias}."${col}"` : `"${col}"`);
  return [
    `(${q('artwork_url')} IS NOT NULL OR ${q('discogs_url')} IS NOT NULL)`,
    ...COHORT_COLUMNS.map((col) => `${q(col)} IS NULL`),
  ].join('\n       AND ');
};

/** Count the cohort. Run before the drain and again after, per BS#2295's
 * "catalog-wide count of the frozen shape reported before and after". */
export const countCohort = async (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<number> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(
      sql.raw(`SELECT count(*)::int AS n FROM "wxyc_schema"."album_metadata" WHERE ${cohortPredicateSql()}`)
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  });
};

export interface DrainCandidate {
  album_id: number;
  artist_name: string;
  album_title: string;
}

/**
 * Enumerate the cohort joined to its lookup keys in ONE query.
 *
 * `library.artist_name` is nullable (denormalized, "nullable until A.2"), so
 * the canonical `artists.artist_name` is preferred and the
 * `COALESCE(...) IS NOT NULL` guard drops rows where both sides are null —
 * without it `String(null)` would be POSTed to LML as the literal `"null"`.
 *
 * `discogs_unavailable = false` is the same primary bulk-path gate
 * `album-level-backfill#resolveAlbums` applies (BS#1294): an MD has marked
 * these albums as not-on-Discogs, so asking LML about them burns quota for a
 * guaranteed no-match. They keep their five nulls, deliberately.
 *
 * Ordered by `album_id` so a resumed run after an abort covers the same
 * ground in the same order.
 */
export const enumerateCohort = async (
  limit: number,
  timeoutMs: number = READ_TIMEOUT_DEFAULT
): Promise<DrainCandidate[]> => {
  const limitClause = limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(
      sql.raw(`
        SELECT am."album_id" AS album_id,
               COALESCE(a."artist_name", l."artist_name") AS artist_name,
               l."album_title" AS album_title
        FROM "wxyc_schema"."album_metadata" am
        JOIN "wxyc_schema"."library" l ON l."id" = am."album_id"
        LEFT JOIN "wxyc_schema"."artists" a ON l."artist_id" = a."id"
        WHERE ${cohortPredicateSql('am')}
          AND COALESCE(a."artist_name", l."artist_name") IS NOT NULL
          AND l."discogs_unavailable" = false
        ORDER BY am."album_id"
        ${limitClause}
      `)
    )) as unknown as Array<{ album_id: number; artist_name: string; album_title: string }>;
    return rows.map((r) => ({
      album_id: Number(r.album_id),
      artist_name: String(r.artist_name),
      album_title: String(r.album_title),
    }));
  });
};

// -- The fill ----------------------------------------------------------------

export interface StreamingFill {
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string;
  bandcamp_url: string;
  soundcloud_url: string;
}

/**
 * Compute the five streaming URLs for one album.
 *
 * `lookup === null` is the no-match / error case and is a first-class outcome,
 * not a failure: `normalizeLookup`'s no-artwork branch still returns the three
 * synthesized search URLs, so the row still leaves the cohort. That mirrors
 * `enrich.ts`'s linked no-match arm, which writes the same three.
 *
 * The three synthesized URLs are a pure function of our own `library` text, so
 * they are immune to LML resolving a different release. Spotify and Apple come
 * from LML or stay null — never a synthesized search URL (BS#1184 / BS#1192).
 *
 * Pure. No I/O.
 */
export const buildStreamingFill = (lookup: LookupResponse | null, fallbacks: MetadataFallbacks): StreamingFill => {
  if (!lookup) {
    const synth = synthesizeSearchUrls(fallbacks);
    return {
      spotify_url: null,
      apple_music_url: null,
      youtube_music_url: synth.youtube_music_url,
      bandcamp_url: synth.bandcamp_url,
      soundcloud_url: synth.soundcloud_url,
    };
  }
  const normalized = normalizeLookup(lookup, fallbacks);
  return {
    spotify_url: normalized.spotify_url,
    apple_music_url: normalized.apple_music_url,
    youtube_music_url: normalized.youtube_music_url,
    bandcamp_url: normalized.bandcamp_url,
    soundcloud_url: normalized.soundcloud_url,
  };
};

/**
 * Write one album's fill, fill-null only.
 *
 * Two independent guards, both deliberate:
 *
 *   1. `COALESCE(<col>, $new)` — a column that somehow holds a value keeps it.
 *   2. The full cohort predicate re-asserted in the WHERE — if ANY of the five
 *      became non-null since enumeration (the live worker healed it first,
 *      now that the forward fix lets it), the UPDATE matches zero rows.
 *
 * Guard 2 makes guard 1 redundant and vice versa; both are cheap and this job
 * writes to a table the live path also writes to. Returns true when a row was
 * actually updated.
 */
export const applyStreamingFill = async (albumId: number, fill: StreamingFill): Promise<boolean> => {
  const rows = (await db.execute(sql`
    UPDATE "wxyc_schema"."album_metadata"
       SET "spotify_url"       = COALESCE("spotify_url", ${fill.spotify_url}),
           "apple_music_url"   = COALESCE("apple_music_url", ${fill.apple_music_url}),
           "youtube_music_url" = COALESCE("youtube_music_url", ${fill.youtube_music_url}),
           "bandcamp_url"      = COALESCE("bandcamp_url", ${fill.bandcamp_url}),
           "soundcloud_url"    = COALESCE("soundcloud_url", ${fill.soundcloud_url}),
           "updated_at"        = NOW()
     WHERE "album_id" = ${albumId}
       AND ${sql.raw(cohortPredicateSql())}
    RETURNING "album_id"
  `)) as unknown as Array<{ album_id: number }>;
  return rows.length > 0;
};

/** ANALYZE after the drain so the planner sees the new NULL fractions on the
 * five columns — the pre-check's gate now reads them on every enrichment.
 * Per `docs/bulk-update-playbook.md`. */
export const analyzeAlbumMetadata = async (): Promise<void> => {
  await db.execute(sql.raw('ANALYZE "wxyc_schema"."album_metadata"'));
};

// -- Cooperative pause -------------------------------------------------------

export const checkLiveActivity = async (lookbackSeconds: number): Promise<boolean> => {
  if (lookbackSeconds <= 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1
    FROM "wxyc_schema"."flowsheet"
    WHERE "entry_type" = 'track'
      AND "add_time" > now() - (interval '1 second' * ${lookbackSeconds})
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `DJ activity detected; pausing ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
    });
    await sleep(pauseMs);
  }
};

// -- Batch -------------------------------------------------------------------

export interface BatchResult {
  batchSize: number;
  match: number;
  no_match: number;
  error: number;
  filled: number;
  skipped_raced: number;
  unexpected_index: number;
}

const buildBulkItems = (candidates: DrainCandidate[]): BulkLookupItem[] =>
  candidates.map((c) => ({
    artist: c.artist_name,
    album: c.album_title,
    raw_message: `${c.artist_name} - ${c.album_title}`,
  }));

/**
 * Resolve one chunk through LML and write the fills.
 *
 * A thrown bulk call (timeout, 5xx, network) does NOT abandon the chunk. Every
 * candidate still gets its synthesized-only fill written, because the three
 * search URLs never needed LML in the first place — they come from our own
 * library text. That is the difference between this drain and
 * `album-level-backfill`, which has nothing to write without a match and so
 * leaves the row for the next sweep. Here, leaving the row means leaving it
 * frozen forever, so a degraded fill beats no fill.
 *
 * The `result.index !== i` guard is the BS#1088 regression pin: LML's bulk
 * handler honors input order today, and a future refactor that silently broke
 * it would otherwise write one album's streaming URLs onto another.
 */
export const runBatch = async (
  candidates: DrainCandidate[],
  options: { budgetMs: number; execute: boolean }
): Promise<BatchResult> => {
  const empty: BatchResult = {
    batchSize: candidates.length,
    match: 0,
    no_match: 0,
    error: 0,
    filled: 0,
    skipped_raced: 0,
    unexpected_index: 0,
  };
  if (candidates.length === 0) return empty;

  const items = buildBulkItems(candidates);
  let response: Awaited<ReturnType<typeof bulkLookupMetadata>> | null = null;
  try {
    response = await bulkLookupMetadata(items, {
      budgetMs: options.budgetMs,
      timeoutMs: computeBulkTimeoutMs(items.length),
      caller: 'album-level-backfill',
    });
  } catch (err) {
    const extra = {
      size: items.length,
      first_album_id: candidates[0]?.album_id ?? null,
      last_album_id: candidates[candidates.length - 1]?.album_id ?? null,
    };
    log('warn', 'lml_batch_failed', 'bulkLookupMetadata threw; falling back to synthesized-only fills', {
      ...extra,
      error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    captureError(err, 'lml_batch_failed', extra);
  }

  let match = 0;
  let no_match = 0;
  let error = 0;
  let filled = 0;
  let skipped_raced = 0;
  let unexpected_index = 0;
  let firstMismatchIndex: number | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const fallbacks: MetadataFallbacks = { artist: candidate.artist_name, album: candidate.album_title };

    let lookup: LookupResponse | null = null;
    if (response) {
      const result = response.results[i];
      if (!result || result.index !== i) {
        unexpected_index += 1;
        if (firstMismatchIndex === null) firstMismatchIndex = i;
        log('warn', 'unexpected_result_index', `LML result.index mismatch at position ${i}; synthesized-only fill`, {
          expected_index: i,
          got_index: result?.index ?? null,
          album_id: candidate.album_id,
        });
      } else if (result.status === 'match' && result.lookup) {
        match += 1;
        lookup = result.lookup;
      } else if (result.status === 'no_match') {
        no_match += 1;
      } else {
        error += 1;
        log('warn', 'lml_error', `LML per-item error for album_id=${candidate.album_id}`, {
          album_id: candidate.album_id,
          error_message: result.message ?? null,
        });
      }
    }

    const fill = buildStreamingFill(lookup, fallbacks);
    if (!options.execute) continue;
    if (await applyStreamingFill(candidate.album_id, fill)) filled += 1;
    else skipped_raced += 1;
  }

  if (unexpected_index > 0) {
    Sentry.captureMessage(`${JOB_NAME}.unexpected_index`, {
      level: 'warning',
      tags: { source: JOB_NAME },
      extra: { unexpected_index, batch_size: items.length, first_mismatch_index: firstMismatchIndex },
      fingerprint: [JOB_NAME, 'unexpected_index'],
    });
  }

  return { batchSize: candidates.length, match, no_match, error, filled, skipped_raced, unexpected_index };
};

// -- Orchestration -----------------------------------------------------------

export interface DrainOptions {
  batchSize: number;
  ratePerMin: number;
  budgetMs: number;
  readTimeoutMs: number;
  maxAlbums: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  execute: boolean;
}

export interface DrainSummary {
  cohortBefore: number;
  cohortAfter: number;
  enumerated: number;
  batches: number;
  match: number;
  no_match: number;
  error: number;
  filled: number;
  skipped_raced: number;
  unexpected_index: number;
  execute: boolean;
}

/** Dry-run is the DEFAULT. `--execute` is the only way to write. */
export const resolveOptions = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): DrainOptions => {
  const ctx = { context: JOB_NAME };
  return {
    batchSize: requirePositiveInt(env[BATCH_SIZE_ENV], BATCH_SIZE_ENV, BATCH_SIZE_DEFAULT, ctx),
    ratePerMin: requirePositiveInt(env[RATE_PER_MIN_ENV], RATE_PER_MIN_ENV, RATE_PER_MIN_DEFAULT, ctx),
    budgetMs: requirePositiveInt(env[BUDGET_MS_ENV], BUDGET_MS_ENV, BUDGET_MS_DEFAULT, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    maxAlbums: requireNonNegativeInt(env[MAX_ALBUMS_ENV], MAX_ALBUMS_ENV, MAX_ALBUMS_DEFAULT, ctx),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      ctx
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    execute: args.includes('--execute'),
  };
};

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const runDrain = async (options: DrainOptions): Promise<DrainSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: options.batchSize,
    rate_per_min: options.ratePerMin,
    budget_ms: options.budgetMs,
    max_albums: options.maxAlbums,
    execute: options.execute,
  });
  if (!options.execute) {
    log('info', 'dry_run', 'DRY RUN — no writes. Pass --execute to write.', {});
  }

  const cohortBefore = await countCohort(options.readTimeoutMs);
  log('info', 'cohort_before', `cohort before: ${cohortBefore} album_metadata rows`, { cohort_before: cohortBefore });

  const candidates = await enumerateCohort(options.maxAlbums, options.readTimeoutMs);
  log('info', 'enumerated', `enumerated ${candidates.length} drainable albums`, {
    enumerated: candidates.length,
    cohort_before: cohortBefore,
    // cohort_before counts every frozen row; `enumerated` drops the ones with
    // no usable artist name or a discogs_unavailable flag. A persistent gap
    // between the two is expected, not a bug — those rows stay frozen by design.
    excluded: cohortBefore - candidates.length,
  });

  const batches = chunk(candidates, options.batchSize);
  const interBatchSleepMs = Math.max(0, Math.floor(60_000 / options.ratePerMin));

  let match = 0;
  let no_match = 0;
  let error = 0;
  let filled = 0;
  let skipped_raced = 0;
  let unexpected_index = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (!batch) continue;
    await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);
    const result = await runBatch(batch, { budgetMs: options.budgetMs, execute: options.execute });
    match += result.match;
    no_match += result.no_match;
    error += result.error;
    filled += result.filled;
    skipped_raced += result.skipped_raced;
    unexpected_index += result.unexpected_index;
    log('info', 'batch_done', `batch ${b + 1}/${batches.length}`, {
      batch: b + 1,
      of: batches.length,
      ...result,
    });
    if (b < batches.length - 1 && interBatchSleepMs > 0) await sleep(interBatchSleepMs);
  }

  if (filled > 0) await analyzeAlbumMetadata();

  const cohortAfter = await countCohort(options.readTimeoutMs);
  log('info', 'cohort_after', `cohort after: ${cohortAfter} album_metadata rows`, {
    cohort_before: cohortBefore,
    cohort_after: cohortAfter,
    delta: cohortBefore - cohortAfter,
  });

  return {
    cohortBefore,
    cohortAfter,
    enumerated: candidates.length,
    batches: batches.length,
    match,
    no_match,
    error,
    filled,
    skipped_raced,
    unexpected_index,
    execute: options.execute,
  };
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = resolveOptions();
    const summary = await runDrain(options);
    log('info', 'finished', `${JOB_NAME} done`, { ...summary });
  } catch (err) {
    captureError(err, 'main');
    log('error', 'failed', `${JOB_NAME} failed: ${err instanceof Error ? err.message : String(err)}`, {
      error_message: err instanceof Error ? err.message : String(err),
      error_name: err instanceof Error ? err.name : null,
    });
    process.exitCode = 1;
  } finally {
    await closeLogger();
    await closeDatabaseConnection();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run
// against the mocked DB (same rationale as `album-level-backfill#main`).
if (process.env.NODE_ENV !== 'test') {
  void main();
}
