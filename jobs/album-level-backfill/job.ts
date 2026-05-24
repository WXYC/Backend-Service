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

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import { album_metadata, db, closeDatabaseConnection } from '@wxyc/database';
import { bulkLookupMetadata, type BulkLookupItem, type LookupResponse } from '@wxyc/lml-client';

const JOB_NAME = 'album-level-backfill';

// -- Env knobs ---------------------------------------------------------------

/** Items per bulk-lookup request. LML's hard cap is 100; default 50 is a
 * conservative compromise between roundtrip amortization and per-batch
 * blast radius if a single Discogs cascade goes pathological. */
export const BULK_BATCH_SIZE_ENV = 'BACKFILL_BULK_BATCH_SIZE';
export const BULK_BATCH_SIZE_DEFAULT = 50;

/** Batches per minute. Bound the bulk caller so it can run concurrently
 * with the per-row drain cron (BS#995, 4 items/min) without saturating
 * LML's serial Discogs fan-out. 1 batch/min ≈ 50 items/min sustained. */
export const BULK_RATE_PER_MIN_ENV = 'BACKFILL_BULK_RATE_PER_MIN';
export const BULK_RATE_PER_MIN_DEFAULT = 1;

/** Per-batch wall-clock budget forwarded to LML as `X-Caller-Budget-Ms`.
 * LML's per-item perform_lookup uses this as min(header, env default)
 * (A8 / LML#345). 25s leaves headroom under the 30s LML-client timeout
 * for HTTP overhead + JSON encode/decode of a 50-item batch. */
export const BULK_BUDGET_MS_ENV = 'BACKFILL_BULK_BUDGET_MS';
export const BULK_BUDGET_MS_DEFAULT = 25_000;

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
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    // No `::int[]` cast on `${albumIds}` — postgres-js binds JS arrays
    // natively to PG arrays, and the explicit cast forces a text-protocol
    // splat (`ANY(($1, $2, …, $50)::int[])`) that PG rejects with
    // `cannot cast type record to integer[]` (BS#1068, 2026-05-24 prod
    // canary). Matches the pattern in `library-tiebreak.ts` and
    // `flowsheet-etl/job.ts` that have run safely in prod for months.
    const rows = (await tx.execute(sql`
      SELECT
        l."id" AS album_id,
        COALESCE(a."artist_name", l."artist_name") AS artist_name,
        l."album_title" AS album_title
      FROM "wxyc_schema"."library" l
      LEFT JOIN "wxyc_schema"."artists" a ON l."artist_id" = a."id"
      WHERE l."id" = ANY(${albumIds})
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
    console.log(`[${JOB_NAME}] live DJ activity within ${lookbackSeconds}s; deferring ${Math.round(pauseMs / 1000)}s.`);
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
  console.log(`[${JOB_NAME}] ANALYZE album_metadata.`);
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
    console.log(
      `[${JOB_NAME}] (dry-run) batch resolved=${resolved.length} would-call bulkLookup with ${items.length} items.`
    );
    return { batchSize: items.length, match: 0, no_match: 0, error: 0, upserts: 0 };
  }

  if (items.length === 0) {
    return { batchSize: 0, match: 0, no_match: 0, error: 0, upserts: 0 };
  }

  const response = await bulkLookupMetadata(items, { budgetMs: options.budgetMs });
  // resolved[i] corresponds to items[i] which corresponds to response.results[i].
  // LML guarantees input-order results.
  let match = 0;
  let no_match = 0;
  let error = 0;
  let upserts = 0;
  for (const result of response.results) {
    if (result.status === 'match' && result.lookup) {
      match += 1;
      const album = resolved[result.index];
      if (!album) continue; // shouldn't happen given input-order guarantee
      const wrote = await upsertAlbumMatch(album.album_id, result.lookup);
      if (wrote) upserts += 1;
    } else if (result.status === 'no_match') {
      no_match += 1;
    } else {
      error += 1;
      const album = resolved[result.index];
      console.warn(
        `[${JOB_NAME}] lml.error album_id=${album?.album_id ?? '?'} message=${JSON.stringify(result.message ?? null)}`
      );
    }
  }
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
  console.log(
    `[${JOB_NAME}] start batchSize=${options.batchSize} ratePerMin=${options.ratePerMin} budgetMs=${options.budgetMs} dryRun=${options.dryRun}`
  );

  const albumIds = await enumeratePendingAlbumIds(options.readTimeoutMs);
  console.log(`[${JOB_NAME}] enumerated scanned=${albumIds.length} unique album_ids`);

  if (options.dryRun) {
    const batches = chunk(albumIds, options.batchSize);
    console.log(`[${JOB_NAME}] (dry-run) would run ${batches.length} batches of up to ${options.batchSize} items.`);
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
    const elapsedMs = Date.now() - t0;

    totalMatch += result.match;
    totalNoMatch += result.no_match;
    totalError += result.error;
    totalUpserts += result.upserts;

    console.log(
      `[${JOB_NAME}] batch=${i + 1}/${batches.length} size=${result.batchSize} match=${result.match} no_match=${result.no_match} error=${result.error} upserts=${result.upserts} elapsed_ms=${elapsedMs}`
    );

    if (i < batches.length - 1 && interBatchSleepMs > 0) {
      await sleep(interBatchSleepMs);
    }
  }

  if (totalUpserts > 0) await analyzeAlbumMetadata();

  // Pause again before the long post-pass UPDATE so a DJ going live mid-job
  // doesn't enter a 3-hour write window. Probe-and-defer happens BEFORE
  // opening the transaction, never inside it.
  await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);
  console.log(`[${JOB_NAME}] starting post-pass UPDATE (statement_timeout=${options.postPassTimeoutMs}ms)`);
  const t0 = Date.now();
  const flipped = await runPostPassUpdate(options.postPassTimeoutMs);
  const elapsedMs = Date.now() - t0;
  console.log(`[${JOB_NAME}] post-pass UPDATE flipped=${flipped} elapsed_ms=${elapsedMs}`);

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

const resolveTracesSampleRate = (raw: string | undefined): number => {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0;
  return parsed;
};

const main = async (): Promise<void> => {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: resolveTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
  });
  Sentry.setTag('repo', 'Backend-Service');
  Sentry.setTag('tool', JOB_NAME);

  try {
    const options = resolveOptions();
    const summary = await runBackfill(options);
    console.log(`[${JOB_NAME}] DONE ${JSON.stringify(summary)}`);
  } catch (err) {
    Sentry.captureException(err, { tags: { step: 'main' } });
    console.error(`[${JOB_NAME}] FAILED:`, err);
    process.exitCode = 1;
  } finally {
    await Sentry.close(2000);
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
