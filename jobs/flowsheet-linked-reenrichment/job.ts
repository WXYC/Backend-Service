/**
 * One-shot re-enrichment of the BS#1443 `enriched_no_match` linked cohort
 * (BS#1638).
 *
 * Clears the 22,773 flowsheet rows stuck at terminal
 * `metadata_status='enriched_no_match'` with `album_id IS NOT NULL` that no
 * automated path revisits (the CDC consumer fires on INSERT only, the sweep
 * targets `enriching`, and the metadata-backfill cron keys on
 * `metadata_attempt_at IS NULL`). The parent decision ticket (BS#1443) chose
 * Option 1 (one-shot re-enrichment) over Option 2 (re-arm the cron by
 * resetting `pending` + `metadata_attempt_at=NULL`) precisely so this job
 * leaves BS#1011's drain-completion signal and BS#895's C6 retune untouched:
 * it NEVER sets `metadata_status='pending'` and NEVER writes
 * `metadata_attempt_at`.
 *
 * The frozen cohort predicate (re-verified live 2026-07-13, exactly 22,773
 * rows) is applied in full to every SELECT and every UPDATE:
 *
 *   metadata_status = 'enriched_no_match'
 *   AND album_id IS NOT NULL
 *   AND artist_name IS NOT NULL
 *   AND add_time < '2026-06-16T17:53:53Z'::timestamptz
 *
 * NB: no `entry_type = 'track'` narrow. BS#1443's audit froze the count at
 * exactly these four clauses; adding a fifth risks stranding a non-track
 * cohort row that no automated path would ever revisit.
 *
 * Two lanes:
 *
 *   Lane A (pure SQL, zero LML calls) — cohort rows whose `album_id` already
 *   has a *populated* `album_metadata` row (`discogs_url IS NOT NULL OR
 *   artwork_url IS NOT NULL`) flip to `enriched_match`. ~15,231 rows / 523
 *   albums. Linked-row reads JOIN `album_metadata`, so no per-row metadata
 *   columns need writing (same as jobs/album-level-backfill/job.ts's paired
 *   post-pass UPDATE).
 *
 *   Lane B (LML re-lookup) — the ~314 residual albums (308 both-null in
 *   `album_metadata` + 6 absent). Batch through `bulkLookupMetadata`
 *   (LML#368, post-LML#784 recall fixes in prod). On match: fill-null UPSERT
 *   into `album_metadata` (never clobber a populated field) then flip that
 *   album's cohort rows. On no-match: leave the rows — post-#784 that is a
 *   verified verdict.
 *
 * Structural donor: jobs/album-level-backfill/job.ts (BS#1041) — same
 * fully-linked distinct-album-enrich + paired-row-flip shape. Write-shape
 * reference: apps/enrichment-worker/enrich.ts `finalizeRow` linked branch.
 * Sibling: jobs/flowsheet-reenrichment (BS#1433) drained the *unlinked*
 * (`album_id IS NULL`) cohort and documented this linked cohort as the
 * "match_raced orphan" rescue target; this job is that rescue.
 *
 * DRY-RUN IS THE DEFAULT — the container performs the scope SELECTs +
 * residual enumeration and logs planned counts with zero LML calls and zero
 * writes. Pass `--execute` to write. See README.md for the run procedure
 * (out-of-band partial index pre-flight, off-peak window, resume knobs).
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  album_metadata,
  db,
  closeDatabaseConnection,
  checkLiveActivity,
  requireNonNegativeInt,
  requirePositiveInt,
} from '@wxyc/database';
import { bulkLookupMetadata, type BulkLookupItem, type LookupResponse } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';
import * as Sentry from '@sentry/node';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'flowsheet-linked-reenrichment';

/**
 * Frozen cohort `add_time` upper bound (BS#1443, re-verified 2026-07-13).
 * A hard-coded literal, never operator-configurable — widening it would pull
 * in rows the parent audit never scoped. Bound as a SQL param (no injection
 * surface; it is a compile-time constant).
 */
export const COHORT_ADD_TIME_CUTOFF = '2026-06-16T17:53:53Z';

// -- Env knobs ---------------------------------------------------------------

/** Items per Lane B bulk-lookup request. LML hard cap is 100; default 5 is
 * the empirically-validated post-LML#370 ceiling under live enrichment-worker
 * contention (see jobs/album-level-backfill/job.ts for the canary history). */
export const BULK_BATCH_SIZE_ENV = 'LINKED_REENRICH_BULK_BATCH_SIZE';
export const BULK_BATCH_SIZE_DEFAULT = 5;

/** Lane B batches per minute. Bound the bulk caller so it can run without
 * saturating LML's serial Discogs fan-out (BS#995). */
export const BULK_RATE_PER_MIN_ENV = 'LINKED_REENRICH_BULK_RATE_PER_MIN';
export const BULK_RATE_PER_MIN_DEFAULT = 1;

/** Per-ITEM budget forwarded to LML as `X-Caller-Budget-Ms` (LML#345). */
export const BULK_BUDGET_MS_ENV = 'LINKED_REENRICH_BULK_BUDGET_MS';
export const BULK_BUDGET_MS_DEFAULT = 25_000;

/** Rows flipped per Lane A / Lane B UPDATE transaction. Batched per
 * docs/bulk-update-playbook.md so each transaction is short and the CDC
 * NOTIFY queue can't backpressure on the ~15k-row flip. */
export const FLIP_BATCH_SIZE_ENV = 'LINKED_REENRICH_FLIP_BATCH_SIZE';
export const FLIP_BATCH_SIZE_DEFAULT = 5000;

/** Statement timeout for each flip batch. */
export const FLIP_TIMEOUT_ENV = 'LINKED_REENRICH_FLIP_TIMEOUT_MS';
export const FLIP_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Statement timeout for the enumerate / count / resolve SELECTs. The cohort
 * predicate is covered by the out-of-band partial index the README asks the
 * operator to build (`flowsheet_linked_reenrichment_idx`); 5min is a wide
 * margin even if that pre-flight was skipped and the scan degrades. */
export const READ_TIMEOUT_ENV = 'LINKED_REENRICH_READ_TIMEOUT_MS';
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Statement timeout for the post-lane ANALYZE. Runs in its own raised-timeout
 * transaction because ANALYZE on the 2.6M-row flowsheet exceeds the 5s
 * connection default (BS#1638 prod run 1 aborted here). 5min is a wide margin. */
export const ANALYZE_TIMEOUT_ENV = 'LINKED_REENRICH_ANALYZE_TIMEOUT_MS';
export const ANALYZE_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Resume cursor for Lane B's residual-album enumeration. The summary log's
 * `last_album_id` carries the value to resume a stopped run from. Lane A's
 * flip is self-resuming (flipped rows drop out of the predicate) and needs
 * no cursor. */
export const ALBUM_AFTER_ID_ENV = 'LINKED_REENRICH_ALBUM_AFTER_ID';

/** Cooperative-pause lookback. If the most recent flowsheet track was added
 * within this window, defer. Default 300s (5 min) mirrors the donor — the
 * flip transactions hold write locks and we don't want them racing live
 * inserts. `0` disables the probe (catch-up). */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 300;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

// Bulk-fetch timeout sizing (identical derivation to the donor — see
// jobs/album-level-backfill/job.ts for the LML#370 / BS#1198 history).
export const BULK_PER_ITEM_TIMEOUT_MS = 5_000;
export const BULK_TIMEOUT_SLACK_MS = 5_000;
export const computeBulkTimeoutMs = (batchSize: number): number =>
  batchSize * BULK_PER_ITEM_TIMEOUT_MS + BULK_TIMEOUT_SLACK_MS;

// -- Cohort predicate --------------------------------------------------------

/** The frozen four-clause cohort predicate on a flowsheet alias `f`. Shared
 * by the Lane A flip, the Lane A scope count, and the Lane B residual
 * enumeration so they can never drift. */
const cohortPredicate = sql`
  f."metadata_status" = 'enriched_no_match'
  AND f."album_id" IS NOT NULL
  AND f."artist_name" IS NOT NULL
  AND f."add_time" < ${COHORT_ADD_TIME_CUTOFF}::timestamptz
`;

/** A populated `album_metadata` row is one with a real Discogs match signal.
 * Both-null rows (the stored no-match shape) are NOT populated and fall to
 * Lane B. Applied to an `album_metadata` alias `am`. */
const populatedAlbumMetadata = sql`(am."discogs_url" IS NOT NULL OR am."artwork_url" IS NOT NULL)`;

// -- Lane A: scope count -----------------------------------------------------

/** COUNT of cohort rows whose album already has populated metadata — the
 * "SELECT with the same WHERE first" the data-safety constraint asks for,
 * logged before the flip lane runs. */
export const countPopulatedFlipCandidates = async (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<number> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS count
      FROM "wxyc_schema"."flowsheet" f
      JOIN "wxyc_schema"."album_metadata" am ON am."album_id" = f."album_id"
      WHERE ${cohortPredicate}
        AND ${populatedAlbumMetadata}
    `)) as unknown as Array<{ count: number | string }>;
    return Number(rows?.[0]?.count ?? 0);
  });
};

// -- Lane A / Lane B: the flip -----------------------------------------------

/** Flip a single batch of cohort rows whose `album_id` now has populated
 * `album_metadata`. Wrapped in a transaction so `SET LOCAL statement_timeout`
 * applies (postgres-js auto-commits per execute otherwise). Returns the batch
 * size flipped. The `LIMIT` bounds the transaction; flipped rows leave the
 * `enriched_no_match` predicate so the next batch takes the next lowest ids —
 * a self-advancing cursor with no offset bookkeeping. The SET writes a
 * literal (`enriched_match`), never a COALESCE that could collapse to the
 * pre-flip value, so the loop always narrows (docs/bulk-update-playbook.md
 * infinite-loop pitfall). NB: `metadata_attempt_at` is deliberately left
 * untouched (BS#1011 / BS#895 invariant). */
export const flipBatch = async (batchSize: number, timeoutMs: number): Promise<number> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const result = await tx.execute(sql`
      WITH batch AS (
        SELECT f."id"
        FROM "wxyc_schema"."flowsheet" f
        JOIN "wxyc_schema"."album_metadata" am ON am."album_id" = f."album_id"
        WHERE ${cohortPredicate}
          AND ${populatedAlbumMetadata}
        ORDER BY f."id"
        LIMIT ${batchSize}
      )
      UPDATE "wxyc_schema"."flowsheet" f
      SET "metadata_status" = 'enriched_match'
      FROM batch
      WHERE f."id" = batch."id"
      RETURNING f."id"
    `);
    return (result as unknown as Array<{ id: number }>).length;
  });
};

/** Drive `flipBatch` until a batch flips 0 rows. Returns the total flipped.
 * Cooperative pause is checked before each batch so a DJ going live mid-drain
 * defers the next transaction (never interrupts an in-flight one). */
export const flipPopulatedCohort = async (
  lane: 'lane_a' | 'lane_b',
  batchSize: number,
  timeoutMs: number,
  liveActivityLookbackSeconds: number,
  liveActivityPauseMs: number
): Promise<number> => {
  let total = 0;
  let batchIndex = 0;
  for (;;) {
    await awaitQuietWindow(liveActivityLookbackSeconds, liveActivityPauseMs);
    const t0 = Date.now();
    const flipped = await flipBatch(batchSize, timeoutMs);
    total += flipped;
    batchIndex += 1;
    log('info', 'flip_batch_done', `${lane} flip batch ${batchIndex} flipped ${flipped}`, {
      lane,
      batch_index: batchIndex,
      flipped,
      total_flipped: total,
      wall_clock_ms: Date.now() - t0,
    });
    if (flipped === 0) break;
  }
  return total;
};

// -- Lane B: residual enumeration + resolution -------------------------------

/** Distinct cohort album_ids with NO populated `album_metadata` row — the
 * both-null (stored no-match) rows plus the absent ones. Resume-cursored on
 * `album_id > afterId`. */
export const enumerateResidualAlbumIds = async (
  afterId: number = 0,
  timeoutMs: number = READ_TIMEOUT_DEFAULT
): Promise<number[]> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT DISTINCT f."album_id"
      FROM "wxyc_schema"."flowsheet" f
      LEFT JOIN "wxyc_schema"."album_metadata" am ON am."album_id" = f."album_id"
      WHERE ${cohortPredicate}
        AND (am."album_id" IS NULL OR (am."discogs_url" IS NULL AND am."artwork_url" IS NULL))
        AND f."album_id" > ${afterId}
      ORDER BY f."album_id"
    `)) as unknown as Array<{ album_id: number }>;
    return rows.map((r) => Number(r.album_id));
  });
};

export interface ResolvedAlbum {
  album_id: number;
  artist_name: string;
  album_title: string;
}

/** Resolve album_ids to LML lookup keys. Copied from the donor: `artists`
 * LEFT JOIN preferred (canonical normalized name), COALESCE down to
 * `library.artist_name`, the `IS NOT NULL` predicate drops legacy rows where
 * both are null (else `String(null)` would POST the literal "null"), and the
 * `'{1,2,3}'::int[]` array-literal binding (BS#1068/BS#1071). */
export const resolveAlbums = async (
  albumIds: number[],
  timeoutMs: number = READ_TIMEOUT_DEFAULT
): Promise<ResolvedAlbum[]> => {
  if (albumIds.length === 0) return [];
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

// -- Lane B: fill-null album_metadata UPSERT ---------------------------------

/** UPSERT a Lane B match into `album_metadata` with FILL-NULL conflict
 * semantics: the INSERT path (the 6 absent albums) writes LML's values; the
 * conflict path (the 308 both-null rows, which may already carry synthesized
 * spotify/youtube/bandcamp/soundcloud search URLs from the worker's no-match
 * arm) fills each column only where it is currently NULL —
 * `COALESCE(album_metadata.col, excluded.col)` — so a populated field is
 * never clobbered.
 *
 * `updated_at` is set to `NOW()` explicitly (NOT COALESCE'd — that would
 * freeze the timestamp and defeat the `updated_at < NOW()` race guard). The
 * guard prevents a concurrent fresher enrichment (worker / runtime path)
 * from being overwritten.
 *
 * The 8 BS#1336 extended columns (discogs_artist_id, label, …) are omitted
 * from both `values` and `set` — the bulk endpoint has no `extended` flag
 * (BS#1442), so writing them would clobber a worker-enriched row's extended
 * fields with nulls. Omitting them from `set` preserves them.
 *
 * Returns `true` when a write was attempted (top-1 had artwork), `false`
 * when the top-1 has no artwork (defensive; the caller already filters). */
export const upsertAlbumMatchFillNull = async (albumId: number, lookup: LookupResponse): Promise<boolean> => {
  const first = lookup.results?.[0];
  const artwork = first?.artwork;
  if (!artwork) return false;

  const payload = {
    artwork_url: filterSpacerGif(artwork.artwork_url),
    discogs_url: artwork.release_url ?? null,
    // Discogs returns 0 as "year unknown"; coerce to null.
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
      set: {
        artwork_url: sql`COALESCE(${album_metadata.artwork_url}, excluded."artwork_url")`,
        discogs_url: sql`COALESCE(${album_metadata.discogs_url}, excluded."discogs_url")`,
        release_year: sql`COALESCE(${album_metadata.release_year}, excluded."release_year")`,
        spotify_url: sql`COALESCE(${album_metadata.spotify_url}, excluded."spotify_url")`,
        apple_music_url: sql`COALESCE(${album_metadata.apple_music_url}, excluded."apple_music_url")`,
        youtube_music_url: sql`COALESCE(${album_metadata.youtube_music_url}, excluded."youtube_music_url")`,
        bandcamp_url: sql`COALESCE(${album_metadata.bandcamp_url}, excluded."bandcamp_url")`,
        soundcloud_url: sql`COALESCE(${album_metadata.soundcloud_url}, excluded."soundcloud_url")`,
        artist_bio: sql`COALESCE(${album_metadata.artist_bio}, excluded."artist_bio")`,
        artist_wikipedia_url: sql`COALESCE(${album_metadata.artist_wikipedia_url}, excluded."artist_wikipedia_url")`,
        // Explicit NOW() — never COALESCE'd. Freezing updated_at would neuter
        // the race guard below.
        updated_at: sql`NOW()`,
      },
      // Race guard: never clobber a fresher worker/runtime enrichment.
      setWhere: sql`${album_metadata.updated_at} < NOW()`,
    });
  return true;
};

// -- Cooperative pause -------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Loop: probe → if a DJ added a track within the lookback, sleep → re-probe.
 * Returns when the window is quiet. Uses the shared `checkLiveActivity`
 * (@wxyc/database) backed by migration 0050's partial index. */
export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live DJ activity within ${lookbackSeconds}s; deferring ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    await sleep(pauseMs);
  }
};

// -- ANALYZE -----------------------------------------------------------------

/**
 * Run an ANALYZE inside a transaction that raises `statement_timeout` off the
 * @wxyc/database 5s connection default (same wrapper the flip batches use).
 * ANALYZE on the 2.6M-row `flowsheet` runs well past 5s, so on the raw
 * connection it is cancelled — which aborted the whole job after Lane A on
 * BS#1638 prod run 1. A stats refresh is an optimization, not correctness, so
 * a failure here is swallowed (logged + Sentry) rather than allowed to abort a
 * data lane that already committed. ANALYZE is permitted inside a transaction
 * block (unlike VACUUM).
 */
const runAnalyze = async (
  table: 'flowsheet' | 'album_metadata',
  analyzeStmt: SQL,
  timeoutMs: number
): Promise<void> => {
  log('info', 'analyze_started', `ANALYZE ${table}`);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
      await tx.execute(analyzeStmt);
    });
  } catch (err) {
    log('warn', 'analyze_failed', `ANALYZE ${table} failed (non-fatal)`, {
      table,
      error_message: err instanceof Error ? err.message : String(err),
    });
    captureError(err, 'analyze_failed', { table });
  }
};

export const analyzeFlowsheet = (timeoutMs: number = ANALYZE_TIMEOUT_DEFAULT): Promise<void> =>
  runAnalyze('flowsheet', sql`ANALYZE "wxyc_schema"."flowsheet"`, timeoutMs);

export const analyzeAlbumMetadata = (timeoutMs: number = ANALYZE_TIMEOUT_DEFAULT): Promise<void> =>
  runAnalyze('album_metadata', sql`ANALYZE "wxyc_schema"."album_metadata"`, timeoutMs);

// -- Lane B: per-batch orchestration -----------------------------------------

export interface BatchResult {
  batchSize: number;
  match: number;
  no_match: number;
  lml_error: number;
  db_error: number;
  upserts: number;
  /** Count of per-result rows where `result.index` didn't equal the sent
   * position. LML honors input order today; a non-zero value means a future
   * refactor dropped that invariant and we skipped the write (BS#1088). */
  unexpected_index: number;
}

/** Run one Lane B chunk: resolve → bulk call → fill-null UPSERT matches. HTTP
 * failures are isolated per-batch (counted as `lml_error`); per-item LML
 * errors are isolated by LML. UPSERT failures are counted as `db_error` and
 * never abort the batch — the album stays residual and a re-run retries it. */
export const runBatch = async (
  albumIds: number[],
  options: { budgetMs: number; dryRun: boolean; readTimeoutMs?: number }
): Promise<BatchResult> => {
  const resolved = await resolveAlbums(albumIds, options.readTimeoutMs ?? READ_TIMEOUT_DEFAULT);
  const items = buildBulkItems(resolved);

  const empty: BatchResult = {
    batchSize: items.length,
    match: 0,
    no_match: 0,
    lml_error: 0,
    db_error: 0,
    upserts: 0,
    unexpected_index: 0,
  };

  if (options.dryRun) {
    log('info', 'batch_dry_run', `dry-run: would call bulkLookup with ${items.length} items`, {
      resolved: resolved.length,
      items: items.length,
    });
    return empty;
  }

  if (items.length === 0) return { ...empty, batchSize: 0 };

  const timeoutMs = computeBulkTimeoutMs(items.length);
  let response;
  try {
    response = await bulkLookupMetadata(items, {
      budgetMs: options.budgetMs,
      timeoutMs,
      caller: JOB_NAME,
    });
  } catch (err) {
    const firstAlbumId = resolved[0]?.album_id ?? null;
    const lastAlbumId = resolved[resolved.length - 1]?.album_id ?? null;
    const errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const extra = { size: items.length, first_album_id: firstAlbumId, last_album_id: lastAlbumId };
    log('warn', 'lml_batch_failed', 'bulkLookupMetadata threw; entire batch counted as lml_error', {
      ...extra,
      error_message: errorMessage,
    });
    captureError(err, 'lml_batch_failed', extra);
    return { ...empty, lml_error: items.length };
  }

  let match = 0;
  let no_match = 0;
  let lml_error = 0;
  let db_error = 0;
  let unexpected_index = 0;
  // First-mismatch coordinates, captured once so the Sentry event below carries
  // a concrete example without one breadcrumb per row (the default maxBreadcrumbs
  // is 100 FIFO; per-row emission under a full contract break would evict the
  // upstream LML span / DB trail before the captured event could attach to them).
  let firstMismatchIndex: number | null = null;
  let firstMismatchGot: number | null = null;
  let firstMismatchAlbumId: number | null = null;
  // (albumId, upsert-promise) so a rejected UPSERT can be counted as db_error
  // without aborting sibling writes.
  const upsertPromises: Array<Promise<boolean>> = [];
  for (let i = 0; i < items.length; i++) {
    const result = response.results[i];
    if (!result || result.index !== i) {
      unexpected_index += 1;
      if (firstMismatchIndex === null) {
        firstMismatchIndex = i;
        firstMismatchGot = result?.index ?? null;
        firstMismatchAlbumId = resolved[i]?.album_id ?? null;
      }
      log('warn', 'unexpected_result_index', `LML result.index mismatch at position ${i}; skipping write`, {
        expected_index: i,
        got_index: result?.index ?? null,
        album_id: resolved[i]?.album_id ?? null,
      });
      continue;
    }
    if (result.status === 'match' && result.lookup) {
      match += 1;
      const album = resolved[i];
      if (!album) continue;
      const lookup = result.lookup;
      upsertPromises.push(
        upsertAlbumMatchFillNull(album.album_id, lookup).catch((err) => {
          db_error += 1;
          log('warn', 'db_error', `album_metadata UPSERT failed for album_id=${album.album_id}`, {
            album_id: album.album_id,
            error_message: err instanceof Error ? err.message : String(err),
          });
          captureError(err, 'db_error', { album_id: album.album_id });
          return false;
        })
      );
    } else if (result.status === 'no_match') {
      no_match += 1;
    } else {
      lml_error += 1;
      const album = resolved[i];
      log('warn', 'lml_error', `LML per-item error for album_id=${album?.album_id ?? '?'}`, {
        album_id: album?.album_id ?? null,
        error_message: result.message ?? null,
      });
    }
  }
  const upserts = (await Promise.all(upsertPromises)).filter(Boolean).length;

  // Surface a non-zero `unexpected_index` to Sentry (mirrors the donor,
  // jobs/album-level-backfill/job.ts). Without a captured event the per-row
  // counter aggregates only in the `batch_done` / `finished` log lines and
  // evaporates from the Sentry Issues view at process exit — an operator
  // alerting on Sentry rather than log-scraping would miss a live break of
  // LML's input-order contract (BS#1088). One breadcrumb + one stable-
  // fingerprint message per non-zero batch caps FIFO pressure.
  if (unexpected_index > 0) {
    Sentry.addBreadcrumb({
      category: JOB_NAME,
      message: 'unexpected_result_index',
      level: 'warning',
      data: {
        mismatch_count: unexpected_index,
        first_mismatch_index: firstMismatchIndex,
        first_mismatch_got: firstMismatchGot,
        first_mismatch_album_id: firstMismatchAlbumId,
      },
    });
    Sentry.captureMessage(`${JOB_NAME}.unexpected_index`, {
      level: 'warning',
      tags: { source: JOB_NAME },
      extra: {
        unexpected_index,
        scanned: items.length,
        batch_first_id: resolved[0]?.album_id ?? null,
      },
      fingerprint: [JOB_NAME, 'unexpected_index'],
    });
  }

  return { batchSize: items.length, match, no_match, lml_error, db_error, upserts, unexpected_index };
};

// -- Top-level orchestration -------------------------------------------------

export interface ReenrichmentSummary {
  /** Lane A scope count logged before the flip. */
  lane_a_candidates: number;
  /** Rows flipped to enriched_match from populated album_metadata (both lanes). */
  flipped_from_album_metadata: number;
  lane_a_flipped: number;
  /** Lane B scope count logged before its paired flip (0 when no upserts ran). */
  lane_b_candidates: number;
  lane_b_flipped: number;
  /** Distinct residual albums enumerated for Lane B. */
  residual_albums: number;
  batches: number;
  lml_match: number;
  lml_no_match: number;
  lml_error: number;
  db_error: number;
  upserts: number;
  unexpected_index: number;
  last_album_id: number;
  dry_run: boolean;
}

export interface ReenrichmentOptions {
  bulkBatchSize: number;
  ratePerMin: number;
  budgetMs: number;
  flipBatchSize: number;
  flipTimeoutMs: number;
  readTimeoutMs: number;
  analyzeTimeoutMs: number;
  albumAfterId: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  dryRun: boolean;
}

/** Dry-run is the DEFAULT; writes require `--execute`. `--dry-run` is an
 * explicit no-op accepted for self-documenting run commands; passing both is
 * a fat-finger worth failing fast on. (apple-music-url-backfill pattern.) */
export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): ReenrichmentOptions => {
  const ctx = { context: JOB_NAME };
  return {
    bulkBatchSize: requirePositiveInt(env[BULK_BATCH_SIZE_ENV], BULK_BATCH_SIZE_ENV, BULK_BATCH_SIZE_DEFAULT, ctx),
    ratePerMin: requirePositiveInt(env[BULK_RATE_PER_MIN_ENV], BULK_RATE_PER_MIN_ENV, BULK_RATE_PER_MIN_DEFAULT, ctx),
    budgetMs: requirePositiveInt(env[BULK_BUDGET_MS_ENV], BULK_BUDGET_MS_ENV, BULK_BUDGET_MS_DEFAULT, ctx),
    flipBatchSize: requirePositiveInt(env[FLIP_BATCH_SIZE_ENV], FLIP_BATCH_SIZE_ENV, FLIP_BATCH_SIZE_DEFAULT, ctx),
    flipTimeoutMs: requirePositiveInt(env[FLIP_TIMEOUT_ENV], FLIP_TIMEOUT_ENV, FLIP_TIMEOUT_DEFAULT, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    analyzeTimeoutMs: requirePositiveInt(env[ANALYZE_TIMEOUT_ENV], ANALYZE_TIMEOUT_ENV, ANALYZE_TIMEOUT_DEFAULT, ctx),
    albumAfterId: requireNonNegativeInt(env[ALBUM_AFTER_ID_ENV], ALBUM_AFTER_ID_ENV, 0, {
      ...ctx,
      note: 'Resume cursor — the summary log of the previous run carries last_album_id.',
    }),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      { ...ctx, unit: 's', note: 'Use 0 to disable the cooperative pause.' }
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    dryRun: resolveDryRun(args),
  };
};

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const runReenrichment = async (options: ReenrichmentOptions): Promise<ReenrichmentSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    dry_run: options.dryRun,
    bulk_batch_size: options.bulkBatchSize,
    rate_per_min: options.ratePerMin,
    flip_batch_size: options.flipBatchSize,
    album_after_id: options.albumAfterId,
  });

  const summary: ReenrichmentSummary = {
    lane_a_candidates: 0,
    flipped_from_album_metadata: 0,
    lane_a_flipped: 0,
    lane_b_candidates: 0,
    lane_b_flipped: 0,
    residual_albums: 0,
    batches: 0,
    lml_match: 0,
    lml_no_match: 0,
    lml_error: 0,
    db_error: 0,
    upserts: 0,
    unexpected_index: 0,
    last_album_id: options.albumAfterId,
    dry_run: options.dryRun,
  };

  // ---- Lane A: flip from existing populated album_metadata ----------------
  summary.lane_a_candidates = await countPopulatedFlipCandidates(options.readTimeoutMs);
  log('info', 'lane_a_scope', `Lane A: ${summary.lane_a_candidates} cohort rows joinable to populated metadata`, {
    lane_a_candidates: summary.lane_a_candidates,
  });

  if (!options.dryRun) {
    summary.lane_a_flipped = await flipPopulatedCohort(
      'lane_a',
      options.flipBatchSize,
      options.flipTimeoutMs,
      options.liveActivityLookbackSeconds,
      options.liveActivityPauseMs
    );
    if (summary.lane_a_flipped > 0) await analyzeFlowsheet(options.analyzeTimeoutMs);
  }

  // ---- Lane B: LML re-lookup for the residual albums ----------------------
  const residual = await enumerateResidualAlbumIds(options.albumAfterId, options.readTimeoutMs);
  summary.residual_albums = residual.length;
  log('info', 'lane_b_enumerated', `Lane B: ${residual.length} residual albums`, {
    residual_albums: residual.length,
    album_after_id: options.albumAfterId,
  });

  const batches = chunk(residual, options.bulkBatchSize);
  summary.batches = batches.length;

  if (options.dryRun) {
    log(
      'info',
      'dry_run_plan',
      `(dry-run) would run ${batches.length} Lane B batches of up to ${options.bulkBatchSize}`,
      {
        batches: batches.length,
        bulk_batch_size: options.bulkBatchSize,
      }
    );
    summary.flipped_from_album_metadata = summary.lane_a_flipped + summary.lane_b_flipped;
    log('info', 'finished', `${JOB_NAME} done (dry-run)`, { ...summary });
    return summary;
  }

  const interBatchSleepMs = Math.max(0, Math.floor(60_000 / options.ratePerMin));
  for (let i = 0; i < batches.length; i += 1) {
    await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);

    const t0 = Date.now();
    const result = await runBatch(batches[i], {
      budgetMs: options.budgetMs,
      dryRun: false,
      readTimeoutMs: options.readTimeoutMs,
    });
    summary.lml_match += result.match;
    summary.lml_no_match += result.no_match;
    summary.lml_error += result.lml_error;
    summary.db_error += result.db_error;
    summary.upserts += result.upserts;
    summary.unexpected_index += result.unexpected_index;
    summary.last_album_id = batches[i][batches[i].length - 1] ?? summary.last_album_id;

    log('info', 'batch_done', `Lane B batch ${i + 1}/${batches.length} done`, {
      batch_index: i + 1,
      batches: batches.length,
      scanned: result.batchSize,
      match: result.match,
      no_match: result.no_match,
      lml_error: result.lml_error,
      db_error: result.db_error,
      upserts: result.upserts,
      unexpected_index: result.unexpected_index,
      last_album_id: summary.last_album_id,
      wall_clock_ms: Date.now() - t0,
    });

    if (i < batches.length - 1 && interBatchSleepMs > 0) await sleep(interBatchSleepMs);
  }

  // Flip the cohort rows for albums Lane B just populated. Same UPDATE as
  // Lane A; because Lane A already flipped the pre-populated albums, this
  // pass touches only Lane B's new matches.
  if (summary.upserts > 0) {
    await analyzeAlbumMetadata(options.analyzeTimeoutMs);
    // Scope-verifying SELECT before the Lane B UPDATE lane (spec: "Run the
    // scope-verifying SELECT before each UPDATE lane"), mirroring Lane A's
    // pre-flip count. After the ANALYZE above, the still-`enriched_no_match`
    // cohort rows for Lane B's newly-populated albums now match
    // `populatedAlbumMetadata`; Lane A already flipped the pre-populated
    // albums, so this count is exactly Lane B's flippable rows.
    summary.lane_b_candidates = await countPopulatedFlipCandidates(options.readTimeoutMs);
    log('info', 'lane_b_scope', `Lane B: ${summary.lane_b_candidates} cohort rows now joinable to populated metadata`, {
      lane_b_candidates: summary.lane_b_candidates,
    });
    summary.lane_b_flipped = await flipPopulatedCohort(
      'lane_b',
      options.flipBatchSize,
      options.flipTimeoutMs,
      options.liveActivityLookbackSeconds,
      options.liveActivityPauseMs
    );
    if (summary.lane_b_flipped > 0) await analyzeFlowsheet(options.analyzeTimeoutMs);
  }

  summary.flipped_from_album_metadata = summary.lane_a_flipped + summary.lane_b_flipped;
  log('info', 'finished', `${JOB_NAME} done`, { ...summary });
  return summary;
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = resolveOptions();
    if (!options.dryRun && !process.env.LIBRARY_METADATA_URL) {
      throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any writes (Lane B needs LML).');
    }
    await runReenrichment(options);
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
// against the mocked DB (NODE_ENV='test' under jest; production leaves it
// 'production' or unset).
if (process.env.NODE_ENV !== 'test') {
  void main();
}
