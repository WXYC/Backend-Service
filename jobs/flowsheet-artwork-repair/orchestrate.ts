/**
 * Orchestrator for flowsheet-artwork-repair drain (BS#1209).
 *
 * Two-phase one-shot:
 *
 *   1. **Free-form phase**: SELECT every flowsheet row where
 *      `metadata_status = 'enriched_match' AND artwork_url IS NULL AND
 *      album_id IS NULL`. For each row: lookup → repairFreeFormRow → count.
 *   2. **Linked phase**: SELECT album_metadata rows where `artwork_url IS
 *      NULL`, joined to library for (artist_name, album_title). For each
 *      album: lookup → repairLinkedAlbum → count.
 *
 * The orchestrator does NOT throttle per-row directly. LML pacing is
 * delegated to `@wxyc/lml-client`'s shared chokepoint (the `defaultLmlLimiter`
 * singleton in `lml-limiter.ts`, wired with `BACKFILL_LML_RATE_PER_MIN=20`
 * + `BACKFILL_LML_MAX_CONCURRENT=1` env defaults so a runaway pace can't
 * repeat the BS#994 monopolization incident). No per-job rate limiter that
 * bypasses the chokepoint — that's BS#1137.
 *
 * Cooperative pause mirrors `jobs/flowsheet-metadata-backfill/orchestrate.ts`:
 * probe `flowsheet` for any track row added within `LIVE_ACTIVITY_LOOKBACK_SECONDS`
 * (default 60 s); if found, defer the next row for `LIVE_ACTIVITY_PAUSE_MS`
 * (default 30 s) and re-probe. Set lookback to 0 for catch-up runs.
 *
 * Status read-only. The two repair writers are responsible for ensuring
 * `metadata_status` never appears in their .set() blocks; the orchestrator
 * trusts them. The "status-update-count == 0 from this job" acceptance
 * criterion is satisfied by the writer test pinning `'metadata_status' in
 * setArgs === false` (see repair.test.ts).
 *
 * The free-form enumeration runs in a `db.transaction` with `SET LOCAL
 * statement_timeout` because the predicate isn't covered by an existing
 * partial index — the planner falls back to a seq scan over flowsheet's
 * 2.6M+ rows. The backend's 5 s default would trip. Mirrors
 * `jobs/album-level-backfill/job.ts#enumeratePendingAlbumIds`. Linked
 * enumeration is bounded by `album_metadata`'s much smaller row count, so
 * the same wrapper is applied but the timeout rarely matters.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import type { FreeFormRow, LinkedAlbum, RepairOutcome } from './repair.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'flowsheet-artwork-repair';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const ALBUM_METADATA_TABLE = sql.raw(`"${SCHEMA}"."album_metadata"`);
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);

/** Default lookback window for the cooperative-pause probe. */
export const LIVE_ACTIVITY_LOOKBACK_SECONDS = 60;

/** Default sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS = 30_000;

/** Default statement_timeout for the enumeration queries. The free-form
 * predicate isn't covered by an existing partial index; the planner falls
 * back to a seq scan over flowsheet's 2.6M+ rows. 5 min covers observed
 * runtime with comfortable margin. Mirrors `album-metadata-backfill#verifyComplete`. */
export const ENUMERATE_TIMEOUT_MS = 5 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number => {
  if (raw === undefined) return LIVE_ACTIVITY_LOOKBACK_SECONDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid LIVE_ACTIVITY_LOOKBACK_SECONDS=${JSON.stringify(raw)}; must be a non-negative integer (s). Use 0 to disable.`
    );
  }
  return parsed;
};

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number => {
  if (raw === undefined) return LIVE_ACTIVITY_PAUSE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid LIVE_ACTIVITY_PAUSE_MS=${JSON.stringify(raw)}; must be a non-negative integer (ms).`);
  }
  return parsed;
};

export type CheckLiveActivityFn = (lookbackSeconds: number) => Promise<boolean>;

/**
 * Probe `flowsheet` for any track row added within the lookback window.
 * Returns `true` while DJs are actively touching the playout. Bypassed
 * entirely when `lookbackSeconds <= 0`. Uses the partial index from
 * migration 0050 for an index-only single-leaf lookup.
 */
export const checkLiveActivity: CheckLiveActivityFn = async (lookbackSeconds) => {
  if (lookbackSeconds <= 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1
    FROM ${FLOWSHEET_TABLE}
    WHERE "entry_type" = 'track'
      AND "add_time" > now() - (interval '1 second' * ${lookbackSeconds})
    LIMIT 1
  `)) as unknown as Array<unknown>;
  return rows.length > 0;
};

/**
 * SELECT every flowsheet row stranded by the LML#408 bug in the free-form
 * (no album_id) population. Wrapped in a transaction with `SET LOCAL
 * statement_timeout` so the predicate's uncovered seq scan can't blow the
 * backend's 5 s default.
 */
export const enumerateFreeFormResidue = async (timeoutMs: number = ENUMERATE_TIMEOUT_MS): Promise<FreeFormRow[]> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT
        "id",
        "artist_name",
        "album_title",
        "track_title"
      FROM ${FLOWSHEET_TABLE}
      WHERE "entry_type" = 'track'
        AND "artist_name" IS NOT NULL
        AND "metadata_status" = 'enriched_match'
        AND "artwork_url" IS NULL
        AND "album_id" IS NULL
      ORDER BY "id" ASC
    `)) as unknown as FreeFormRow[];
    return rows ?? [];
  });
};

/**
 * SELECT distinct album_ids whose `album_metadata` row carries NULL artwork,
 * joined to `library` for the (artist_name, album_title) lookup keys.
 * Album-level dedup: one row per album_id, even when many flowsheet rows
 * point at the same album. Mirrors the same `COALESCE(artists.artist_name,
 * library.artist_name)` shape as `album-level-backfill#resolveAlbums` so
 * legacy-and-unbackfilled library rows don't surface as the literal string
 * "null".
 */
export const enumerateLinkedResidue = async (timeoutMs: number = ENUMERATE_TIMEOUT_MS): Promise<LinkedAlbum[]> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT DISTINCT
        am."album_id" AS album_id,
        COALESCE(a."artist_name", l."artist_name") AS artist_name,
        l."album_title" AS album_title
      FROM ${ALBUM_METADATA_TABLE} am
      JOIN ${LIBRARY_TABLE} l ON l."id" = am."album_id"
      LEFT JOIN ${ARTISTS_TABLE} a ON l."artist_id" = a."id"
      WHERE am."artwork_url" IS NULL
        AND l."album_title" IS NOT NULL
        AND COALESCE(a."artist_name", l."artist_name") IS NOT NULL
      ORDER BY am."album_id" ASC
    `)) as unknown as Array<{ album_id: number; artist_name: string; album_title: string }>;
    return rows.map((r) => ({
      album_id: Number(r.album_id),
      artist_name: String(r.artist_name),
      album_title: String(r.album_title),
    }));
  });
};

export type LookupFn = (artist: string, album?: string, track?: string) => Promise<LookupResponse>;

export type FreeFormRepairFn = (row: FreeFormRow, response: LookupResponse) => Promise<RepairOutcome>;
export type LinkedRepairFn = (album: LinkedAlbum, response: LookupResponse) => Promise<RepairOutcome>;

export type Totals = {
  free_form_scanned: number;
  free_form_repaired: number;
  free_form_raced: number;
  linked_scanned: number;
  linked_repaired: number;
  linked_raced: number;
  still_null_after_lml: number;
  error: number;
};

export type RunResult = { totals: Totals };

const emptyTotals = (): Totals => ({
  free_form_scanned: 0,
  free_form_repaired: 0,
  free_form_raced: 0,
  linked_scanned: 0,
  linked_repaired: 0,
  linked_raced: 0,
  still_null_after_lml: 0,
  error: 0,
});

const awaitQuietWindow = async (
  lookbackSeconds: number,
  pauseMs: number,
  probe: CheckLiveActivityFn
): Promise<void> => {
  if (lookbackSeconds <= 0) return;
  while (await probe(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    if (pauseMs > 0) await sleep(pauseMs);
  }
};

export type RunRepairOptions = {
  lookup: LookupFn;
  repairFreeForm: FreeFormRepairFn;
  repairLinked: LinkedRepairFn;
  /** Pre-loaded rows. In production, supplied by `enumerateFreeFormResidue()`. */
  freeFormRows?: FreeFormRow[];
  /** Pre-loaded albums. In production, supplied by `enumerateLinkedResidue()`. */
  linkedAlbums?: LinkedAlbum[];
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
};

/**
 * Drive both phases end-to-end. Pre-loaded population can be passed via
 * `freeFormRows` / `linkedAlbums`; when omitted, the orchestrator calls
 * the enumeration helpers itself.
 *
 * Each row's LML call is wrapped in a try/catch — a single LML failure
 * is logged + counted as `error` and the loop continues. The row stays
 * in its original state (`metadata_status='enriched_match' AND artwork_url
 * IS NULL` for free-form; `album_metadata.artwork_url IS NULL` for linked),
 * so the next sweep can retry it. Idempotent.
 */
export const runRepair = async (opts: RunRepairOptions): Promise<RunResult> => {
  const lookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const pauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = opts.checkLiveActivity ?? checkLiveActivity;

  const freeFormRows = opts.freeFormRows ?? (await enumerateFreeFormResidue());
  const linkedAlbums = opts.linkedAlbums ?? (await enumerateLinkedResidue());

  log('info', 'started', `${JOB_NAME} starting`, {
    free_form_residue: freeFormRows.length,
    linked_residue: linkedAlbums.length,
    live_activity_lookback_seconds: lookbackSeconds,
    live_activity_pause_ms: pauseMs,
  });

  const totals = emptyTotals();

  // Phase 1: free-form residue
  for (const row of freeFormRows) {
    await awaitQuietWindow(lookbackSeconds, pauseMs, probe);
    totals.free_form_scanned += 1;

    let response: LookupResponse;
    try {
      response = await opts.lookup(row.artist_name, row.album_title ?? undefined, row.track_title ?? undefined);
    } catch (error) {
      log('warn', 'lml_error', `LML lookup failed for flowsheet.id=${row.id}`, {
        flowsheet_id: row.id,
        error_message: (error as Error).message,
      });
      captureError(error, 'lml_error', {
        phase: 'free_form',
        flowsheet_id: row.id,
        artist: row.artist_name,
        album: row.album_title,
        track: row.track_title,
      });
      totals.error += 1;
      continue;
    }

    const outcome = await opts.repairFreeForm(row, response);
    if (outcome === 'still_null_after_lml') totals.still_null_after_lml += 1;
    else if (outcome === 'free_form_repaired') totals.free_form_repaired += 1;
    else if (outcome === 'free_form_raced') totals.free_form_raced += 1;
  }

  // Phase 2: linked residue
  for (const album of linkedAlbums) {
    await awaitQuietWindow(lookbackSeconds, pauseMs, probe);
    totals.linked_scanned += 1;

    let response: LookupResponse;
    try {
      response = await opts.lookup(album.artist_name, album.album_title, undefined);
    } catch (error) {
      log('warn', 'lml_error', `LML lookup failed for album_id=${album.album_id}`, {
        album_id: album.album_id,
        error_message: (error as Error).message,
      });
      captureError(error, 'lml_error', {
        phase: 'linked',
        album_id: album.album_id,
        artist: album.artist_name,
        album: album.album_title,
      });
      totals.error += 1;
      continue;
    }

    const outcome = await opts.repairLinked(album, response);
    if (outcome === 'still_null_after_lml') totals.still_null_after_lml += 1;
    else if (outcome === 'linked_repaired') totals.linked_repaired += 1;
    else if (outcome === 'linked_raced') totals.linked_raced += 1;
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  return { totals };
};
