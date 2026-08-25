/**
 * Orchestrator for the artwork-provenance-remediation drain (BS#2258).
 *
 * One pass: enumerate every `album_metadata` row whose `artwork_url` is
 * Discogs-hosted, keep the ones whose URL provably depicts an artist or a
 * label rather than the release, re-ask LML, and hand each answer to the
 * writer.
 *
 * **Why the SQL predicate is coarse and the decision is made in TypeScript.**
 * The provenance lives in a base64url blob split across the URL's path
 * segments; a `LIKE` cannot read it, and decoding it in SQL means a second
 * implementation of the rule — with its own padding arithmetic — that no test
 * covers and that silently disagrees with the shared decoder the writer uses
 * to classify LML's *replacement*. Two implementations of one rule, one of
 * them untested, on either side of a 7,950-row overwrite is the wrong trade.
 * So SQL narrows to `i.discogs.com` (41,333 of 41,524 artwork-bearing rows as
 * of 2026-08-24 — the rest are Apple `mzstatic`) and
 * `classifyArtworkProvenance` decides. One scan, auditable SQL, one tested
 * rule.
 *
 * **The selector is a positive match.** `selectWrongProvenance` keeps only
 * `artist` and `label`; `unclassified` is dropped. Apple covers and legacy
 * pre-imgproxy Discogs URLs decode to nothing and are perfectly good artwork,
 * so a "not release" selector would sweep all 191 of them into an overwrite.
 *
 * LML pacing is delegated to `@wxyc/lml-client`'s shared chokepoint via this
 * job's own limiter (`lml-limiter.ts`, `BACKFILL_LML_*` env ceiling shared
 * with the sibling drains), never a per-job rate limiter that bypasses it
 * (the BS#1137 antipattern). Cooperative pause mirrors
 * `jobs/flowsheet-artwork-repair/orchestrate.ts`: probe `flowsheet` for live
 * activity and defer while a DJ is on air.
 *
 * Per-row error isolation: an LML throw is logged, counted, and skipped. The
 * row keeps its wrong artwork, so it re-selects on the next run. Combined
 * with the writer's exact-value guard, the whole drain is idempotent and
 * order-independent.
 */

import { sql } from 'drizzle-orm';
import {
  db,
  checkLiveActivity as defaultCheckLiveActivity,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  resolveLiveActivityMaxPauseMs as resolveLiveActivityMaxPauseMsShared,
  buildWaitForQuietPeriod,
  requireNonNegativeInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import * as Sentry from '@sentry/node';
import { LmlAuthError, lmlApiKeyFingerprint, type LookupResponse } from '@wxyc/lml-client';
import { classifyArtworkProvenance, isWrongArtworkProvenance } from '@wxyc/metadata';
import type { RemediationOutcome, WrongArtworkRow } from './remediate.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'artwork-provenance-remediation';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ALBUM_METADATA_TABLE = sql.raw(`"${SCHEMA}"."album_metadata"`);
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);

/**
 * The enumeration reads every Discogs-hosted artwork row in one pass — ~41k
 * rows of three short columns. Not index-covered; 5 min mirrors the sibling
 * drains' ceiling with room to spare.
 */
export const ENUMERATE_TIMEOUT_MS = 5 * 60 * 1000;

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    unit: 's',
    note: 'Use 0 to disable.',
  });

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  resolveLiveActivityPauseMsShared(raw, 'LIVE_ACTIVITY_PAUSE_MS');

export const resolveLiveActivityMaxPauseMs = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_MAX_PAUSE_MS
): number => resolveLiveActivityMaxPauseMsShared(raw, LIVE_ACTIVITY_MAX_PAUSE_MS_ENV);

/**
 * Every `album_metadata` row carrying Discogs-hosted artwork, joined to
 * `library` for the (artist, album) lookup keys. The `COALESCE(artists.
 * artist_name, library.artist_name)` shape matches `album-level-backfill`
 * and the sibling repair drain so legacy un-backfilled rows don't surface as
 * the literal string "null".
 *
 * This is a superset of the drain population by design — `selectWrongProvenance`
 * makes the actual decision. See the module docstring.
 */
export const enumerateDiscogsArtwork = async (timeoutMs: number = ENUMERATE_TIMEOUT_MS): Promise<WrongArtworkRow[]> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT
        am."album_id" AS album_id,
        COALESCE(a."artist_name", l."artist_name") AS artist_name,
        l."album_title" AS album_title,
        am."artwork_url" AS artwork_url
      FROM ${ALBUM_METADATA_TABLE} am
      JOIN ${LIBRARY_TABLE} l ON l."id" = am."album_id"
      LEFT JOIN ${ARTISTS_TABLE} a ON l."artist_id" = a."id"
      WHERE am."artwork_url" IS NOT NULL
        AND am."artwork_url" LIKE '%i.discogs.com%'
        AND l."album_title" IS NOT NULL
        AND COALESCE(a."artist_name", l."artist_name") IS NOT NULL
      ORDER BY am."album_id" ASC
    `)) as unknown as Array<Record<string, unknown>>;
    return (rows ?? []).map((r) => ({
      album_id: Number(r.album_id),
      artist_name: String(r.artist_name),
      album_title: String(r.album_title),
      artwork_url: String(r.artwork_url),
    }));
  });
};

/**
 * Keep only the rows whose stored artwork provably depicts something other
 * than the release. Positive match — see the module docstring on why
 * `unclassified` must not be swept in.
 */
export const selectWrongProvenance = (rows: WrongArtworkRow[]): WrongArtworkRow[] =>
  rows.filter((row) => isWrongArtworkProvenance(row.artwork_url));

/**
 * The `A-`/`L-` split of a selected population, so a run can be reconciled
 * against BS#2258's own counts before it spends a single `updated_at`. Rows
 * the selector would have dropped contribute to neither bucket — this counts
 * positively, for the same reason the selector matches positively.
 */
export const summarizePopulation = (rows: WrongArtworkRow[]): { artist_image: number; label_logo: number } => {
  const split = { artist_image: 0, label_logo: 0 };
  for (const row of rows) {
    const provenance = classifyArtworkProvenance(row.artwork_url);
    if (provenance === 'artist') split.artist_image += 1;
    else if (provenance === 'label') split.label_logo += 1;
  }
  return split;
};

export type LookupFn = (artist: string, album: string) => Promise<LookupResponse>;
export type RemediateFn = (row: WrongArtworkRow, response: LookupResponse) => Promise<RemediationOutcome>;

/**
 * Per-outcome counts. `artist_image` / `label_logo` record the *pre-drain*
 * split of the selected population — BS#2258's acceptance criteria ask for
 * the counts to be re-measured and reported at implementation time, and the
 * drain is the last moment they can be observed before `updated_at` is spent.
 */
export type Totals = {
  discogs_artwork_rows: number;
  artist_image: number;
  label_logo: number;
  scanned: number;
  healed: number;
  still_wrong: number;
  no_match: number;
  raced: number;
  error: number;
};

export type RunResult = { totals: Totals };

const emptyTotals = (): Totals => ({
  discogs_artwork_rows: 0,
  artist_image: 0,
  label_logo: 0,
  scanned: 0,
  healed: 0,
  still_wrong: 0,
  no_match: 0,
  raced: 0,
  error: 0,
});

export type RunRemediationOptions = {
  lookup: LookupFn;
  remediate: RemediateFn;
  /** Pre-selected rows. In production, supplied by the enumerate + select pair. */
  rows?: WrongArtworkRow[];
  /**
   * How many rows the enumeration returned before selection. Only the caller
   * that ran the scan knows it, and it is what makes `selected` legible in
   * the run log (7,950 of 41,333 vs. an unqualified 7,950).
   */
  discogsArtworkRows?: number;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  /** Cumulative cooperative-pause budget ceiling; 0 = uncapped. */
  liveActivityMaxPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
};

export const runRemediation = async (opts: RunRemediationOptions): Promise<RunResult> => {
  const lookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const pauseMs = opts.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const maxTotalPauseMs = opts.liveActivityMaxPauseMs ?? resolveLiveActivityMaxPauseMs();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;

  const waitForQuietPeriod = buildWaitForQuietPeriod({
    lookbackSeconds,
    pauseMs,
    maxTotalPauseMs,
    probe,
    onPause: () => {
      log('info', 'live_activity_pause', `live flowsheet activity detected; pausing ${pauseMs}ms`, {
        lookback_seconds: lookbackSeconds,
        pause_ms: pauseMs,
      });
    },
    onProbeError: (error) => {
      log('warn', 'probe_error', 'checkLiveActivity threw; assuming no activity', {
        error_message: error instanceof Error ? error.message : String(error),
      });
      captureError(error, 'probe_error');
    },
    onBudgetExhausted: (pausedMs) => {
      log(
        'error',
        'live_activity_pause_ceiling_exceeded',
        `cooperative-pause budget exceeded (${pausedMs}ms >= LIVE_ACTIVITY_MAX_PAUSE_MS=${maxTotalPauseMs}ms); aborting instead of pausing indefinitely`,
        { paused_ms: pausedMs, live_activity_max_pause_ms: maxTotalPauseMs }
      );
    },
  });

  const totals = emptyTotals();

  // The selector is re-applied even to caller-supplied rows. `rows` is a
  // public entry point, and the property the whole design rests on -- an
  // Apple cover or a release cover can never enter the drain -- has to hold
  // at the boundary that writes, not at one call site in `job.ts`. A future
  // resumable or `--limit` variant that assembles its own rows gets the
  // guarantee for free instead of having to remember it.
  let rows: WrongArtworkRow[];
  if (opts.rows) {
    totals.discogs_artwork_rows = opts.discogsArtworkRows ?? 0;
    rows = selectWrongProvenance(opts.rows);
  } else {
    const candidates = await enumerateDiscogsArtwork();
    totals.discogs_artwork_rows = candidates.length;
    rows = selectWrongProvenance(candidates);
  }
  Object.assign(totals, summarizePopulation(rows));

  log('info', 'started', `${JOB_NAME} starting`, {
    discogs_artwork_rows: totals.discogs_artwork_rows,
    selected: rows.length,
    artist_image: totals.artist_image,
    label_logo: totals.label_logo,
    live_activity_lookback_seconds: lookbackSeconds,
    live_activity_pause_ms: pauseMs,
    live_activity_max_pause_ms: maxTotalPauseMs,
  });

  // `finished` is emitted from a `finally` because the totals ARE the
  // deliverable -- BS#2258's acceptance criteria ask for the per-row outcome
  // counts to be reported. Losing six hours of accounting to a throw on the
  // last row would mean re-earning it with a full re-run.
  try {
    for (const row of rows) {
      await waitForQuietPeriod();
      totals.scanned += 1;

      let response: LookupResponse;
      try {
        response = await opts.lookup(row.artist_name, row.album_title);
      } catch (error) {
        // A rejected bearer is global, not per-row: every remaining row would
        // fail identically, so counting it and continuing paces the whole
        // population through at 20/min, emits one Sentry event per row with no
        // aggregate signal, and still exits 0. Abort on the first one (the
        // BS#1094 silent-stall shape; same handling as
        // `jobs/flowsheet-metadata-backfill/orchestrate.ts`).
        if (error instanceof LmlAuthError) {
          const bearerFingerprint = lmlApiKeyFingerprint() ?? 'unset';
          Sentry.addBreadcrumb({
            category: 'lml.auth',
            message: `LML rejected the shared bearer with ${error.statusCode}`,
            level: 'error',
            data: { bearer_fingerprint: bearerFingerprint, status_code: error.statusCode, album_id: row.album_id },
          });
          log(
            'error',
            'lml_auth_error',
            `LML rejected the shared LML_API_KEY bearer (status ${error.statusCode}) on album_id=${row.album_id} — aborting run instead of looping`,
            { album_id: row.album_id, status_code: error.statusCode, bearer_fingerprint: bearerFingerprint }
          );
          captureError(error, 'lml_auth_error', {
            album_id: row.album_id,
            artist: row.artist_name,
            album: row.album_title,
            status_code: error.statusCode,
            bearer_fingerprint: bearerFingerprint,
          });
          throw error;
        }
        log('warn', 'lml_error', `LML lookup failed for album_id=${row.album_id}`, {
          album_id: row.album_id,
          error_message: error instanceof Error ? error.message : String(error),
        });
        captureError(error, 'lml_error', {
          album_id: row.album_id,
          artist: row.artist_name,
          album: row.album_title,
          provenance: classifyArtworkProvenance(row.artwork_url),
        });
        totals.error += 1;
        continue;
      }

      // The write is isolated too, and for the opposite reason to the auth
      // case: a lock timeout or a connection blip is per-row and self-healing
      // -- the row keeps its wrong artwork and re-selects on the next run --
      // so letting it escape would trade a recoverable row for the whole run's
      // accounting.
      try {
        const outcome = await opts.remediate(row, response);
        totals[outcome] += 1;
      } catch (error) {
        log('warn', 'write_error', `write failed for album_id=${row.album_id}`, {
          album_id: row.album_id,
          error_message: error instanceof Error ? error.message : String(error),
        });
        captureError(error, 'write_error', { album_id: row.album_id, album: row.album_title });
        totals.error += 1;
      }
    }
  } finally {
    log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  }
  return { totals };
};
