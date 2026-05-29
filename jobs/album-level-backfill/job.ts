/**
 * One-shot album-level historical backfill (BS#1041).
 *
 * Drains the ~857k pending flowsheet rows with `album_id IS NOT NULL`
 * that never enriched into `album_metadata`. Dedupes by `album_id`
 * (~35,692 uniques post-2026-05-23 SQL collapse) and uses LML's bulk
 * lookup endpoint (LML#368, `POST /api/v1/lookup/bulk`) to amortize
 * cold-cache cost across batches.
 *
 * Sequence:
 *   1. Enumerate distinct pending album_ids
 *   2. For each chunk: resolve (artist_name, album_title) via library+artists
 *      → bulkLookupMetadata → UPSERT album_metadata for `match` results
 *   3. ANALYZE album_metadata (paired-bulk rule, docs/bulk-update-playbook.md)
 *   4. Cooperative pause until quiet, then post-pass UPDATE: flip the ~857k
 *      pending flowsheet rows to `enriched_match` via JOIN to album_metadata
 *      (same shape as the 2026-05-23 drain-acceleration SQL).
 *
 * Race-safety:
 *   - Enrichment-worker claims rows with `metadata_status='enriching'`. Our
 *     UPSERT is additive (race-guarded by `updated_at < NOW()`); our post-
 *     pass UPDATE filters on `metadata_status='pending'` and never collides
 *     with claimed rows.
 *   - The daily `flowsheet-metadata-backfill-cron` (BS#1011) also writes to
 *     `album_metadata` via the same race-guarded UPSERT. Stop the cron
 *     during this run to avoid LML rate contention.
 *
 * Cooperative pause is inlined (not imported from
 * `jobs/flowsheet-metadata-backfill/orchestrate.ts`) because this job's
 * operation envelope is a single 3-hour post-pass transaction, distinct
 * from the cron's 60-second per-row batch loop. Sharing the helper would
 * couple two lifecycles whose pause semantics diverge.
 *
 * Run procedure: see jobs/album-level-backfill/README.md.
 */

import { sql } from 'drizzle-orm';
import { album_metadata, db, closeDatabaseConnection } from '@wxyc/database';
import { bulkLookupMetadata, type BulkLookupItem, type LookupResponse } from '@wxyc/lml-client';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'album-level-backfill';

// -- Env knobs ---------------------------------------------------------------

/** Items per bulk-lookup request. LML hard cap is 100; default 5 is the
 * empirically-validated post-LML#370 ceiling under live `enrichment-worker`
 * contention for LML's 5-permit Discogs semaphore. The 2026-05-28 Phase 3
 * canary (BS#1078 / BS#1197) measured 38–50 % per-batch timeout at
 * `batchSize=10` vs 3–10 % at `batchSize=5` — smaller batches yield *higher*
 * net throughput because `computeBulkTimeoutMs(5)=17_500 ms` lands cascade-
 * heavy items under LML's 25 s `caller_budget_ms` window, while `(10)=30_000
 * ms` races the shared LML-client's own 30 s socket timeout. Catch-up
 * throughput comes from `BACKFILL_BULK_RATE_PER_MIN`, not this knob. */
export const BULK_BATCH_SIZE_ENV = 'BACKFILL_BULK_BATCH_SIZE';
export const BULK_BATCH_SIZE_DEFAULT = 5;

/** Batches per minute. Bound the bulk caller so it can run concurrently
 * with the per-row drain cron (BS#995, 4 items/min) without saturating
 * LML's serial Discogs fan-out. Catch-up throughput should come from
 * raising this knob, not `BACKFILL_BULK_BATCH_SIZE` — see README. */
export const BULK_RATE_PER_MIN_ENV = 'BACKFILL_BULK_RATE_PER_MIN';
export const BULK_RATE_PER_MIN_DEFAULT = 1;

/** Per-ITEM budget forwarded to LML as `X-Caller-Budget-Ms` (A8 / LML#345).
 * Caps each individual cascade inside the bulk call, NOT the whole batch.
 * The fetch-level timeout is computed dynamically by `computeBulkTimeoutMs`. */
export const BULK_BUDGET_MS_ENV = 'BACKFILL_BULK_BUDGET_MS';
export const BULK_BUDGET_MS_DEFAULT = 25_000;

/** Per-item slice of the bulk fetch timeout. Matches LML's amortized
 * rate: `BULK_BUDGET_MS_DEFAULT / LML_BULK_MAX_CONCURRENT = 25_000 / 10`. */
export const BULK_PER_ITEM_TIMEOUT_MS = 2_500;

/** Fixed slack on top of `batchSize × BULK_PER_ITEM_TIMEOUT_MS`:
 * HTTP overhead + JSON encode/decode + safety margin. */
export const BULK_TIMEOUT_SLACK_MS = 5_000;

/** Scale the LML-client fetch timeout to batch size. The shared
 * `lmlFetch` default (30 s) is sized against the single-item endpoint;
 * bulk wall-clock scales with batch size, so callers must override. */
export const computeBulkTimeoutMs = (batchSize: number): number =>
  batchSize * BULK_PER_ITEM_TIMEOUT_MS + BULK_TIMEOUT_SLACK_MS;

/** Statement timeout for the post-pass UPDATE. The 2026-05-23 drain-accel
 * flipped 309k rows in 80 min; 857k is ~3h; 4h gives a 30% margin. */
export const POST_PASS_TIMEOUT_ENV = 'ALBUM_LEVEL_BACKFILL_POST_PASS_TIMEOUT_MS';
export const POST_PASS_TIMEOUT_DEFAULT = 4 * 60 * 60 * 1000;

/** Statement timeout for the enumerate scan + the per-batch resolveAlbums
 * lookup. The partial index `idx_flowsheet_metadata_drain` covers the
 * `metadata_attempt_at IS NULL` partition; our predicate filters on
 * `metadata_status = 'pending'` which isn't covered today, so the planner
 * falls back to a seq scan + sort that exceeds the backend's default 5s
 * (verified empirically on the 2026-05-24 prod dry-run). 5min covers
 * observed runtime with comfortable margin. Mirrors
 * `album-metadata-backfill#verifyComplete`. */
export const READ_TIMEOUT_ENV = 'ALBUM_LEVEL_BACKFILL_READ_TIMEOUT_MS';
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Cooperative-pause lookback window. If the most recent flowsheet track
 * was added within this many seconds, defer. Default 300s (5 min) is
 * stricter than the per-row cron's 60s — this job's post-pass UPDATE
 * holds a long transaction and we don't want it racing live writes. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 300;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

// -- Env parsing -------------------------------------------------------------

const requirePositiveInt = (raw: string | undefined, envName: string, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`[${JOB_NAME}] Invalid ${envName}=${raw}: must be a positive integer.`);
  }
  return n;
};

const requireNonNegativeInt = (raw: string | undefined, envName: string, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`[${JOB_NAME}] Invalid ${envName}=${raw}: must be a non-negative integer.`);
  }
  return n;
};

// -- Inlined helpers ---------------------------------------------------------
//
// Both helpers are inlined for the same build-graph isolation reason as
// jobs/flowsheet-metadata-backfill/enrich.ts (no imports from apps/backend).
// Parity with the canonical sources is pinned by the parity tests at
// tests/unit/jobs/album-level-backfill/{clean-discogs-bio,filter-spacer-gif}-parity.test.ts.

/** Strip Discogs markup tags from bio text. Mirrors
 * apps/backend/services/metadata/metadata.service.ts#cleanDiscogsBio and
 * jobs/flowsheet-metadata-backfill/enrich.ts#cleanDiscogsBio verbatim. */
export const cleanDiscogsBio = (bio: string): string =>
  bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');

/** Drop Discogs spacer.gif placeholder URLs. Mirrors enrich.ts#filterSpacerGif. */
export const filterSpacerGif = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.includes('spacer.gif')) return null;
  return url;
};

// -- Source query ------------------------------------------------------------

/** SELECT DISTINCT album_id of every pending track row with a non-null
 * album_id. The 35,692-uniques figure in the BS#1041 description is from
 * this query post-2026-05-23.
 *
 * Wrapped in `db.transaction` + `SET LOCAL statement_timeout` because the
 * `metadata_status = 'pending'` predicate isn't covered by the partial
 * index `idx_flowsheet_metadata_drain` (which covers
 * `metadata_attempt_at IS NULL`); the planner falls back to a seq scan +
 * sort that exceeds the backend's default 5s `statement_timeout`. `SET
 * LOCAL` only scopes inside an explicit transaction with the postgres-js
 * driver (auto-commits per execute otherwise). Mirrors
 * `album-metadata-backfill#verifyComplete`. */
export const enumeratePendingAlbumIds = async (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<number[]> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT DISTINCT "album_id"
      FROM "wxyc_schema"."flowsheet"
      WHERE "entry_type" = 'track'
        AND "artist_name" IS NOT NULL
        AND "metadata_status" = 'pending'
        AND "album_id" IS NOT NULL
      ORDER BY "album_id"
    `)) as unknown as Array<{ album_id: number }>;
    return rows.map((r) => Number(r.album_id));
  });
};

export interface ResolvedAlbum {
  album_id: number;
  artist_name: string;
  album_title: string;
}

/** Resolve a chunk of album_ids to LML lookup keys. `library.album_title`
 * is NOT NULL per `shared/database/src/schema.ts:324`; `library.artist_name`
 * is *nullable* (line 346, "Denormalized from artists.artist_name (Epic
 * A.1). Nullable until A.2 backfill / A.3 live-cascade has run") with an
 * explicit "code paths reading `artist_name` must tolerate NULL" warning
 * on line 290. The `artists` LEFT JOIN is preferred when present (canonical
 * normalized form via the tubafrenzy ETL); we COALESCE down to
 * `library.artist_name`, and the `COALESCE(...) IS NOT NULL` predicate
 * drops the legacy-and-unbackfilled rows where both sides are NULL —
 * without it, `String(null)` would become the literal `"null"` and we'd
 * POST it to LML as the artist name.
 *
 * Same statement-timeout wrapper as `enumeratePendingAlbumIds` — the
 * `library` table is PK-lookup-shaped via `= ANY($1)` but the `artists`
 * LEFT JOIN can be slow if the artist row count grows; the timeout caps
 * the worst case. */
export const resolveAlbums = async (
  albumIds: number[],
  timeoutMs: number = READ_TIMEOUT_DEFAULT
): Promise<ResolvedAlbum[]> => {
  if (albumIds.length === 0) return [];
  // Bind as a single PG-array-literal string param (`'{1,2,3}'::int[]`).
  // Verified against prod psql via PREPARE q(text) AS ... ANY($1::int[]).
  //
  // Drizzle/postgres-js splats a JS array into N positional placeholders
  // here — both `ANY(${array}::int[])` and the bare `ANY(${array})` send
  // `ANY(($1, $2, …, $50))` over the wire, which PG rejects with
  // `cannot cast type record to integer[]` (cast form, BS#1068) or
  // `op ANY/ALL (array) requires array on right side` (bare form,
  // BS#1071, 2026-05-24 second prod canary). The two callsites at
  // `shared/database/src/library-tiebreak.ts:47` and
  // `jobs/flowsheet-etl/job.ts:102` likely have the same latent bug at
  // arity ≥ 2 — see BS#1072 follow-up.
  //
  // Safe by construction: TypeScript types `albumIds: number[]`, so the
  // join contains only numeric literals — no injection surface.
  const idArrayLiteral = `{${albumIds.join(',')}}`;
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT
        l."id" AS album_id,
        COALESCE(a."artist_name", l."artist_name") AS artist_name,
        l."album_title" AS album_title
      FROM "wxyc_schema"."library" l
      LEFT JOIN "wxyc_schema"."artists" a ON l."artist_id" = a."id"
      WHERE l."id" = ANY(${idArrayLiteral}::int[])
        AND COALESCE(a."artist_name", l."artist_name") IS NOT NULL
    `)) as unknown as Array<{ album_id: number; artist_name: string; album_title: string }>;
    return rows.map((r) => ({
      album_id: Number(r.album_id),
      artist_name: String(r.artist_name),
      album_title: String(r.album_title),
    }));
  });
};

/** Map ResolvedAlbum into the per-item shape LML's bulk endpoint expects. */
export const buildBulkItems = (albums: ResolvedAlbum[]): BulkLookupItem[] =>
  albums.map((a) => ({
    artist: a.artist_name,
    album: a.album_title,
    raw_message: `${a.artist_name} - ${a.album_title}`,
  }));

// -- album_metadata UPSERT ---------------------------------------------------

/** Extract the top-1 artwork from a LookupResponse and UPSERT into
 * album_metadata. Mirrors the linked+match branch of
 * jobs/flowsheet-metadata-backfill/enrich.ts (lines 161-198) verbatim,
 * minus the marker-stamp on flowsheet (the post-pass UPDATE handles that
 * in bulk).
 *
 * Returns `true` if a row was attempted to be written (the UPSERT itself
 * is race-guarded by `updated_at < NOW()`; postgres-js doesn't surface
 * affected-rows here, so this is "attempt" not "won"). Returns `false`
 * when LML's top-1 has no artwork — typically `status: 'no_match'`
 * (which the caller already filtered out, but defensive).
 *
 * No-match items are NOT written to album_metadata. A row in
 * album_metadata semantically means "LML matched this album." No-match
 * flowsheet rows are picked up by the per-row drain cron's enrich.ts
 * which synthesizes search URLs inline. */
export const upsertAlbumMatch = async (albumId: number, lookup: LookupResponse): Promise<boolean> => {
  const first = lookup.results?.[0];
  const artwork = first?.artwork;
  if (!artwork) return false;

  const payload = {
    artwork_url: filterSpacerGif(artwork.artwork_url),
    discogs_url: artwork.release_url ?? null,
    // Discogs returns 0 as "year unknown"; coerce to null. Mirrors
    // metadata.service.ts#extractAlbumMetadata (#1002) + enrich.ts.
    release_year: artwork.release_year || null,
    spotify_url: artwork.spotify_url ?? null,
    apple_music_url: artwork.apple_music_url ?? null,
    youtube_music_url: artwork.youtube_music_url ?? null,
    bandcamp_url: artwork.bandcamp_url ?? null,
    soundcloud_url: artwork.soundcloud_url ?? null,
    artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
    artist_wikipedia_url: artwork.wikipedia_url ?? null,
  };

  await db
    .insert(album_metadata)
    .values({ album_id: albumId, ...payload, updated_at: sql`NOW()` })
    .onConflictDoUpdate({
      target: album_metadata.album_id,
      set: { ...payload, updated_at: sql`NOW()` },
      // Race guard: never clobber a fresher worker/runtime enrichment.
      setWhere: sql`${album_metadata.updated_at} < NOW()`,
    });
  return true;
};

// -- Cooperative pause -------------------------------------------------------

/** Probe `flowsheet` for a track row added in the last `lookbackSeconds`.
 * Returns `true` when activity is detected. Uses the partial index
 * `flowsheet_track_add_time_idx` (migration 0050) for an index-only
 * single-leaf lookup. Inlined from jobs/flowsheet-metadata-backfill/
 * orchestrate.ts#checkLiveActivity. `0` disables the probe (catch-up). */
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

/** Loop: probe → if active, sleep pauseMs → re-probe. Returns when the
 * lookback window is quiet (no track within `lookbackSeconds`). */
export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live DJ activity within ${lookbackSeconds}s; deferring ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    await sleep(pauseMs);
  }
};

// -- Post-pass UPDATE --------------------------------------------------------

/** Flip every pending flowsheet row whose album_id now exists in
 * album_metadata. Same shape as the 2026-05-23 drain-acceleration SQL,
 * scoped inside a transaction so `SET LOCAL statement_timeout` actually
 * applies (postgres-js auto-commits per execute otherwise). */
export const runPostPassUpdate = async (timeoutMs: number): Promise<number> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const result = await tx.execute(sql`
      WITH matched AS (
        UPDATE "wxyc_schema"."flowsheet" f
        SET "metadata_status" = 'enriched_match',
            "metadata_attempt_at" = COALESCE(f."metadata_attempt_at", now())
        FROM "wxyc_schema"."album_metadata" am
        WHERE f."album_id" = am."album_id"
          AND f."metadata_status" = 'pending'
          AND f."album_id" IS NOT NULL
          AND f."entry_type" = 'track'
          AND f."artist_name" IS NOT NULL
        RETURNING f."id"
      )
      SELECT count(*)::int AS flipped FROM matched
    `);
    const row = (result as unknown as Array<{ flipped: number }>)[0];
    return Number(row?.flipped ?? 0);
  });
};

// -- ANALYZE -----------------------------------------------------------------

/** ANALYZE album_metadata after the bulk UPSERTs so the planner has fresh
 * statistics before the post-pass UPDATE's JOIN. Paired-bulk rule from
 * docs/bulk-update-playbook.md. */
export const analyzeAlbumMetadata = async (): Promise<void> => {
  log('info', 'analyze_started', 'ANALYZE album_metadata');
  await db.execute(sql`ANALYZE "wxyc_schema"."album_metadata"`);
};

// -- Per-batch orchestration -------------------------------------------------

export interface BatchResult {
  batchSize: number;
  match: number;
  no_match: number;
  error: number;
  upserts: number;
}

/** Run one chunk end-to-end: resolve → bulk call → UPSERT matches. The
 * inner `bulkLookupMetadata` call carries the limiter token-per-batch
 * semantics; the batch-rate pacing is the caller's responsibility
 * (runBackfill below sleeps between batches per BACKFILL_BULK_RATE_PER_MIN).
 *
 * Per-item errors are isolated by LML; this function logs them and moves
 * on. The album stays `metadata_status='pending'` and the per-row drain
 * cron will retry it on its next sweep. */
export const runBatch = async (
  albumIds: number[],
  options: { budgetMs: number; dryRun: boolean; readTimeoutMs?: number }
): Promise<BatchResult> => {
  const resolved = await resolveAlbums(albumIds, options.readTimeoutMs ?? READ_TIMEOUT_DEFAULT);
  const items = buildBulkItems(resolved);

  if (options.dryRun) {
    log('info', 'batch_dry_run', `dry-run: would call bulkLookup with ${items.length} items`, {
      resolved: resolved.length,
      items: items.length,
    });
    return { batchSize: items.length, match: 0, no_match: 0, error: 0, upserts: 0 };
  }

  if (items.length === 0) {
    return { batchSize: 0, match: 0, no_match: 0, error: 0, upserts: 0 };
  }

  // Isolate HTTP-level failures (timeout, 5xx, network) so a single bad
  // batch can't abort the whole run. LML's bulk endpoint already
  // isolates per-item failures via `status: 'error'`; if the HTTP call
  // itself throws (LmlClientError on the fetch timeout, BS#1076), treat
  // the whole batch as N errors and let the per-row drain cron retry on
  // its next sweep. Idempotency holds: nothing was UPSERTed.
  const timeoutMs = computeBulkTimeoutMs(items.length);
  let response;
  try {
    response = await bulkLookupMetadata(items, { budgetMs: options.budgetMs, timeoutMs });
  } catch (err) {
    const firstAlbumId = resolved[0]?.album_id ?? null;
    const lastAlbumId = resolved[resolved.length - 1]?.album_id ?? null;
    const errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const extra = { size: items.length, first_album_id: firstAlbumId, last_album_id: lastAlbumId };
    log('warn', 'lml_batch_failed', 'bulkLookupMetadata threw; entire batch counted as error', {
      ...extra,
      error_message: errorMessage,
    });
    captureError(err, 'lml_batch_failed', extra);
    return { batchSize: items.length, match: 0, no_match: 0, error: items.length, upserts: 0 };
  }
  // resolved[i] corresponds to items[i] which corresponds to response.results[i].
  // LML guarantees input-order results.
  let match = 0;
  let no_match = 0;
  let error = 0;

  // `upsertAlbumMatch` is race-guarded by `updated_at < NOW()` and
  // `enumeratePendingAlbumIds` returns distinct album_ids per batch, so
  // ordering within a batch is irrelevant — safe to issue concurrently.
  const upsertPromises: Array<Promise<boolean>> = [];
  for (const result of response.results) {
    if (result.status === 'match' && result.lookup) {
      match += 1;
      const album = resolved[result.index];
      if (!album) continue; // shouldn't happen given input-order guarantee
      upsertPromises.push(upsertAlbumMatch(album.album_id, result.lookup));
    } else if (result.status === 'no_match') {
      no_match += 1;
    } else {
      error += 1;
      const album = resolved[result.index];
      log('warn', 'lml_error', `LML per-item error for album_id=${album?.album_id ?? '?'}`, {
        album_id: album?.album_id ?? null,
        error_message: result.message ?? null,
      });
    }
  }
  const upserts = (await Promise.all(upsertPromises)).filter(Boolean).length;
  return { batchSize: items.length, match, no_match, error, upserts };
};

// -- Top-level orchestration -------------------------------------------------

export interface BackfillSummary {
  scanned: number;
  batches: number;
  match: number;
  no_match: number;
  error: number;
  upserts: number;
  flipped: number;
}

export interface BackfillOptions {
  batchSize: number;
  ratePerMin: number;
  budgetMs: number;
  postPassTimeoutMs: number;
  readTimeoutMs: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  dryRun: boolean;
}

export const resolveOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): BackfillOptions => {
  return {
    batchSize: requirePositiveInt(env[BULK_BATCH_SIZE_ENV], BULK_BATCH_SIZE_ENV, BULK_BATCH_SIZE_DEFAULT),
    ratePerMin: requirePositiveInt(env[BULK_RATE_PER_MIN_ENV], BULK_RATE_PER_MIN_ENV, BULK_RATE_PER_MIN_DEFAULT),
    budgetMs: requirePositiveInt(env[BULK_BUDGET_MS_ENV], BULK_BUDGET_MS_ENV, BULK_BUDGET_MS_DEFAULT),
    postPassTimeoutMs: requirePositiveInt(env[POST_PASS_TIMEOUT_ENV], POST_PASS_TIMEOUT_ENV, POST_PASS_TIMEOUT_DEFAULT),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT
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

export const runBackfill = async (options: BackfillOptions): Promise<BackfillSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: options.batchSize,
    rate_per_min: options.ratePerMin,
    budget_ms: options.budgetMs,
    dry_run: options.dryRun,
  });

  const albumIds = await enumeratePendingAlbumIds(options.readTimeoutMs);
  log('info', 'enumerated', `enumerated ${albumIds.length} unique album_ids`, {
    scanned: albumIds.length,
  });

  if (options.dryRun) {
    const batches = chunk(albumIds, options.batchSize);
    log('info', 'dry_run_plan', `(dry-run) would run ${batches.length} batches of up to ${options.batchSize} items`, {
      batches: batches.length,
      batch_size: options.batchSize,
    });
    return {
      scanned: albumIds.length,
      batches: batches.length,
      match: 0,
      no_match: 0,
      error: 0,
      upserts: 0,
      flipped: 0,
    };
  }

  const interBatchSleepMs = Math.max(0, Math.floor(60_000 / options.ratePerMin));
  const batches = chunk(albumIds, options.batchSize);

  let totalMatch = 0;
  let totalNoMatch = 0;
  let totalError = 0;
  let totalUpserts = 0;

  for (let i = 0; i < batches.length; i += 1) {
    await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);

    const t0 = Date.now();
    const result = await runBatch(batches[i], {
      budgetMs: options.budgetMs,
      dryRun: false,
      readTimeoutMs: options.readTimeoutMs,
    });
    const wallClockMs = Date.now() - t0;

    totalMatch += result.match;
    totalNoMatch += result.no_match;
    totalError += result.error;
    totalUpserts += result.upserts;

    // Field names are pinned to the BS#1078 Phase 3 runbook's `jq` watchdog
    // (`docs/ops-album-level-backfill-phase3.md`). The watchdog filters on
    // `.step=="batch_done" and .wall_clock_ms>25000`; the aggregate-first-20
    // probe sums `.scanned` and `.lml_error`. Don't rename these without
    // updating the runbook in lockstep — silent rename will leave the
    // watchdog matching nothing again (BS#1179).
    log('info', 'batch_done', `batch ${i + 1}/${batches.length} done`, {
      batch_index: i + 1,
      batches: batches.length,
      scanned: result.batchSize,
      match: result.match,
      no_match: result.no_match,
      lml_error: result.error,
      upserts: result.upserts,
      wall_clock_ms: wallClockMs,
    });

    if (i < batches.length - 1 && interBatchSleepMs > 0) {
      await sleep(interBatchSleepMs);
    }
  }

  if (totalUpserts > 0) await analyzeAlbumMetadata();

  // Pause again before the long post-pass UPDATE so a DJ going live mid-job
  // doesn't enter a 3-hour write window. Probe-and-defer happens BEFORE
  // opening the transaction, never inside it.
  await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);
  log('info', 'post_pass_started', `starting post-pass UPDATE`, {
    statement_timeout_ms: options.postPassTimeoutMs,
  });
  const t0 = Date.now();
  const flipped = await runPostPassUpdate(options.postPassTimeoutMs);
  const wallClockMs = Date.now() - t0;
  // `post_pass_update_done` is the literal grep target in the runbook's
  // Step 5 ("verify it completed"). Keep this step name stable.
  log('info', 'post_pass_update_done', `post-pass UPDATE flipped=${flipped}`, {
    flipped,
    wall_clock_ms: wallClockMs,
  });

  return {
    scanned: albumIds.length,
    batches: batches.length,
    match: totalMatch,
    no_match: totalNoMatch,
    error: totalError,
    upserts: totalUpserts,
    flipped,
  };
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = resolveOptions();
    const summary = await runBackfill(options);
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
// against the mocked DB. Jest sets NODE_ENV='test' by default; production
// runs (`node dist/job.js`) leave NODE_ENV='production' (per Dockerfile)
// or unset, both of which execute main(). The unit test for resolveOptions
// reaches inside without triggering this branch.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
