/**
 * Two-phase orchestrator for the BS#2000 V/A Apple-URL remediation.
 *
 * LML's pre-#1139 Apple track matcher had no V/A awareness on the artist axis:
 * the constant `Various Artists - ` prefix alone scores ~85 between any two V/A
 * credits, so the LML#782 album-dropped fallback re-admitted winners on a
 * vacuous artist plus a generic standard's title. BS persisted those wrong
 * deep-links, and BS persistence is fill-only, so they are frozen.
 *
 * THE POLLUTION LIVES IN TWO PLACES, AND THEY NEED DIFFERENT FIXES.
 *
 * `apps/backend/services/flowsheet.service.ts` serves
 * `coalesce(album_metadata.apple_music_url, flowsheet.apple_music_url)`, and
 * `apps/enrichment-worker/enrich.ts` writes BOTH from the same track-aware
 * Apple probe — `album_metadata` for linked rows, `flowsheet` inline for the
 * unlinked-only branch. (The issue body's "album_metadata is filled from
 * album-level lookups, do not touch it" conflates the album *matcher* with the
 * album_metadata *table*; see the issue comment for the correction.) What
 * differs is the recovery path available to each:
 *
 *   * `album_metadata` HAS a re-ask lane. `apple_music_status` disambiguates a
 *     null (BS#1915/BS#1192), and the hourly `streaming-reask.ts` sweep
 *     re-asks LML for any row with `apple_music_status = 'unresolved'` under
 *     the `streaming_reask_attempts` cap. So this job does NOT re-verify those
 *     rows itself — it invalidates them (url NULL, status 'unresolved',
 *     attempts reset) and lets the purpose-built sweep re-adjudicate them
 *     through the now-guarded matcher. Pure SQL, zero LML calls, and no need
 *     to invent a track: `album_metadata` is album-keyed while the URL it
 *     holds is a *track* deep-link, so there is no honest (artist, album,
 *     track) triple to re-query with. Note this is also why the pollution is
 *     frozen without us: `resolveStreamingConflict` never overwrites a
 *     `'verified'` URL, and a URL's mere existence infers `'verified'`.
 *
 *   * `flowsheet` has NO such lane. There is no status column, and the
 *     enrichment worker never revisits `enriched_match` rows, so a null there
 *     is terminal. Those rows therefore get the real re-verify: one LML
 *     lookup per DISTINCT (artist, album, track), fanned to every row carrying
 *     that triple, with the three-way verdict in `verdict.ts` deciding.
 *
 * PHASE ORDER IS LOAD-BEARING: flowsheet FIRST. Nulling `album_metadata`
 * unmasks whatever `flowsheet.apple_music_url` holds for the same row, because
 * the read-path coalesce falls through. Doing album_metadata first would open
 * a window in which the polluted flowsheet value is the one being served —
 * strictly worse than the status quo. Cleaning flowsheet first means the
 * fall-through target is already correct by the time the mask is lifted.
 *
 * Candidate net: `apple_music_url IS NOT NULL` plus a coarse V/A regex over
 * `wxyc_schema.fold_artist_name(...)`, with `isVariousArtistsCredit`
 * (va-artist.ts) as the true arbiter within the net. The fold has to happen in
 * SQL — `lower('Vàrious Artists')` matches none of the alternatives, so a
 * lower()-based net would filter out diacritic rows before the arbiter ever
 * saw them. `album_metadata` carries no artist column, so its net joins
 * `library` (and `artists`) to reach one.
 *
 * Dry-run is the default and makes ZERO LML calls and zero writes, so sizing
 * the job is free.
 */

import { sql } from 'drizzle-orm';
import {
  db,
  checkLiveActivity as defaultCheckLiveActivity,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
  requireNonNegativeInt,
  requirePositiveInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import { isVariousArtistsCredit } from './va-artist.js';
import { classifyResponse, type Verdict } from './verdict.js';
import { lookupMetadata as defaultLookup } from './lml-fetch.js';
import {
  evaluateRescueRate,
  newRescueTracker,
  MAX_RESCUE_RATE_DEFAULT,
  MIN_RESCUE_SAMPLE_DEFAULT,
  type RescueTracker,
} from './calibrate.js';
import { captureError, errorMessage, log } from './logger.js';

const JOB_NAME = 'va-apple-music-url-remediation';

/**
 * Coarse V/A superset over `fold_artist_name` output.
 *
 * Kept in lockstep with LML#1139's purge net
 * (`scripts/purge_va_apple_track_cache.py`). The `v[./]\s*a\.?` alternative is
 * WIDENED from the donor's `v\.a\.`: measurement showed `v.a`, `v.a - jazz`
 * and `v.a 1998` are all `is_compilation_artist`-positive but do not match a
 * trailing-dot-required pattern, so the donor form is not actually a superset
 * and those rows would never be selected.
 */
export const VA_NET_REGEX = '(various|soundtrack|compilation|v[./]\\s*a\\.?)';

export const BATCH_SIZE = 2000;
export const UPDATE_TIMEOUT_MS_DEFAULT = 300_000;
export const ANALYZE_TIMEOUT_MS_DEFAULT = 300_000;
export const SECOND_PASS_DELAY_MS_DEFAULT = 15_000;
/** Consecutive null passes required before a `none` verdict may NULL a row. */
export const NULL_CONFIRMATION_PASSES = 3;
export const SAMPLE_SIZE_DEFAULT = 20;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const ALBUM_METADATA_TABLE = sql.raw(`"${SCHEMA}"."album_metadata"`);
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);
const FOLD_FN = sql.raw(`"${SCHEMA}"."fold_artist_name"`);

const LOAD_BATCH_MAX_ATTEMPTS = 3;
const LOAD_BATCH_BACKOFF_MS = [500, 2000];
const LOOKUP_MAX_ATTEMPTS = 3;
const LOOKUP_BACKOFF_MS = [1000, 4000];

export type LookupFn = (artist: string, album?: string, track?: string) => Promise<unknown>;

interface FlowsheetRow {
  id: number;
  artist_name: string | null;
  album_title: string | null;
  track_title: string | null;
  apple_music_url: string | null;
}

export interface FlowsheetTotals {
  candidates: number;
  scanned: number;
  /** Rows whose artist passed the arbiter (the net is broader than the rule). */
  arbitrated: number;
  distinctTriples: number;
  written_url: number;
  written_null: number;
  /** Rows whose stored URL changed under us between SELECT and UPDATE. */
  skipped_changed_under_us: number;
  indeterminate: number;
  rescued: number;
  first_pass_nulls: number;
  batches: number;
  last_id: number;
  sample: Array<{ id: number; before: string | null; after: string | null }>;
  indeterminateTriples: string[];
}

export interface AlbumTotals {
  candidates: number;
  invalidated: number;
  batches: number;
  last_id: number;
}

export interface RunResult {
  flowsheet: FlowsheetTotals;
  album_metadata: AlbumTotals;
  dryRun: boolean;
  stopped: boolean;
  failed: boolean;
}

/** Dry-run is the DEFAULT: writes require the explicit `--execute` flag. */
export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveBatchSize = (raw: string | undefined = process.env.VA_REMEDIATION_BATCH_SIZE): number =>
  requirePositiveInt(raw, 'VA_REMEDIATION_BATCH_SIZE', BATCH_SIZE);

/**
 * Resume cursor. `requireNonNegativeInt`, NOT the donor's `envInt` — that one
 * requires `> 0`, so `VA_REMEDIATION_*_AFTER_ID=0` would warn and silently fall
 * back instead of meaning "start at the beginning".
 */
export const resolveAfterId = (envName: string, raw: string | undefined): number =>
  requireNonNegativeInt(raw, envName, 0, {
    note: 'Resume cursor — the summary log of the previous run carries the per-phase last_id.',
  });

export const resolveUpdateTimeoutMs = (
  raw: string | undefined = process.env.VA_REMEDIATION_UPDATE_TIMEOUT_MS
): number => requirePositiveInt(raw, 'VA_REMEDIATION_UPDATE_TIMEOUT_MS', UPDATE_TIMEOUT_MS_DEFAULT);

export const resolveAnalyzeTimeoutMs = (
  raw: string | undefined = process.env.VA_REMEDIATION_ANALYZE_TIMEOUT_MS
): number => requirePositiveInt(raw, 'VA_REMEDIATION_ANALYZE_TIMEOUT_MS', ANALYZE_TIMEOUT_MS_DEFAULT);

export const resolveSecondPassDelayMs = (
  raw: string | undefined = process.env.VA_REMEDIATION_SECOND_PASS_DELAY_MS
): number =>
  requireNonNegativeInt(raw, 'VA_REMEDIATION_SECOND_PASS_DELAY_MS', SECOND_PASS_DELAY_MS_DEFAULT, {
    unit: 'ms',
    note: 'Delay between confirmation passes — LML#706 fills the streaming post-process asynchronously.',
  });

export const resolveMaxRescueRate = (raw: string | undefined = process.env.VA_REMEDIATION_MAX_RESCUE_RATE): number => {
  if (raw === undefined || raw === '') return MAX_RESCUE_RATE_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`VA_REMEDIATION_MAX_RESCUE_RATE must be a fraction in (0, 1]; got ${raw}`);
  }
  return parsed;
};

export const resolveMinRescueSample = (
  raw: string | undefined = process.env.VA_REMEDIATION_MIN_RESCUE_SAMPLE
): number => requireNonNegativeInt(raw, 'VA_REMEDIATION_MIN_RESCUE_SAMPLE', MIN_RESCUE_SAMPLE_DEFAULT);

export const resolveMaxIndeterminate = (
  raw: string | undefined = process.env.VA_REMEDIATION_MAX_INDETERMINATE
): number =>
  requireNonNegativeInt(raw, 'VA_REMEDIATION_MAX_INDETERMINATE', 0, {
    note: 'Use 0 for no early-abort ceiling; the run still exits non-zero if any triple stays indeterminate.',
  });

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    unit: 's',
    note: 'Use 0 to disable the cooperative pause.',
  });

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_PAUSE_MS', LIVE_ACTIVITY_PAUSE_MS_DEFAULT, { unit: 'ms' });

let stopRequested = false;
export const requestStop = (): void => {
  stopRequested = true;
};
export const __resetStopForTesting = (): void => {
  stopRequested = false;
};

const stopAwareSleep = async (ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopRequested) return;
    const remaining = deadline - Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
};

/** Cache key per BS#1192: Apple URLs are track-aware, so all three axes. */
export const tripleKey = (artist: string | null, album: string | null, track: string | null): string =>
  `${(artist ?? '').toLowerCase()} ${(album ?? '').toLowerCase()} ${(track ?? '').toLowerCase()}`;

/** Shared coarse net, so the COUNT, the paged SELECT and the UPDATE can't drift. */
const flowsheetNet = sql`(
    f."apple_music_url" IS NOT NULL
    AND ${FOLD_FN}(f."artist_name") ~ ${VA_NET_REGEX}
  )`;

/**
 * `album_metadata` carries no artist column, so the net reaches one through
 * `library` (denormalized `artist_name`, nullable until the Epic A.2 backfill)
 * falling back to the `artists` join.
 */
const albumMetadataNet = sql`(
    am."apple_music_url" IS NOT NULL
    AND ${FOLD_FN}(COALESCE(l."artist_name", ar."artist_name")) ~ ${VA_NET_REGEX}
  )`;

const albumMetadataFrom = sql`
  FROM ${ALBUM_METADATA_TABLE} am
  JOIN ${LIBRARY_TABLE} l ON l."id" = am."album_id"
  LEFT JOIN ${ARTISTS_TABLE} ar ON ar."id" = l."artist_id"
`;

const countFlowsheetCandidates = async (afterId: number): Promise<number> => {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${FLOWSHEET_TABLE} f
    WHERE ${flowsheetNet} AND f."id" > ${afterId}
  `)) as unknown as Array<{ count: number | string }>;
  return Number(rows?.[0]?.count ?? 0);
};

const loadFlowsheetBatchOnce = async (afterId: number, batchSize: number): Promise<FlowsheetRow[]> => {
  const rows = (await db.execute(sql`
    SELECT f."id" AS "id",
           f."artist_name" AS "artist_name",
           f."album_title" AS "album_title",
           f."track_title" AS "track_title",
           f."apple_music_url" AS "apple_music_url"
    FROM ${FLOWSHEET_TABLE} f
    WHERE ${flowsheetNet} AND f."id" > ${afterId}
    ORDER BY f."id" ASC
    LIMIT ${batchSize}
  `)) as unknown as FlowsheetRow[];
  return rows ?? [];
};

const loadFlowsheetBatch = async (afterId: number, batchSize: number): Promise<FlowsheetRow[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOAD_BATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadFlowsheetBatchOnce(afterId, batchSize);
    } catch (error) {
      lastError = error;
      if (stopRequested || attempt + 1 >= LOAD_BATCH_MAX_ATTEMPTS) throw error;
      const backoff = LOAD_BATCH_BACKOFF_MS[attempt] ?? 2000;
      log('warn', 'load_batch_retry', `loadBatch attempt ${attempt + 1} failed; retrying in ${backoff}ms`, {
        attempt: attempt + 1,
        after_id: afterId,
        error_message: errorMessage(error),
      });
      await stopAwareSleep(backoff);
    }
  }
  throw lastError;
};

/** A resolved write for one flowsheet row: the new URL (or null) plus the value we read. */
export interface FlowsheetFix {
  id: number;
  url: string | null;
  oldUrl: string | null;
}

/**
 * Apply one page in a single VALUES-join UPDATE inside a raised-timeout
 * transaction.
 *
 * The `IS NOT DISTINCT FROM v."old_url"` clause is a compare-and-set, and it is
 * NOT ceremony: unlike the fill-only siblings (which guard on
 * `apple_music_url IS NULL`), this job overwrites a NON-NULL value, and under
 * cooperative pause a page can sit unwritten for a long time. Two other writers
 * touch this column — the hourly `flowsheet-metadata-backfill` and the
 * long-running `apps/enrichment-worker`, the latter of which the run's
 * "sibling cron containers Exited" pre-flight does not cover.
 *
 * `updated_at` is deliberately omitted: flowsheet's BEFORE UPDATE trigger
 * `bump_flowsheet_updated_at` (migration 0084) owns that stamp.
 */
export const applyFlowsheetBatch = async (fixes: FlowsheetFix[], updateTimeoutMs: number): Promise<number> => {
  if (fixes.length === 0) return 0;
  const values = sql.join(
    fixes.map((f) => sql`(${f.id}::int, ${f.url}::varchar, ${f.oldUrl}::varchar)`),
    sql`, `
  );
  const updateSql = sql`
    UPDATE ${FLOWSHEET_TABLE} AS t
    SET "apple_music_url" = v."url"
    FROM (VALUES ${values}) AS v("id", "url", "old_url")
    WHERE t."id" = v."id"
      AND t."apple_music_url" IS NOT DISTINCT FROM v."old_url"
  `;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(updateTimeoutMs))}`);
    return tx.execute(updateSql);
  });
  return Number((result as { count?: number }).count ?? 0);
};

/**
 * Invalidate one page of `album_metadata` V/A rows.
 *
 * Sets the URL null, flips `apple_music_status` to `'unresolved'`, and RESETS
 * `streaming_reask_attempts` to 0 so the BS#1915 hourly sweep will actually
 * pick the row up even if it had previously exhausted its budget. The reset is
 * deliberate and bounded: we are asserting these values were never validly
 * verified (the pre-#1139 matcher's "verification" was a shared prefix), so
 * they are owed a fresh adjudication, and the cohort is finite.
 *
 * No LML here — the sweep owns the re-ask, through the now-guarded matcher.
 */
export const invalidateAlbumBatch = async (albumIds: number[], updateTimeoutMs: number): Promise<number> => {
  if (albumIds.length === 0) return 0;
  // Bind as a single PG-array-literal string param, not a bare interpolated JS
  // array — the BS#1068/BS#1071 trap (see `jobs/album-critic-reviews-etl/antijoin.ts`).
  // Drizzle expands a JS array into a comma-separated parameter list, so
  // `ANY(${albumIds})` reaches Postgres as `ANY(($1, $2, … $202))` — a row
  // constructor, which `ANY` rejects at parse time (42809). Safe by
  // construction: TypeScript types `albumIds: number[]`, so the join contains
  // only numeric literals.
  const idArrayLiteral = `{${albumIds.join(',')}}`;
  const updateSql = sql`
    UPDATE ${ALBUM_METADATA_TABLE}
    SET "apple_music_url" = NULL,
        "apple_music_status" = 'unresolved',
        "streaming_reask_attempts" = 0,
        "updated_at" = NOW()
    WHERE "album_id" = ANY(${idArrayLiteral}::int[])
      AND "apple_music_url" IS NOT NULL
  `;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(updateTimeoutMs))}`);
    return tx.execute(updateSql);
  });
  return Number((result as { count?: number }).count ?? 0);
};

export const analyzeTable = async (table: 'flowsheet' | 'album_metadata', timeoutMs: number): Promise<void> => {
  const target = table === 'flowsheet' ? FLOWSHEET_TABLE : ALBUM_METADATA_TABLE;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(timeoutMs))}`);
    await tx.execute(sql`ANALYZE ${target}`);
  });
};

/**
 * Resolve one triple to a verdict, with multi-pass confirmation before `none`.
 *
 * A single null is weak evidence: LML#904 measured ~56% of Apple probes timing
 * out on LML's own self-throttle, and LML#706's post-process fills
 * asynchronously (the entire premise of the BS#1631 sibling). So a `none`
 * requires NULL_CONFIRMATION_PASSES consecutive null responses, and every
 * rescue (a later pass returning a URL after an earlier null) is counted — that
 * counter is the run's live throttle-noise detector (calibrate.ts).
 *
 * Transport errors are retried and then surface as `indeterminate`, never as
 * `none`. The distinction is the whole safety story: `none` writes a permanent
 * NULL over a possibly-correct link.
 */
export const resolveTripleVerdict = async (
  row: FlowsheetRow,
  deps: { lookup: LookupFn; secondPassDelayMs: number; tracker: RescueTracker }
): Promise<Verdict> => {
  let sawFirstPassNull = false;

  for (let pass = 0; pass < NULL_CONFIRMATION_PASSES; pass += 1) {
    if (pass > 0) await stopAwareSleep(deps.secondPassDelayMs);

    let verdict: Verdict | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < LOOKUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await deps.lookup(
          row.artist_name ?? '',
          row.album_title ?? undefined,
          row.track_title ?? undefined
        );
        verdict = classifyResponse(response as Parameters<typeof classifyResponse>[0]);
        break;
      } catch (error) {
        lastError = error;
        if (stopRequested || attempt + 1 >= LOOKUP_MAX_ATTEMPTS) break;
        await stopAwareSleep(LOOKUP_BACKOFF_MS[attempt] ?? 4000);
      }
    }

    if (verdict === null) {
      log('warn', 'lml_error', 'LML lookup failed after retries', {
        row_id: row.id,
        error_message: errorMessage(lastError),
      });
      captureError(lastError, 'lml_error', { row_id: row.id });
      return { kind: 'indeterminate', reason: 'empty_results' };
    }

    if (verdict.kind === 'url') {
      // A URL after an earlier null is a DIRECTLY OBSERVED throttle-null: LML
      // had the answer and the first probe simply didn't get it.
      if (sawFirstPassNull) deps.tracker.rescued += 1;
      return verdict;
    }
    if (verdict.kind === 'indeterminate') {
      // Don't spend the remaining confirmation passes on a shed/skip window;
      // it is retryable by definition and writes nothing either way.
      return verdict;
    }
    // kind === 'none'
    if (pass === 0) {
      sawFirstPassNull = true;
      deps.tracker.firstPassNulls += 1;
    }
  }

  // Every pass returned `none`: the absence is confirmed and safe to persist.
  // (The indeterminate branch above returns eagerly, so control only reaches
  // here after NULL_CONFIRMATION_PASSES consecutive nulls.)
  return { kind: 'none' };
};

export interface RunOptions {
  dryRun: boolean;
  lookup?: LookupFn;
  checkLiveActivityFn?: CheckLiveActivityFn;
  applyBatchFn?: (fixes: FlowsheetFix[], timeoutMs: number) => Promise<number>;
  invalidateAlbumFn?: (ids: number[], timeoutMs: number) => Promise<number>;
  analyzeFn?: (table: 'flowsheet' | 'album_metadata', timeoutMs: number) => Promise<void>;
}

const emptyFlowsheetTotals = (): FlowsheetTotals => ({
  candidates: 0,
  scanned: 0,
  arbitrated: 0,
  distinctTriples: 0,
  written_url: 0,
  written_null: 0,
  skipped_changed_under_us: 0,
  indeterminate: 0,
  rescued: 0,
  first_pass_nulls: 0,
  batches: 0,
  last_id: 0,
  sample: [],
  indeterminateTriples: [],
});

/**
 * Phase 1 — flowsheet, the LML arm.
 *
 * Runs FIRST so that when phase 2 nulls `album_metadata` and the read-path
 * coalesce falls through, the value it falls through to is already correct.
 */
const runFlowsheetPhase = async (
  opts: Required<Pick<RunOptions, 'dryRun'>> & {
    lookup: LookupFn;
    checkLive: CheckLiveActivityFn;
    applyBatch: (fixes: FlowsheetFix[], timeoutMs: number) => Promise<number>;
    batchSize: number;
    afterId: number;
    updateTimeoutMs: number;
    secondPassDelayMs: number;
    maxRescueRate: number;
    minRescueSample: number;
    maxIndeterminate: number;
    lookbackSeconds: number;
    pauseMs: number;
  }
): Promise<{ totals: FlowsheetTotals; failed: boolean }> => {
  const totals = emptyFlowsheetTotals();
  const tracker = newRescueTracker();
  const urlCache = new Map<string, Verdict>();
  let cursor = opts.afterId;
  let failed = false;

  totals.candidates = await countFlowsheetCandidates(cursor);
  totals.last_id = cursor;
  log('info', 'phase_start', 'flowsheet phase starting', {
    candidates: totals.candidates,
    after_id: cursor,
    dry_run: opts.dryRun,
  });

  while (!stopRequested) {
    const rows = await loadFlowsheetBatch(cursor, opts.batchSize);
    if (rows.length === 0) break;
    totals.batches += 1;
    totals.scanned += rows.length;

    // The SQL net is a deliberate superset; this is the true arbiter.
    const arbitrated = rows.filter((r) => isVariousArtistsCredit(r.artist_name));
    totals.arbitrated += arbitrated.length;

    const fixes: FlowsheetFix[] = [];
    for (const row of arbitrated) {
      if (stopRequested) break;
      if (opts.pauseMs > 0) await opts.checkLive(opts.lookbackSeconds, opts.pauseMs);

      const key = tripleKey(row.artist_name, row.album_title, row.track_title);
      let verdict = urlCache.get(key);
      if (verdict === undefined) {
        if (opts.dryRun) {
          // Dry-run makes ZERO LML calls: it sizes the work, nothing more.
          urlCache.set(key, { kind: 'indeterminate', reason: 'empty_results' });
          totals.distinctTriples += 1;
          continue;
        }
        totals.distinctTriples += 1;
        verdict = await resolveTripleVerdict(row, {
          lookup: opts.lookup,
          secondPassDelayMs: opts.secondPassDelayMs,
          tracker,
        });
        urlCache.set(key, verdict);
      }
      if (opts.dryRun) continue;

      if (verdict.kind === 'indeterminate') {
        totals.indeterminate += 1;
        if (totals.indeterminateTriples.length < 200) totals.indeterminateTriples.push(key);
        continue;
      }
      const newUrl = verdict.kind === 'url' ? verdict.url : null;
      fixes.push({ id: row.id, url: newUrl, oldUrl: row.apple_music_url });
      if (totals.sample.length < SAMPLE_SIZE_DEFAULT) {
        totals.sample.push({ id: row.id, before: row.apple_music_url, after: newUrl });
      }
    }

    if (!opts.dryRun && fixes.length > 0) {
      try {
        const written = await opts.applyBatch(fixes, opts.updateTimeoutMs);
        const skipped = fixes.length - written;
        totals.skipped_changed_under_us += skipped;
        // The UPDATE reports only a row count, and the compare-and-set can
        // reject an arbitrary subset, so a per-outcome split cannot be derived
        // from it. Report the SUBMITTED split (which is what the verdicts
        // decided) alongside the actual `written` total and the rejects, rather
        // than inventing an attribution the database never told us. When
        // `skipped` is 0 — the overwhelmingly common case — the two agree
        // exactly.
        totals.written_url += fixes.filter((f) => f.url !== null).length;
        totals.written_null += fixes.filter((f) => f.url === null).length;
        if (skipped > 0) {
          log('warn', 'compare_and_set_skipped', 'rows changed between SELECT and UPDATE; not overwritten', {
            submitted: fixes.length,
            written,
            skipped,
            after_id: cursor,
          });
        }
      } catch (error) {
        log('error', 'write_failed', 'flowsheet batch UPDATE failed', {
          after_id: cursor,
          error_message: errorMessage(error),
        });
        captureError(error, 'write_failed', { after_id: cursor });
        failed = true;
        break;
      }
    }

    // Cursor advances only after the page's write commits.
    cursor = rows[rows.length - 1].id;
    totals.last_id = cursor;

    const rescue = evaluateRescueRate(tracker, {
      maxRate: opts.maxRescueRate,
      minSample: opts.minRescueSample,
    });
    if (rescue.abort) {
      log('error', 'throttle_abort', rescue.reason ?? 'rescue-rate ceiling exceeded', {
        rescue_rate: rescue.rate,
        sample: rescue.sample,
        after_id: cursor,
      });
      failed = true;
      break;
    }
    if (opts.maxIndeterminate > 0 && totals.indeterminate >= opts.maxIndeterminate) {
      log('error', 'indeterminate_ceiling', 'too many indeterminate triples; aborting', {
        indeterminate: totals.indeterminate,
        after_id: cursor,
      });
      failed = true;
      break;
    }
  }

  totals.rescued = tracker.rescued;
  totals.first_pass_nulls = tracker.firstPassNulls;
  return { totals, failed };
};

/** Phase 2 — album_metadata, the pure-SQL arm. Runs AFTER flowsheet. */
const runAlbumPhase = async (opts: {
  dryRun: boolean;
  checkLive: CheckLiveActivityFn;
  invalidate: (ids: number[], timeoutMs: number) => Promise<number>;
  batchSize: number;
  afterId: number;
  updateTimeoutMs: number;
  lookbackSeconds: number;
  pauseMs: number;
}): Promise<{ totals: AlbumTotals; failed: boolean }> => {
  const totals: AlbumTotals = { candidates: 0, invalidated: 0, batches: 0, last_id: opts.afterId };
  let cursor = opts.afterId;
  let failed = false;

  const countRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    ${albumMetadataFrom}
    WHERE ${albumMetadataNet} AND am."album_id" > ${cursor}
  `)) as unknown as Array<{ count: number | string }>;
  totals.candidates = Number(countRows?.[0]?.count ?? 0);
  log('info', 'phase_start', 'album_metadata phase starting', {
    candidates: totals.candidates,
    after_id: cursor,
    dry_run: opts.dryRun,
  });

  while (!stopRequested) {
    const rows = (await db.execute(sql`
      SELECT am."album_id" AS "album_id",
             COALESCE(l."artist_name", ar."artist_name") AS "artist_name"
      ${albumMetadataFrom}
      WHERE ${albumMetadataNet} AND am."album_id" > ${cursor}
      ORDER BY am."album_id" ASC
      LIMIT ${opts.batchSize}
    `)) as unknown as Array<{ album_id: number; artist_name: string | null }>;
    if (!rows || rows.length === 0) break;
    totals.batches += 1;

    if (opts.pauseMs > 0) await opts.checkLive(opts.lookbackSeconds, opts.pauseMs);

    const ids = rows.filter((r) => isVariousArtistsCredit(r.artist_name)).map((r) => r.album_id);
    if (!opts.dryRun && ids.length > 0) {
      try {
        totals.invalidated += await opts.invalidate(ids, opts.updateTimeoutMs);
      } catch (error) {
        log('error', 'write_failed', 'album_metadata invalidation failed', {
          after_id: cursor,
          error_message: errorMessage(error),
        });
        captureError(error, 'write_failed', { after_id: cursor });
        failed = true;
        break;
      }
    } else if (opts.dryRun) {
      totals.invalidated += ids.length;
    }

    cursor = rows[rows.length - 1].album_id;
    totals.last_id = cursor;
  }

  return { totals, failed };
};

export const runRemediation = async (options: RunOptions): Promise<RunResult> => {
  const dryRun = options.dryRun;
  const lookup = options.lookup ?? defaultLookup;
  const checkLive = options.checkLiveActivityFn ?? defaultCheckLiveActivity;
  const applyBatch = options.applyBatchFn ?? applyFlowsheetBatch;
  const invalidate = options.invalidateAlbumFn ?? invalidateAlbumBatch;
  const analyze = options.analyzeFn ?? analyzeTable;

  const batchSize = resolveBatchSize();
  const updateTimeoutMs = resolveUpdateTimeoutMs();
  const analyzeTimeoutMs = resolveAnalyzeTimeoutMs();
  const lookbackSeconds = resolveLiveActivityLookback();
  const pauseMs = resolveLiveActivityPauseMs();

  const flowsheet = await runFlowsheetPhase({
    dryRun,
    lookup,
    checkLive,
    applyBatch,
    batchSize,
    afterId: resolveAfterId('VA_REMEDIATION_FLOWSHEET_AFTER_ID', process.env.VA_REMEDIATION_FLOWSHEET_AFTER_ID),
    updateTimeoutMs,
    secondPassDelayMs: resolveSecondPassDelayMs(),
    maxRescueRate: resolveMaxRescueRate(),
    minRescueSample: resolveMinRescueSample(),
    maxIndeterminate: resolveMaxIndeterminate(),
    lookbackSeconds,
    pauseMs,
  });

  if (!dryRun && (flowsheet.totals.written_url > 0 || flowsheet.totals.written_null > 0)) {
    await analyze('flowsheet', analyzeTimeoutMs);
  }

  // Phase 2 only runs when phase 1 finished cleanly: nulling album_metadata
  // unmasks flowsheet's value, so it must not happen while flowsheet is still
  // known-polluted.
  let album: { totals: AlbumTotals; failed: boolean } = {
    totals: { candidates: 0, invalidated: 0, batches: 0, last_id: 0 },
    failed: false,
  };
  if (!flowsheet.failed && !stopRequested) {
    album = await runAlbumPhase({
      dryRun,
      checkLive,
      invalidate,
      batchSize,
      afterId: resolveAfterId('VA_REMEDIATION_ALBUM_AFTER_ID', process.env.VA_REMEDIATION_ALBUM_AFTER_ID),
      updateTimeoutMs,
      lookbackSeconds,
      pauseMs,
    });
    if (!dryRun && album.totals.invalidated > 0) {
      await analyze('album_metadata', analyzeTimeoutMs);
    }
  } else if (flowsheet.failed) {
    log(
      'warn',
      'album_phase_skipped',
      'flowsheet phase failed; skipping album_metadata to avoid unmasking polluted flowsheet values',
      {}
    );
  }

  const failed = flowsheet.failed || album.failed || (!dryRun && flowsheet.totals.indeterminate > 0);

  log('info', 'summary', `${JOB_NAME} finished`, {
    dry_run: dryRun,
    stopped: stopRequested,
    failed,
    flowsheet: { ...flowsheet.totals, indeterminateTriples: undefined },
    album_metadata: album.totals,
    indeterminate_sample: flowsheet.totals.indeterminateTriples.slice(0, 20),
  });

  return {
    flowsheet: flowsheet.totals,
    album_metadata: album.totals,
    dryRun,
    stopped: stopRequested,
    failed,
  };
};
