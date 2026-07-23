/**
 * Recurring free-text → release+master resolution cron
 * (BS#1491 / catalog-popularity Phase-2 Track 1).
 *
 * Resolves every distinct free-text `(artist, album)` pair the DJ typed for an
 * unlinked play (`flowsheet.album_id IS NULL`, ~43% of music plays) to a
 * Discogs release id via LML's bulk lookup, persisting verdicts in
 * `flowsheet_freetext_resolution` keyed on the normalized pair. Track 2's
 * popularity collapse reads this table to attribute the free-text plays that
 * the linked-only `album_plays` signal can't see.
 *
 * Modeled on `jobs/album-level-backfill/job.ts` (closest template — bulk
 * lookup + dedup-distinct + cooperative pause). Differences:
 *   - Dedup key is the NORMALIZED `(norm_artist, norm_album)` pair, computed in
 *     JS via `normalizeArtistName` + `normalizeAlbumTitle`. The flowsheet free
 *     text holds tens of thousands of edition/pressing variants that collapse
 *     to one logical album; SQL has no album-title normalizer, so we enumerate
 *     raw distinct pairs and fold them in JS, keeping one representative raw
 *     pair per normalized key for the LML lookup.
 *   - Writes to `flowsheet_freetext_resolution`, not `album_metadata`. There is
 *     NO post-pass UPDATE on `flowsheet` (this signal is read at Track-2
 *     collapse time by joining the normalized key, not stamped per row).
 *   - Recurring cron (free text keeps growing), not a one-shot. Retry policy is
 *     the attempt-at marker + a no-match TTL (docs/migrations.md "Attempt-at
 *     markers"): re-attempt `attempt_at IS NULL` and no-match rows older than
 *     the TTL window. No "retire after N".
 *
 * The enrichment-worker's `metadata_status='enriching'` claim scheme does NOT
 * apply here — free-text resolution is orthogonal to linked-row enrichment. We
 * reuse only the LML-rate cooperative pause (`awaitQuietWindow`) so the job
 * yields to live DJ activity, same as `album-level-backfill`.
 *
 * Run procedure: see jobs/catalog-popularity-freetext-resolve/README.md.
 */

import { sql } from 'drizzle-orm';
import {
  flowsheet_freetext_resolution,
  db,
  closeDatabaseConnection,
  requireNonNegativeInt,
  requirePositiveInt,
  freetextPairKey,
} from '@wxyc/database';
import { bulkLookupMetadata, type BulkLookupItem, type BulkLookupResponse } from '@wxyc/lml-client';
import * as Sentry from '@sentry/node';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'catalog-popularity-freetext-resolve';

/** Provenance written to `flowsheet_freetext_resolution.match_source`. */
export const MATCH_SOURCE = 'lml_bulk_lookup';

// -- Env knobs ---------------------------------------------------------------

/** Items per bulk-lookup request. Same ceiling rationale as
 * `album-level-backfill` (LML hard cap 100; default 5 keeps per-batch
 * wall-clock under LML's per-item budget under live contention). */
export const BULK_BATCH_SIZE_ENV = 'FREETEXT_RESOLVE_BULK_BATCH_SIZE';
export const BULK_BATCH_SIZE_DEFAULT = 5;

/** Batches per minute. Bound the bulk caller under LML's `Semaphore(5)` +
 * `TokenBucket(50/min)` ceiling so it can run alongside the per-row drain
 * cron without saturating LML's serial Discogs fan-out. */
export const BULK_RATE_PER_MIN_ENV = 'FREETEXT_RESOLVE_BULK_RATE_PER_MIN';
export const BULK_RATE_PER_MIN_DEFAULT = 1;

/** Per-ITEM budget forwarded to LML as `X-Caller-Budget-Ms`. Caps each
 * individual cascade inside the bulk call. */
export const BULK_BUDGET_MS_ENV = 'FREETEXT_RESOLVE_BULK_BUDGET_MS';
export const BULK_BUDGET_MS_DEFAULT = 25_000;

/** Per-item slice of the bulk fetch timeout. Sized from LML's realized
 * concurrency for cascade-bound items (`BULK_BUDGET_MS / 5`), matching
 * `album-level-backfill`'s post-#1198 derivation. */
export const BULK_PER_ITEM_TIMEOUT_MS = 5_000;

/** Fixed slack on top of `batchSize × BULK_PER_ITEM_TIMEOUT_MS`. */
export const BULK_TIMEOUT_SLACK_MS = 5_000;

/** Scale the LML-client fetch timeout to batch size (the shared default is
 * sized for the single-item endpoint; bulk wall-clock scales with batch
 * size). Identical to `album-level-backfill#computeBulkTimeoutMs`. */
export const computeBulkTimeoutMs = (batchSize: number): number =>
  batchSize * BULK_PER_ITEM_TIMEOUT_MS + BULK_TIMEOUT_SLACK_MS;

/** No-match retry TTL (days). A pair that came back no-match is re-attempted
 * once its `attempt_at` is older than this — a later Discogs addition can
 * match it. `attempt_at IS NULL` rows (never-tried + transient-failed) are
 * always eligible regardless of TTL. */
export const NO_MATCH_TTL_DAYS_ENV = 'FREETEXT_RESOLVE_NO_MATCH_TTL_DAYS';
export const NO_MATCH_TTL_DAYS_DEFAULT = 30;

/** Cap on distinct pairs processed per run, so a single cron tick stays
 * bounded under the LML rate ceiling while the long tail drains across many
 * nightly runs. `0` disables the cap (drain everything eligible). */
export const MAX_PAIRS_PER_RUN_ENV = 'FREETEXT_RESOLVE_MAX_PAIRS_PER_RUN';
export const MAX_PAIRS_PER_RUN_DEFAULT = 5_000;

/** Statement timeout for the enumerate scan. The `album_id IS NULL` partition
 * of `flowsheet` is large; a generous timeout covers the DISTINCT scan. */
export const READ_TIMEOUT_ENV = 'FREETEXT_RESOLVE_READ_TIMEOUT_MS';
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Cooperative-pause lookback window (seconds). If the most recent flowsheet
 * track was added within this many seconds, defer. `0` disables the probe. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 60;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

// -- Source query ------------------------------------------------------------

/** A raw free-text pair as the DJ typed it, with a representative track title
 * (empty string when no usable track exists for the pair). */
export interface RawPair {
  artist: string;
  album: string;
  song: string;
}

/** A normalized dedup key + the representative raw pair to send to LML. */
export interface NormalizedPair {
  norm_artist: string;
  norm_album: string;
  artist: string;
  album: string;
  song: string;
}

/** SELECT DISTINCT ON (artist_name, album_title) of every unlinked track row,
 * carrying a representative `track_title` alongside each pair.
 *
 * `DISTINCT ON` (not a plain `SELECT DISTINCT` over three columns) so SQL
 * returns exactly one row per (artist, album) pair — adding `track_title` to
 * a bare `SELECT DISTINCT` list would instead return one row per
 * (artist, album, track) TRIPLE, blowing up the already-uncovered
 * `album_id IS NULL` scan by ~7x. The ORDER BY prefers a non-empty track
 * (`btrim(coalesce(track_title, '')) = ''` sorts false-before-true, i.e.
 * non-empty first) and falls back to a deterministic `track_title ASC` so the
 * chosen representative is stable across runs. There is NO
 * `track_title IS NOT NULL` filter — a pair whose plays are all track-less
 * must still enumerate and resolve album-only, exactly as before this change.
 *
 * Wrapped in `db.transaction` + `SET LOCAL statement_timeout` because the
 * `album_id IS NULL` partition isn't covered by the metadata-drain partial
 * indexes; the planner falls back to a scan that can exceed the backend's
 * default `statement_timeout`. `SET LOCAL` only scopes inside an explicit
 * transaction with the postgres-js driver. Mirrors
 * `album-level-backfill#enumeratePendingAlbumIds`. */
export const enumerateFreetextPairs = async (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<RawPair[]> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON ("artist_name", "album_title")
             "artist_name", "album_title", "track_title"
      FROM "wxyc_schema"."flowsheet"
      WHERE "entry_type" = 'track'
        AND "album_id" IS NULL
        AND "artist_name" IS NOT NULL
        AND "album_title" IS NOT NULL
      ORDER BY "artist_name", "album_title",
               (btrim(coalesce("track_title", '')) = '') ASC,
               "track_title" ASC
    `)) as unknown as Array<{ artist_name: string; album_title: string; track_title: string | null }>;
    return rows.map((r) => ({
      artist: String(r.artist_name),
      album: String(r.album_title),
      song: r.track_title ? String(r.track_title) : '',
    }));
  });
};

/** Fold raw pairs into normalized dedup keys, keeping one representative raw
 * pair per key (the first encountered — `enumerateFreetextPairs` returns them
 * in a stable ORDER BY so the representative is deterministic across runs).
 *
 * Pairs whose normalized artist OR album is empty are dropped: an empty
 * normalized key is not a usable LML lookup and would all collapse to one
 * meaningless `('', '')` row. */
export const normalizePairs = (raw: RawPair[]): NormalizedPair[] => {
  const byKey = new Map<string, NormalizedPair>();
  for (const r of raw) {
    // The `(norm_artist, norm_album)` key composition lives in
    // `@wxyc/database`'s `freetextPairKey` so Track 2's popularity refresh
    // (`apps/backend/services/album-popularity-refresh.service.ts`) re-derives
    // a byte-identical key when it attributes free-text plays back to these
    // rows. The artist leg gets a whitespace collapse + trim that
    // `normalizeArtistName` deliberately omits, so 'J Dilla ' / 'J  Dilla' /
    // 'J Dilla' don't split into distinct rows + duplicate LML lookups + a
    // split play count — the double-count this table exists to fold.
    const { norm_artist, norm_album } = freetextPairKey(r.artist, r.album);
    // Both legs are now trimmed, so an empty normalized key means a usable
    // lookup is impossible; skip it (an empty pair would all collapse to one
    // meaningless ('', '') row).
    if (norm_artist.length === 0 || norm_album.length === 0) continue;
    const key = pairKey(norm_artist, norm_album);
    if (!byKey.has(key)) {
      byKey.set(key, { norm_artist, norm_album, artist: r.artist, album: r.album, song: r.song });
    }
  }
  return [...byKey.values()];
};

// -- Retry-eligibility filter ------------------------------------------------

/** Unambiguous in-memory dedup/skip key for a normalized `(artist, album)`
 * pair. A normalized title CAN contain spaces, so a space separator would be
 * ambiguous ("a b" + "c" vs "a" + "b c"). We JSON-encode the tuple instead:
 * printable, formatter-safe, and collision-free. Used only as a `Set<string>`
 * map key — never persisted (the table's real key is the composite PK on the
 * two columns). */
export const pairKey = (normArtist: string, normAlbum: string): string => JSON.stringify([normArtist, normAlbum]);

/** Read the set of normalized keys that should be SKIPPED this run: a resolved
 * row (release id present) is permanent; a no-match row (`attempt_at` set,
 * `discogs_release_id IS NULL`) is skipped only while inside the TTL window.
 * `attempt_at IS NULL` rows are never skipped (never-tried + transient-failed). */
export const loadSkipKeys = async (ttlDays: number): Promise<Set<string>> => {
  const rows = (await db.execute(sql`
    SELECT "norm_artist", "norm_album"
    FROM "wxyc_schema"."flowsheet_freetext_resolution"
    WHERE "attempt_at" IS NOT NULL
      AND (
        "discogs_release_id" IS NOT NULL
        OR "attempt_at" > now() - (interval '1 day' * ${ttlDays})
      )
  `)) as unknown as Array<{ norm_artist: string; norm_album: string }>;
  const skip = new Set<string>();
  for (const r of rows) {
    skip.add(pairKey(String(r.norm_artist), String(r.norm_album)));
  }
  return skip;
};

/** Drop normalized pairs that should be skipped this run. */
export const filterEligible = (pairs: NormalizedPair[], skip: Set<string>): NormalizedPair[] =>
  pairs.filter((p) => !skip.has(pairKey(p.norm_artist, p.norm_album)));

// -- Bulk item shape ---------------------------------------------------------

/** Map a NormalizedPair into LML's per-item shape. We send the RAW (artist,
 * album) the DJ typed — LML's matcher does its own normalization/fuzzy
 * matching and benefits from the original text, not our collapsed key.
 *
 * `song` is populated ONLY when the representative track is non-empty —
 * album-title-only matching is a much weaker signal than track-aware
 * matching (BS#1767), but a track-less pair must still fall back to
 * album-only exactly as before, not send an empty/whitespace `song` that
 * would confuse LML's matcher. */
export const buildBulkItems = (pairs: NormalizedPair[]): BulkLookupItem[] =>
  pairs.map((p) => ({
    artist: p.artist,
    album: p.album,
    ...(p.song && p.song.trim() ? { song: p.song } : {}),
    raw_message: `${p.artist} - ${p.album}`,
  }));

// -- UPSERT ------------------------------------------------------------------

/** The verdict to persist for one normalized pair. */
export interface ResolutionVerdict {
  norm_artist: string;
  norm_album: string;
  /** `> 0` Discogs release id, or null on no-match / streaming-only sentinel. */
  discogs_release_id: number | null;
  /** LML's per-result confidence, or null when there's no match. */
  match_confidence: number | null;
}

/** UPSERT one resolution verdict into `flowsheet_freetext_resolution`,
 * stamping the attempt-at marker on this RESPONDED outcome (match OR
 * no-match — both reach here; only transient LML failures never call this so
 * their rows stay `attempt_at IS NULL` and retryable).
 *
 * `discogs_master_id` is intentionally omitted from both the INSERT and the
 * UPDATE `set` clause: Track 1's release leg is independent of LML Track 0.
 * Omitting it from `set` PRESERVES any master id a later Track-0-aware run
 * wrote — never clobbers it back to NULL.
 *
 * `resolved_at` is set to now() only when a release id is present; on a
 * no-match it's written NULL so the column always means "when a release was
 * last attached." */
export const upsertVerdict = async (v: ResolutionVerdict): Promise<void> => {
  const hasMatch = v.discogs_release_id !== null;
  await db
    .insert(flowsheet_freetext_resolution)
    .values({
      norm_artist: v.norm_artist,
      norm_album: v.norm_album,
      discogs_release_id: v.discogs_release_id,
      match_confidence: v.match_confidence,
      match_source: MATCH_SOURCE,
      attempt_at: sql`now()`,
      resolved_at: hasMatch ? sql`now()` : null,
    })
    .onConflictDoUpdate({
      target: [flowsheet_freetext_resolution.norm_artist, flowsheet_freetext_resolution.norm_album],
      set: {
        discogs_release_id: v.discogs_release_id,
        match_confidence: v.match_confidence,
        match_source: MATCH_SOURCE,
        attempt_at: sql`now()`,
        resolved_at: hasMatch ? sql`now()` : null,
      },
    });
};

/** Extract the release verdict from an LML bulk per-item result. The release
 * id lives on `lookup.results[0].artwork.release_id`; `> 0` is a real release,
 * `0` is the BS#1185 streaming-only sentinel (NOT a linkable release) — both
 * the sentinel and a genuine no-match collapse to a null release id. */
export const verdictFromLookup = (
  pair: NormalizedPair,
  lookup: BulkLookupResponse['results'][number]['lookup']
): ResolutionVerdict => {
  const artwork = lookup?.results?.[0]?.artwork;
  const releaseId = artwork?.release_id ?? 0;
  if (artwork && releaseId > 0) {
    return {
      norm_artist: pair.norm_artist,
      norm_album: pair.norm_album,
      discogs_release_id: releaseId,
      match_confidence: typeof artwork.confidence === 'number' ? artwork.confidence : null,
    };
  }
  return {
    norm_artist: pair.norm_artist,
    norm_album: pair.norm_album,
    discogs_release_id: null,
    match_confidence: null,
  };
};

// -- Cooperative pause -------------------------------------------------------

/** Probe `flowsheet` for a track row added in the last `lookbackSeconds`.
 * Returns `true` when activity is detected. `0` disables the probe.
 * Inlined from `album-level-backfill#checkLiveActivity`. */
export const checkLiveActivity = async (lookbackSeconds: number): Promise<boolean> => {
  if (lookbackSeconds <= 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1
    FROM "wxyc_schema"."flowsheet"
    WHERE "entry_type" = 'track'
      AND "add_time" > now() - (interval '1 second' * ${lookbackSeconds})
    LIMIT 1
  `)) as unknown as Array<unknown>;
  return rows.length > 0;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Loop: probe → if active, sleep pauseMs → re-probe. Returns when quiet. */
export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live DJ activity within ${lookbackSeconds}s; deferring ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    await sleep(pauseMs);
  }
};

// -- Per-batch orchestration -------------------------------------------------

export interface BatchResult {
  batchSize: number;
  match: number;
  no_match: number;
  error: number;
  upserts: number;
  /** Count of per-result rows where LML's `result.index` did not equal the
   * position we sent. A non-zero value means a future LML refactor dropped the
   * input-order contract; we skip the write rather than UPSERT the wrong pair.
   * Regression-pin mirroring `album-level-backfill`'s BS#1088 defense. */
  unexpected_index: number;
}

/** Run one batch end-to-end: bulk call → UPSERT verdicts. Per-item LML errors
 * are isolated (the pair stays unwritten → `attempt_at IS NULL` → retried next
 * sweep). An HTTP-level throw counts the whole batch as errors and continues.
 *
 * NOTE on the no-match write: a `status: 'no_match'` IS a responded outcome, so
 * we DO UPSERT it (release id null, attempt_at stamped) — that's how the TTL
 * retry window arms. Only `status: 'error'` (and HTTP throws) leave the pair
 * unwritten so it stays immediately retryable. */
export const runBatch = async (
  pairs: NormalizedPair[],
  options: { budgetMs: number; dryRun: boolean }
): Promise<BatchResult> => {
  const items = buildBulkItems(pairs);

  if (options.dryRun) {
    log('info', 'batch_dry_run', `dry-run: would call bulkLookup with ${items.length} items`, {
      items: items.length,
    });
    return { batchSize: items.length, match: 0, no_match: 0, error: 0, upserts: 0, unexpected_index: 0 };
  }

  if (items.length === 0) {
    return { batchSize: 0, match: 0, no_match: 0, error: 0, upserts: 0, unexpected_index: 0 };
  }

  const timeoutMs = computeBulkTimeoutMs(items.length);
  let response: BulkLookupResponse;
  try {
    response = await bulkLookupMetadata(items, {
      budgetMs: options.budgetMs,
      timeoutMs,
      caller: JOB_NAME,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const extra = { size: items.length, first: pairs[0]?.norm_artist ?? null };
    log('warn', 'lml_batch_failed', 'bulkLookupMetadata threw; entire batch counted as error', {
      ...extra,
      error_message: errorMessage,
    });
    captureError(err, 'lml_batch_failed', extra);
    return { batchSize: items.length, match: 0, no_match: 0, error: items.length, upserts: 0, unexpected_index: 0 };
  }

  let match = 0;
  let no_match = 0;
  let error = 0;
  let unexpected_index = 0;
  let firstMismatchIndex: number | null = null;
  let firstMismatchGot: number | null = null;
  const upsertPromises: Array<Promise<void>> = [];

  for (let i = 0; i < pairs.length; i++) {
    const result = response.results[i];
    if (!result || result.index !== i) {
      unexpected_index += 1;
      if (firstMismatchIndex === null) {
        firstMismatchIndex = i;
        firstMismatchGot = result?.index ?? null;
      }
      log('warn', 'unexpected_result_index', `LML result.index mismatch at position ${i}; skipping write`, {
        expected_index: i,
        got_index: result?.index ?? null,
      });
      continue;
    }
    if (result.status === 'match') {
      match += 1;
      const verdict = verdictFromLookup(pairs[i], result.lookup);
      // A 'match' status with a streaming-only sentinel (release_id == 0)
      // still lands a no-match verdict (release id null) — recorded so the TTL
      // arms, since LML did respond.
      upsertPromises.push(upsertVerdict(verdict));
    } else if (result.status === 'no_match') {
      no_match += 1;
      upsertPromises.push(
        upsertVerdict({
          norm_artist: pairs[i].norm_artist,
          norm_album: pairs[i].norm_album,
          discogs_release_id: null,
          match_confidence: null,
        })
      );
    } else {
      // status === 'error': transient per-item failure. Leave the pair
      // unwritten so it stays attempt_at IS NULL and retries next sweep.
      error += 1;
      log('warn', 'lml_error', `LML per-item error for ${pairs[i].norm_artist} - ${pairs[i].norm_album}`, {
        error_message: result.message ?? null,
      });
    }
  }

  const upserts = upsertPromises.length;
  await Promise.all(upsertPromises);

  if (unexpected_index > 0) {
    Sentry.addBreadcrumb({
      category: JOB_NAME,
      message: 'unexpected_result_index',
      level: 'warning',
      data: {
        mismatch_count: unexpected_index,
        first_mismatch_index: firstMismatchIndex,
        first_mismatch_got: firstMismatchGot,
      },
    });
    Sentry.captureMessage(`${JOB_NAME}.unexpected_index`, {
      level: 'warning',
      tags: { source: JOB_NAME },
      extra: { unexpected_index, scanned: items.length },
      fingerprint: [JOB_NAME, 'unexpected_index'],
    });
  }

  return { batchSize: items.length, match, no_match, error, upserts, unexpected_index };
};

// -- Top-level orchestration -------------------------------------------------

export interface ResolveSummary {
  scanned: number;
  eligible: number;
  processed: number;
  batches: number;
  match: number;
  no_match: number;
  error: number;
  upserts: number;
  unexpected_index: number;
}

export interface ResolveOptions {
  batchSize: number;
  ratePerMin: number;
  budgetMs: number;
  noMatchTtlDays: number;
  maxPairsPerRun: number;
  readTimeoutMs: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  dryRun: boolean;
}

export const resolveOptions = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): ResolveOptions => {
  const ctx = { context: JOB_NAME };
  return {
    batchSize: requirePositiveInt(env[BULK_BATCH_SIZE_ENV], BULK_BATCH_SIZE_ENV, BULK_BATCH_SIZE_DEFAULT, ctx),
    ratePerMin: requirePositiveInt(env[BULK_RATE_PER_MIN_ENV], BULK_RATE_PER_MIN_ENV, BULK_RATE_PER_MIN_DEFAULT, ctx),
    budgetMs: requirePositiveInt(env[BULK_BUDGET_MS_ENV], BULK_BUDGET_MS_ENV, BULK_BUDGET_MS_DEFAULT, ctx),
    noMatchTtlDays: requirePositiveInt(
      env[NO_MATCH_TTL_DAYS_ENV],
      NO_MATCH_TTL_DAYS_ENV,
      NO_MATCH_TTL_DAYS_DEFAULT,
      ctx
    ),
    maxPairsPerRun: requireNonNegativeInt(
      env[MAX_PAIRS_PER_RUN_ENV],
      MAX_PAIRS_PER_RUN_ENV,
      MAX_PAIRS_PER_RUN_DEFAULT,
      ctx
    ),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      ctx
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    dryRun: args.includes('--dry-run'),
  };
};

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const runResolve = async (options: ResolveOptions): Promise<ResolveSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: options.batchSize,
    rate_per_min: options.ratePerMin,
    budget_ms: options.budgetMs,
    no_match_ttl_days: options.noMatchTtlDays,
    max_pairs_per_run: options.maxPairsPerRun,
    dry_run: options.dryRun,
  });

  const raw = await enumerateFreetextPairs(options.readTimeoutMs);
  const normalized = normalizePairs(raw);
  const skip = await loadSkipKeys(options.noMatchTtlDays);
  let eligible = filterEligible(normalized, skip);
  const eligibleTotal = eligible.length;

  if (options.maxPairsPerRun > 0 && eligible.length > options.maxPairsPerRun) {
    eligible = eligible.slice(0, options.maxPairsPerRun);
  }

  log(
    'info',
    'enumerated',
    `enumerated ${raw.length} raw pairs → ${normalized.length} normalized → ${eligibleTotal} eligible`,
    {
      raw_pairs: raw.length,
      normalized_pairs: normalized.length,
      eligible: eligibleTotal,
      processing: eligible.length,
      skipped: skip.size,
    }
  );

  if (options.dryRun) {
    const batches = chunk(eligible, options.batchSize);
    log('info', 'dry_run_plan', `(dry-run) would run ${batches.length} batches of up to ${options.batchSize} items`, {
      batches: batches.length,
      batch_size: options.batchSize,
    });
    return {
      scanned: raw.length,
      eligible: eligibleTotal,
      processed: eligible.length,
      batches: batches.length,
      match: 0,
      no_match: 0,
      error: 0,
      upserts: 0,
      unexpected_index: 0,
    };
  }

  const interBatchSleepMs = Math.max(0, Math.floor(60_000 / options.ratePerMin));
  const batches = chunk(eligible, options.batchSize);

  let totalMatch = 0;
  let totalNoMatch = 0;
  let totalError = 0;
  let totalUpserts = 0;
  let totalUnexpectedIndex = 0;

  for (let i = 0; i < batches.length; i += 1) {
    await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);

    const t0 = Date.now();
    const result = await runBatch(batches[i], { budgetMs: options.budgetMs, dryRun: false });
    const wallClockMs = Date.now() - t0;

    totalMatch += result.match;
    totalNoMatch += result.no_match;
    totalError += result.error;
    totalUpserts += result.upserts;
    totalUnexpectedIndex += result.unexpected_index;

    log('info', 'batch_done', `batch ${i + 1}/${batches.length} done`, {
      batch_index: i + 1,
      batches: batches.length,
      scanned: result.batchSize,
      match: result.match,
      no_match: result.no_match,
      lml_error: result.error,
      upserts: result.upserts,
      unexpected_index: result.unexpected_index,
      wall_clock_ms: wallClockMs,
    });

    if (i < batches.length - 1 && interBatchSleepMs > 0) {
      await sleep(interBatchSleepMs);
    }
  }

  return {
    scanned: raw.length,
    eligible: eligibleTotal,
    processed: eligible.length,
    batches: batches.length,
    match: totalMatch,
    no_match: totalNoMatch,
    error: totalError,
    upserts: totalUpserts,
    unexpected_index: totalUnexpectedIndex,
  };
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = resolveOptions();
    const summary = await runResolve(options);
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

// Guard the auto-invoke so jest's module load doesn't fire a stray run against
// the mocked DB. Jest sets NODE_ENV='test'; production runs leave it
// 'production' (per Dockerfile) or unset, both of which execute main().
if (process.env.NODE_ENV !== 'test') {
  void main();
}
