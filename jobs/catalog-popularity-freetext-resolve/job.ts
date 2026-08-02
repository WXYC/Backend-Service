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
 * BS#1518 (gate-not-provenance, per the BS#1356 decision memo §6):
 * `verdictFromLookup` only persists a release id from a `direct` LML
 * `search_type` (`isTrustedLmlAlbumMatch`, `@wxyc/lml-client`) — a non-direct
 * candidate collapses to the same null verdict a genuine no-match uses, and a
 * `trust_rejected` counter distinguishes the two in the run totals. The only
 * live reader of this table, `album-popularity-refresh.service.ts`, applies no
 * confidence floor of its own, so an ungated wrong-album id would flow
 * straight into popularity attribution. `--reverify-existing` (see the
 * "Existing-row re-verdict sweep" section below) is a separate one-shot mode
 * on this same job that re-checks rows resolved before the gate landed.
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
  enumerateFreetextPairs,
  type RawPair,
} from '@wxyc/database';
import {
  bulkLookupMetadata,
  isTrustedLmlAlbumMatch,
  type BulkLookupItem,
  type BulkLookupResponse,
} from '@wxyc/lml-client';
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

/** Minimum PAIR-level play-count floor (BS#1822), gating the eligible set at
 * enumerate time so a run stops burning LML budget on the uncacheable
 * single-play long tail. Applied to the SUM of a pair's per-track play counts
 * (`enumerateFreetextPairs`'s `total_plays`), not any one track — see
 * `shared/database/src/freetext-enumerate.ts`. Default conservatively to `2`:
 * single-play one-offs dominate the wasted cost the 2026-07-25 incident (see
 * BS#1814) traced to this job. `0` disables the floor (drain everything
 * eligible); unset applies the default (`2`) — same shape as the
 * `MAX_PAIRS_PER_RUN=0`-disables convention above, just with a non-zero
 * default. Mirrors BS#1591's non-library play-floor for the sibling
 * `flowsheet-metadata-backfill` job. A pair excluded by the floor this run is
 * not permanently excluded — it's simply not enumerated until its play count
 * (recomputed fresh every run from live `flowsheet` data) crosses the floor. */
export const MIN_PLAYS_ENV = 'FREETEXT_RESOLVE_MIN_PLAYS';
export const MIN_PLAYS_DEFAULT = 2;

/** Statement timeout for the enumerate scan. The `album_id IS NULL` partition
 * of `flowsheet` is large; a generous timeout covers the DISTINCT scan. */
export const READ_TIMEOUT_ENV = 'FREETEXT_RESOLVE_READ_TIMEOUT_MS';
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Cooperative-pause lookback window (seconds). If the most recent flowsheet
 * track was added within this many seconds, defer. `0` disables the probe.
 *
 * BS#1814: raised from the original 60s default. The flowsheet gap between
 * songs is 3-5 minutes, so a 60s lookback almost always reads quiet between
 * tracks and the job proceeds right into the streaming-check-on-add window a
 * fresh add triggers — the pause never actually parks the job for an
 * overnight live show. 300s (5 min) comfortably covers the song gap so a
 * live DJ reliably keeps the job paused. NOTE: `LIVE_ACTIVITY_LOOKBACK_SECONDS`
 * is a generic env-var name reused across jobs; raising this compiled default
 * only changes behavior for THIS job's container, and only when the var is
 * unset in its environment — if prod sets it explicitly, update that value too. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 300;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

/** Absolute UTC wall-clock stop-by time ("HH:MM", 24-hour), the BS#1814
 * primary fix for the overnight-window overrun. Checked before every batch
 * (and bounds the cooperative pause below) so a run can never bleed past this
 * time of day, no matter how large the eligible backlog is or how long DJ
 * activity holds the pause open. `04:45 UTC start + 11:00 UTC stop` leaves a
 * ~6h15m nightly window, closing well before the daytime peak while sitting
 * clear of the `rotation-lml-identity-backfill` 09:00 UTC heavy drain's own
 * start (see docs/ops-cron-scheduling.md) for most of a healthy run. */
export const STOP_BY_UTC_ENV = 'FREETEXT_RESOLVE_STOP_BY_UTC';
export const STOP_BY_UTC_DEFAULT = '11:00';

// -- Source query ------------------------------------------------------------

/** `enumerateFreetextPairs` (and its `RawPair` shape) moved to
 * `@wxyc/database` (BS#1799) so the `tests/integration` babel-jest harness —
 * which can't import this job directly (no TS transform registered for
 * `jest.config.json`) — can import the SAME statement the job runs instead of
 * hand-duplicating a SQL mirror. Imported above (for use in `runResolve`
 * below) and re-exported here so any existing import site of this job still
 * resolves; see `shared/database/src/freetext-enumerate.ts` for the
 * implementation and full rationale. */
export { enumerateFreetextPairs, type RawPair };

/** A normalized dedup key + the representative raw pair to send to LML. */
export interface NormalizedPair {
  norm_artist: string;
  norm_album: string;
  artist: string;
  album: string;
  song: string;
}

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
 * album-only exactly as before, not send an empty `song` that would confuse
 * LML's matcher. The trim/empty decision already happened at the enumerate
 * boundary (`enumerateFreetextPairs` stores a trimmed `song`), so a plain
 * truthiness check is all that's needed here. */
export const buildBulkItems = (pairs: NormalizedPair[]): BulkLookupItem[] =>
  pairs.map((p) => ({
    artist: p.artist,
    album: p.album,
    ...(p.song ? { song: p.song } : {}),
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
  /**
   * BS#1518: present (and `true`) ONLY when a candidate release id existed
   * (`artwork.release_id > 0`) but failed `isTrustedLmlAlbumMatch` — a
   * non-`direct` `search_type` answer. Absent (`undefined`) for both a
   * genuine no-match (no candidate at all) and a trusted match, so callers
   * that don't care (e.g. `upsertVerdict`, which never reads this field) see
   * no behavior change. Lets `runBatch` / the `--reverify-existing` sweep
   * distinguish "LML answered but we didn't trust it" from "LML found
   * nothing" for their `trust_rejected` counters.
   */
  trustRejected?: true;
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
 * the sentinel and a genuine no-match collapse to a null release id.
 *
 * BS#1518: a candidate release id (`releaseId > 0`) is only extracted when
 * `isTrustedLmlAlbumMatch` accepts the response's `search_type` (`direct`).
 * A non-direct candidate — the artist-fallback answer that names a DIFFERENT
 * album by the same artist (the Yenbett→Tzenni recurrence, BS#1515/BS#1516) —
 * collapses to the SAME null verdict a genuine no-match uses, with
 * `trustRejected: true` set so the caller's totals can tell the two apart.
 * The no-match path (no candidate at all) is untouched: `trustRejected` stays
 * absent, so its `upsertVerdict` write and no-match TTL semantics are
 * byte-identical to before this gate. */
export const verdictFromLookup = (
  pair: NormalizedPair,
  lookup: BulkLookupResponse['results'][number]['lookup']
): ResolutionVerdict => {
  const nullVerdict = (trustRejected?: true): ResolutionVerdict => ({
    norm_artist: pair.norm_artist,
    norm_album: pair.norm_album,
    discogs_release_id: null,
    match_confidence: null,
    ...(trustRejected ? { trustRejected } : {}),
  });

  if (!lookup) return nullVerdict();
  const artwork = lookup.results?.[0]?.artwork;
  const releaseId = artwork?.release_id ?? 0;
  if (!artwork || releaseId <= 0) return nullVerdict();

  if (!isTrustedLmlAlbumMatch(lookup)) return nullVerdict(true);

  return {
    norm_artist: pair.norm_artist,
    norm_album: pair.norm_album,
    discogs_release_id: releaseId,
    match_confidence: typeof artwork.confidence === 'number' ? artwork.confidence : null,
  };
};

// -- Absolute stop-by wall-clock bound (BS#1814) -----------------------------

/** 24-hour "HH:MM" UTC time-of-day shape. Zero-padded, strict (no "9:00") —
 * this is an ops-set env var, not a scraped feed field, so the stricter shape
 * (vs. e.g. `shared/database/src/ny-time.ts`'s lenient unpadded-hour parser)
 * fails fast on a fat-fingered value instead of silently misreading it. */
const STOP_BY_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse a "HH:MM" (24-hour, UTC) time-of-day string into its hour/minute
 * parts. Throws with an attributed message on anything else, same fail-fast
 * posture as `requirePositiveInt`. */
export const parseStopByUtc = (raw: string, envName: string = STOP_BY_UTC_ENV): { hour: number; minute: number } => {
  const m = STOP_BY_SHAPE.exec(raw);
  if (!m) {
    throw new Error(`Invalid ${envName}=${JSON.stringify(raw)}: must be a 24-hour "HH:MM" UTC time (e.g. "11:00").`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
};

/**
 * The absolute stop-by deadline (epoch ms): TODAY's UTC calendar date — the
 * date `nowMs` falls on — at `stopByUtc` ("HH:MM").
 *
 * Deliberately same-day-only: this NEVER rolls forward to tomorrow when `now`
 * is already past today's stop-by time. That is the crux of BS#1814 — the
 * nightly 04:45 UTC run sees a deadline several hours in its own future and
 * proceeds normally, but a run launched AFTER the stop hour (a manual
 * catch-up or a misfired daytime launch, e.g. started 20:00 UTC against an
 * 11:00 UTC stop-by) must see a deadline already in the past and stop
 * immediately — not compute "the next 11:00" and run all day until then.
 */
export const computeStopByDeadlineMs = (nowMs: number, stopByUtc: string): number => {
  const { hour, minute } = parseStopByUtc(stopByUtc);
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0);
};

/** True once `nowMs` has reached or passed `deadlineMs`. */
export const isPastStopBy = (nowMs: number, deadlineMs: number): boolean => nowMs >= deadlineMs;

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

/** Loop: probe → if active, sleep pauseMs → re-probe. Returns when quiet OR
 * when `deadlineMs` (BS#1814 stop-by bound) is reached — whichever first.
 *
 * Without this, a DJ active near the stop hour would otherwise carry the pause
 * loop PAST the deadline indefinitely (the loop only exits on quiet). The
 * caller (`runResolve`) must still re-check `isPastStopBy` after this
 * returns: a deadline-triggered return means activity may still be ongoing,
 * so the caller must stop rather than proceed into the next batch.
 *
 * `deadlineMs`/`now` default to values that reproduce the pre-BS#1814
 * behavior (never trips) so callers that don't pass them are unaffected. */
export const awaitQuietWindow = async (
  lookbackSeconds: number,
  pauseMs: number,
  deadlineMs: number = Infinity,
  now: () => number = Date.now
): Promise<void> => {
  while ((await checkLiveActivity(lookbackSeconds)) && !isPastStopBy(now(), deadlineMs)) {
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
  /** BS#1518: count of `match`-status results whose candidate release id was
   * rejected by `isTrustedLmlAlbumMatch` (non-`direct` search_type) and so
   * collapsed to a no-match write instead of persisting a wrong-album id.
   * This is a SUB-COUNT of `match` (every trust-rejected result is ALSO
   * counted in `match`, since LML did return a wire-level match — only the
   * persisted verdict differs), NOT a mutually exclusive outcome bucket
   * alongside it: `match + no_match + error` still sums to `batchSize`, but
   * `match` no longer implies "a release id was persisted" once a trust
   * rejection is possible. Same counter NAME as `jobs/rotation-release-id-backfill`
   * (BS#1519) for the same gate, but that job's totals ARE a mutually
   * exclusive partition (each candidate lands in exactly one bucket) — this
   * one is shaped differently because `match`/`no_match` here reflect LML's
   * wire status, not the post-gate verdict. Distinct from `no_match` (LML
   * found no candidate at all — never a trust rejection). */
  trust_rejected: number;
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
    return {
      batchSize: items.length,
      match: 0,
      no_match: 0,
      error: 0,
      upserts: 0,
      unexpected_index: 0,
      trust_rejected: 0,
    };
  }

  if (items.length === 0) {
    return { batchSize: 0, match: 0, no_match: 0, error: 0, upserts: 0, unexpected_index: 0, trust_rejected: 0 };
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
    return {
      batchSize: items.length,
      match: 0,
      no_match: 0,
      error: items.length,
      upserts: 0,
      unexpected_index: 0,
      trust_rejected: 0,
    };
  }

  let match = 0;
  let no_match = 0;
  let error = 0;
  let unexpected_index = 0;
  let trust_rejected = 0;
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
      // BS#1518: a 'match' status whose candidate failed the trust gate ALSO
      // lands a no-match verdict (verdictFromLookup already collapsed it) —
      // count it separately so trust rejections are visible in run totals.
      if (verdict.trustRejected) trust_rejected += 1;
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

  return { batchSize: items.length, match, no_match, error, upserts, unexpected_index, trust_rejected };
};

// -- Top-level orchestration -------------------------------------------------

/** Why the run stopped. `stop_by_reached` means the BS#1814 deadline cut the
 * run short with backlog remaining (safe — it drains next run); `backlog_drained`
 * means every eligible pair for this run was processed before the deadline. */
export type StopReason = 'backlog_drained' | 'stop_by_reached';

export interface ResolveSummary {
  scanned: number;
  eligible: number;
  processed: number;
  /** Planned batch count (`ceil(processed / batchSize)`) — unchanged by a
   * deadline stop, so it always reflects the full plan for this run. */
  batches: number;
  /** Batches actually executed before returning. Equal to `batches` unless
   * `stopReason === 'stop_by_reached'` cut the loop short. */
  batchesRun: number;
  match: number;
  no_match: number;
  error: number;
  upserts: number;
  unexpected_index: number;
  /** BS#1518: total `trust_rejected` verdicts across all batches this run —
   * see `BatchResult.trust_rejected`. */
  trust_rejected: number;
  stopReason: StopReason;
}

export interface ResolveOptions {
  batchSize: number;
  ratePerMin: number;
  budgetMs: number;
  noMatchTtlDays: number;
  maxPairsPerRun: number;
  minPlays: number;
  readTimeoutMs: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  /** "HH:MM" 24-hour UTC wall-clock stop-by bound (BS#1814), or `null` when the
   * bound is disabled — an explicitly-empty env var requests an unbounded,
   * supervised full-drain (capped only by `maxPairsPerRun` + the cooperative
   * pause). An UNSET env var resolves to the default bound, not `null`. */
  stopByUtc: string | null;
  /** Injectable clock so tests can drive the deadline deterministically
   * without fake timers. Defaults to the real `Date.now`. */
  now: () => number;
  dryRun: boolean;
}

export const resolveOptions = (env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv): ResolveOptions => {
  const ctx = { context: JOB_NAME };
  const rawStopByUtc = env[STOP_BY_UTC_ENV];
  // UNSET (undefined) → default bound; an EXPLICITLY-empty / whitespace-only
  // value → disabled (`null`, an unbounded supervised full-drain); any other
  // value is taken as the bound and validated eagerly below. The unset-vs-empty
  // distinction is deliberate: an operator must opt into unbounded by clearing
  // the var, and a stray whitespace value can't silently re-arm the default.
  let stopByUtc: string | null;
  if (rawStopByUtc === undefined) {
    stopByUtc = STOP_BY_UTC_DEFAULT;
  } else if (rawStopByUtc.trim() === '') {
    stopByUtc = null;
  } else {
    stopByUtc = rawStopByUtc;
  }
  // Validate eagerly (fail fast at option-resolution time), same posture as the
  // `require*Int` helpers throwing on a malformed value. A disabled (`null`)
  // bound has nothing to validate.
  if (stopByUtc !== null) parseStopByUtc(stopByUtc, STOP_BY_UTC_ENV);
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
    minPlays: requireNonNegativeInt(env[MIN_PLAYS_ENV], MIN_PLAYS_ENV, MIN_PLAYS_DEFAULT, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      ctx
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    stopByUtc,
    now: Date.now,
    dryRun: args.includes('--dry-run'),
  };
};

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** The no-op summary returned when the BS#1814 stop-by deadline has already
 * passed before any work starts (the daytime-manual-launch case). */
const stopByReachedAtStartupSummary = (): ResolveSummary => ({
  scanned: 0,
  eligible: 0,
  processed: 0,
  batches: 0,
  batchesRun: 0,
  match: 0,
  no_match: 0,
  error: 0,
  upserts: 0,
  unexpected_index: 0,
  trust_rejected: 0,
  stopReason: 'stop_by_reached',
});

export const runResolve = async (options: ResolveOptions): Promise<ResolveSummary> => {
  const nowFn = options.now ?? Date.now;
  // A disabled bound (`stopByUtc === null`) resolves to an Infinite deadline
  // that no `isPastStopBy` check can ever reach, so every deadline guard below
  // is a no-op and the run is unbounded (the supervised full-drain path).
  const deadlineMs = options.stopByUtc === null ? Infinity : computeStopByDeadlineMs(nowFn(), options.stopByUtc);

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: options.batchSize,
    rate_per_min: options.ratePerMin,
    budget_ms: options.budgetMs,
    no_match_ttl_days: options.noMatchTtlDays,
    max_pairs_per_run: options.maxPairsPerRun,
    min_plays: options.minPlays,
    stop_by_utc: options.stopByUtc ?? 'disabled',
    stop_by_deadline: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
    dry_run: options.dryRun,
  });

  // BS#1814: a run launched after today's stop-by time (a manual catch-up or
  // a misfired daytime launch) must no-op immediately — no enumerate scan, no
  // LML calls, no writes — rather than doing any work at all.
  if (isPastStopBy(nowFn(), deadlineMs)) {
    log(
      'warn',
      'stop_by_reached',
      `${JOB_NAME}: stop-by deadline (${options.stopByUtc} UTC) already passed at startup; no-op`,
      { stop_by_utc: options.stopByUtc, stop_by_deadline: new Date(deadlineMs).toISOString() }
    );
    return stopByReachedAtStartupSummary();
  }

  const raw = await enumerateFreetextPairs(options.readTimeoutMs, options.minPlays);
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
      batchesRun: 0,
      match: 0,
      no_match: 0,
      error: 0,
      upserts: 0,
      unexpected_index: 0,
      trust_rejected: 0,
      stopReason: 'backlog_drained',
    };
  }

  const interBatchSleepMs = Math.max(0, Math.floor(60_000 / options.ratePerMin));
  const batches = chunk(eligible, options.batchSize);

  let totalMatch = 0;
  let totalNoMatch = 0;
  let totalError = 0;
  let totalUpserts = 0;
  let totalUnexpectedIndex = 0;
  let totalTrustRejected = 0;
  let batchesRun = 0;
  let stopReason: StopReason = 'backlog_drained';

  for (let i = 0; i < batches.length; i += 1) {
    // BS#1814: check before entering the batch (covers the "in flight when
    // the stop hour passes" case for the PRIOR batch's post-work) as well as
    // before pausing, so a run that's already past the deadline never even
    // probes for live activity.
    if (isPastStopBy(nowFn(), deadlineMs)) {
      stopReason = 'stop_by_reached';
      log(
        'warn',
        'stop_by_reached',
        `${JOB_NAME}: stop-by deadline (${options.stopByUtc} UTC) reached before batch ${i + 1}/${batches.length}; stopping`,
        { batch_index: i + 1, batches: batches.length, stop_by_utc: options.stopByUtc }
      );
      break;
    }

    // The pause loop itself is deadline-aware (BS#1814): a DJ active AT the
    // stop hour would otherwise carry the run past it indefinitely. But a
    // deadline-triggered return from the pause doesn't mean activity actually
    // cleared, so re-check immediately below rather than assuming it's safe
    // to proceed into the batch.
    await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs, deadlineMs, nowFn);

    if (isPastStopBy(nowFn(), deadlineMs)) {
      stopReason = 'stop_by_reached';
      log(
        'warn',
        'stop_by_reached',
        `${JOB_NAME}: stop-by deadline (${options.stopByUtc} UTC) reached while paused for live activity before batch ${i + 1}/${batches.length}; stopping`,
        { batch_index: i + 1, batches: batches.length, stop_by_utc: options.stopByUtc }
      );
      break;
    }

    batchesRun += 1;
    const t0 = Date.now();
    const result = await runBatch(batches[i], { budgetMs: options.budgetMs, dryRun: false });
    const wallClockMs = Date.now() - t0;

    totalMatch += result.match;
    totalNoMatch += result.no_match;
    totalError += result.error;
    totalUpserts += result.upserts;
    totalUnexpectedIndex += result.unexpected_index;
    totalTrustRejected += result.trust_rejected;

    log('info', 'batch_done', `batch ${i + 1}/${batches.length} done`, {
      batch_index: i + 1,
      batches: batches.length,
      scanned: result.batchSize,
      match: result.match,
      no_match: result.no_match,
      lml_error: result.error,
      upserts: result.upserts,
      unexpected_index: result.unexpected_index,
      trust_rejected: result.trust_rejected,
      wall_clock_ms: wallClockMs,
    });

    if (i < batches.length - 1 && interBatchSleepMs > 0) {
      await sleep(interBatchSleepMs);
    }
  }

  if (stopReason === 'backlog_drained') {
    log('info', 'backlog_drained', `${JOB_NAME}: drained the eligible backlog for this run (no deadline hit)`, {
      batches_run: batchesRun,
      batches: batches.length,
    });
  }

  return {
    scanned: raw.length,
    eligible: eligibleTotal,
    processed: eligible.length,
    batches: batches.length,
    batchesRun,
    match: totalMatch,
    no_match: totalNoMatch,
    error: totalError,
    upserts: totalUpserts,
    unexpected_index: totalUnexpectedIndex,
    trust_rejected: totalTrustRejected,
    stopReason,
  };
};

// -- Existing-row re-verdict sweep (BS#1518 `--reverify-existing`) ----------
//
// The gate above only affects FRESH resolutions. Rows the pre-gate code
// already resolved via a non-direct match are never re-attempted under the
// normal no-match TTL retry policy (`loadSkipKeys` skips any row with a
// non-null `discogs_release_id` unconditionally — see its WHERE clause). This
// one-shot mode re-checks those existing rows through the SAME gated
// `verdictFromLookup` path and nulls the ones that no longer pass.
//
// `flowsheet_freetext_resolution` stores only the NORMALIZED key, not the raw
// (artist, album) text LML's matcher needs (see `buildBulkItems`'s doc
// comment) — resolution rows are keyed on `(norm_artist, norm_album)` alone.
// So the sweep re-derives a representative raw pair per key the same way the
// normal run does: `enumerateFreetextPairs` (no play floor — a previously-
// resolved pair may have since dropped under any floor but should still be
// reverified) + `normalizePairs`, then intersects with the resolved-row set.
// A resolved row whose key isn't found in that intersection (its flowsheet
// rows got linked, deleted, or otherwise vanished since resolution) is left
// untouched — there is nothing to re-verify it against, so this sweep makes
// no claim about it either way.
//
// Dry-run is the default (mirrors `flowsheet-linked-reenrichment` /
// `streaming-url-remediation`): every LML lookup still happens (read-only)
// and every row that WOULD be nulled is logged, but no UPDATE runs unless
// `--execute` is also passed. Nulling is row-by-row, guarded on the release
// id read at candidate-selection time — a concurrent write (the normal cron
// re-resolving the same pair) can't be silently clobbered; the guard tripping
// is counted as `raced`, not `nulled`.

export const REVERIFY_FLAG = '--reverify-existing';
export const EXECUTE_FLAG = '--execute';

/** COUNT of rows this sweep considers "previously resolved by this job" —
 * the SELECT-count-first the data-safety convention asks for, logged before
 * any LML call or write. */
export const countReverifyCandidates = async (): Promise<number> => {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS count
    FROM "wxyc_schema"."flowsheet_freetext_resolution"
    WHERE "discogs_release_id" IS NOT NULL
      AND "match_source" = ${MATCH_SOURCE}
  `)) as unknown as Array<{ count: number | string }>;
  return Number(rows?.[0]?.count ?? 0);
};

export interface ReverifyCandidateRow {
  norm_artist: string;
  norm_album: string;
  discogs_release_id: number;
}

/** Load every candidate row (same WHERE as `countReverifyCandidates`), keyed
 * by `pairKey` for the intersection against the current enumerate pass. */
export const loadReverifyCandidates = async (): Promise<Map<string, ReverifyCandidateRow>> => {
  const rows = (await db.execute(sql`
    SELECT "norm_artist", "norm_album", "discogs_release_id"
    FROM "wxyc_schema"."flowsheet_freetext_resolution"
    WHERE "discogs_release_id" IS NOT NULL
      AND "match_source" = ${MATCH_SOURCE}
  `)) as unknown as Array<{ norm_artist: string; norm_album: string; discogs_release_id: number }>;
  const out = new Map<string, ReverifyCandidateRow>();
  for (const r of rows) {
    const row: ReverifyCandidateRow = {
      norm_artist: String(r.norm_artist),
      norm_album: String(r.norm_album),
      discogs_release_id: Number(r.discogs_release_id),
    };
    out.set(pairKey(row.norm_artist, row.norm_album), row);
  }
  return out;
};

/** Pure candidate predicate: keep only the normalized pairs whose key is an
 * existing resolved row. Exported separately from `runReverify` so it's
 * trivially unit-testable without any DB or LML mocking. */
export const selectReverifyTargets = (
  normalized: NormalizedPair[],
  candidates: Map<string, ReverifyCandidateRow>
): NormalizedPair[] => normalized.filter((p) => candidates.has(pairKey(p.norm_artist, p.norm_album)));

export interface ReverifyTarget extends NormalizedPair {
  discogs_release_id: number;
}

/** Row-by-row NULL of a single trust-rejected reverify candidate. Guarded on
 * `previousReleaseId` (the value read at candidate-selection time) so a
 * concurrent write — most likely the normal cron re-resolving the SAME pair
 * afresh between this sweep's SELECT and its UPDATE — can't be silently
 * clobbered; 0 rows updated means the guard tripped (`written: false`).
 *
 * `discogs_master_id` is nulled alongside `discogs_release_id`: a master id
 * derived from a since-rejected release id is equally polluted. `resolved_at`
 * and `match_confidence` are nulled too, matching `upsertVerdict`'s no-match
 * write shape (both columns are meaningless once there's no release id) and
 * preserving the documented `resolved_at` invariant ("when a release was
 * last attached") — either would otherwise carry a stale non-null value on a
 * row whose release id is now null. `attempt_at` and `match_source` are left
 * untouched; this write only undoes the specific columns BS#1518 identified
 * as polluted. */
export const nullTrustRejectedRow = async (
  normArtist: string,
  normAlbum: string,
  previousReleaseId: number
): Promise<{ written: boolean }> => {
  const rows = (await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet_freetext_resolution"
    SET "discogs_release_id" = NULL,
        "discogs_master_id" = NULL,
        "resolved_at" = NULL,
        "match_confidence" = NULL
    WHERE "norm_artist" = ${normArtist}
      AND "norm_album" = ${normAlbum}
      AND "discogs_release_id" = ${previousReleaseId}
    RETURNING "norm_artist"
  `)) as unknown as Array<{ norm_artist: string }>;
  return { written: rows.length > 0 };
};

export interface ReverifyBatchResult {
  batchSize: number;
  /** Rows nulled (`--execute`) or that WOULD be nulled (dry-run). */
  nulled: number;
  /** Rows whose fresh verdict still trusts the existing release id (or is a
   * genuine no-match this time) — left untouched either way. */
  unchanged: number;
  /** `nullTrustRejectedRow`'s guard tripped: something else wrote this row
   * between candidate-selection and the UPDATE. Only possible with `--execute`. */
  raced: number;
  error: number;
  unexpected_index: number;
}

/** Run one reverify chunk: bulk call → re-verdict each target through the
 * SAME `verdictFromLookup` gate → null the trust-rejected ones (or just log
 * the plan, in dry-run). Mirrors `runBatch`'s per-item isolation: an HTTP
 * throw counts the whole chunk as `error`; a per-item LML error is isolated. */
export const runReverifyBatch = async (
  targets: ReverifyTarget[],
  options: { budgetMs: number; execute: boolean }
): Promise<ReverifyBatchResult> => {
  const items = buildBulkItems(targets);
  const empty: ReverifyBatchResult = {
    batchSize: items.length,
    nulled: 0,
    unchanged: 0,
    raced: 0,
    error: 0,
    unexpected_index: 0,
  };
  if (items.length === 0) return empty;

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
    log('warn', 'reverify_batch_failed', 'bulkLookupMetadata threw during reverify; batch counted as error', {
      size: items.length,
      error_message: errorMessage,
    });
    captureError(err, 'reverify_batch_failed', { size: items.length });
    return { ...empty, error: items.length };
  }

  let nulled = 0;
  let unchanged = 0;
  let raced = 0;
  let error = 0;
  let unexpected_index = 0;

  for (let i = 0; i < targets.length; i++) {
    const result = response.results[i];
    if (!result || result.index !== i) {
      unexpected_index += 1;
      log('warn', 'reverify_unexpected_result_index', `LML result.index mismatch at position ${i}; skipping`, {
        expected_index: i,
        got_index: result?.index ?? null,
      });
      continue;
    }
    if (result.status !== 'match' && result.status !== 'no_match') {
      // status === 'error' (or a skip/shed shape): transient — leave the row
      // untouched, it's still a candidate on the next manual reverify run.
      error += 1;
      continue;
    }

    const target = targets[i];
    const verdict = verdictFromLookup(target, result.lookup);
    if (!verdict.trustRejected) {
      // Still a trusted direct match (possibly a different release id — this
      // sweep never REPLACES an id, only nulls a rejected one) or a genuine
      // no-match this time. Either way, leave the persisted row as-is.
      unchanged += 1;
      continue;
    }

    if (!options.execute) {
      log(
        'info',
        'reverify_dry_run_would_null',
        `(dry-run) would null ${target.norm_artist} - ${target.norm_album} (was release_id=${target.discogs_release_id})`,
        {
          norm_artist: target.norm_artist,
          norm_album: target.norm_album,
          previous_release_id: target.discogs_release_id,
        }
      );
      nulled += 1;
      continue;
    }

    const { written } = await nullTrustRejectedRow(target.norm_artist, target.norm_album, target.discogs_release_id);
    if (written) {
      nulled += 1;
    } else {
      raced += 1;
    }
  }

  return { batchSize: items.length, nulled, unchanged, raced, error, unexpected_index };
};

export interface ReverifyOptions {
  batchSize: number;
  ratePerMin: number;
  budgetMs: number;
  readTimeoutMs: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  execute: boolean;
}

export const resolveReverifyOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): ReverifyOptions => {
  const ctx = { context: `${JOB_NAME}-reverify` };
  return {
    batchSize: requirePositiveInt(env[BULK_BATCH_SIZE_ENV], BULK_BATCH_SIZE_ENV, BULK_BATCH_SIZE_DEFAULT, ctx),
    ratePerMin: requirePositiveInt(env[BULK_RATE_PER_MIN_ENV], BULK_RATE_PER_MIN_ENV, BULK_RATE_PER_MIN_DEFAULT, ctx),
    budgetMs: requirePositiveInt(env[BULK_BUDGET_MS_ENV], BULK_BUDGET_MS_ENV, BULK_BUDGET_MS_DEFAULT, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      ctx
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    execute: args.includes(EXECUTE_FLAG),
  };
};

export interface ReverifySummary {
  candidateCount: number;
  /** Candidates whose normalized key was found in the current enumerate pass
   * (so a fresh LML lookup was possible). */
  matched: number;
  /** Candidates NOT found — left untouched, no claim made either way. */
  unmatched: number;
  batches: number;
  nulled: number;
  unchanged: number;
  raced: number;
  error: number;
  unexpected_index: number;
  execute: boolean;
}

export const runReverify = async (options: ReverifyOptions): Promise<ReverifySummary> => {
  log('info', 'reverify_started', `${JOB_NAME} ${REVERIFY_FLAG} starting`, { execute: options.execute });

  const candidateCount = await countReverifyCandidates();
  log('info', 'reverify_candidates', `${candidateCount} existing resolved rows eligible for re-verdict`, {
    candidate_count: candidateCount,
  });

  const summary: ReverifySummary = {
    candidateCount,
    matched: 0,
    unmatched: 0,
    batches: 0,
    nulled: 0,
    unchanged: 0,
    raced: 0,
    error: 0,
    unexpected_index: 0,
    execute: options.execute,
  };

  if (candidateCount === 0) return summary;

  const candidates = await loadReverifyCandidates();
  // No play floor (0): a previously-resolved pair should be reverified even
  // if its play count has since dropped below the normal run's floor.
  const raw = await enumerateFreetextPairs(options.readTimeoutMs, 0);
  const normalized = normalizePairs(raw);
  const targetPairs = selectReverifyTargets(normalized, candidates);
  const targets: ReverifyTarget[] = targetPairs.map((p) => ({
    ...p,
    discogs_release_id: candidates.get(pairKey(p.norm_artist, p.norm_album))!.discogs_release_id,
  }));

  summary.matched = targets.length;
  summary.unmatched = candidateCount - targets.length;
  log(
    'info',
    'reverify_enumerated',
    `${targets.length}/${candidateCount} existing resolved rows located in current unlinked flowsheet data ` +
      `(${summary.unmatched} skipped — no current raw text found, left untouched)`,
    { matched: summary.matched, unmatched: summary.unmatched, candidate_count: candidateCount }
  );

  const batches = chunk(targets, options.batchSize);
  summary.batches = batches.length;
  const interBatchSleepMs = Math.max(0, Math.floor(60_000 / options.ratePerMin));

  for (let i = 0; i < batches.length; i += 1) {
    await awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs);

    const t0 = Date.now();
    const result = await runReverifyBatch(batches[i], { budgetMs: options.budgetMs, execute: options.execute });
    summary.nulled += result.nulled;
    summary.unchanged += result.unchanged;
    summary.raced += result.raced;
    summary.error += result.error;
    summary.unexpected_index += result.unexpected_index;

    log('info', 'reverify_batch_done', `reverify batch ${i + 1}/${batches.length} done`, {
      batch_index: i + 1,
      batches: batches.length,
      scanned: result.batchSize,
      nulled: result.nulled,
      unchanged: result.unchanged,
      raced: result.raced,
      error: result.error,
      unexpected_index: result.unexpected_index,
      wall_clock_ms: Date.now() - t0,
    });

    if (i < batches.length - 1 && interBatchSleepMs > 0) {
      await sleep(interBatchSleepMs);
    }
  }

  return summary;
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    if (process.argv.includes(REVERIFY_FLAG)) {
      const options = resolveReverifyOptions();
      const summary = await runReverify(options);
      log('info', 'finished', `${JOB_NAME} ${REVERIFY_FLAG} done`, { mode: 'reverify', ...summary });
    } else {
      const options = resolveOptions();
      const summary = await runResolve(options);
      log('info', 'finished', `${JOB_NAME} done`, { mode: 'resolve', ...summary });
    }
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
