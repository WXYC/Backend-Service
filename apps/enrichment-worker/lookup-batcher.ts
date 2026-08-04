/**
 * Burst-coalescing LML lookup batcher for the CDC enrichment worker
 * (B3 / BS#1749, under Epic C #877).
 *
 * The CDC listener dispatches one fire-and-forget `handleCandidate` per new
 * flowsheet row. Before B3 each of those issued its own `lookupMetadata`
 * round-trip, so a burst of N rows fired N calls and overran LML's
 * server-side concurrency ceiling (the Semaphore(5) + TokenBucket the shared
 * client mirrors). This module coalesces the burst: every `enrichmentBulkLookup`
 * caller is buffered for a short window (`ENRICHMENT_BULK_WINDOW_MS`), then the
 * whole buffer is flushed through `bulkLookupMetadata` — the shared-client
 * method that already existed and was previously unused — chunked at LML's
 * hard cap of 100 items per call. Under a burst this cuts N round-trips to
 * ceil(N / 100), i.e. ~100× fewer at burst scale.
 *
 * Parity with the per-call path is the load-bearing invariant. Each caller
 * gets back its own `LookupResponse`, resolved from the per-item verdict at
 * its input index:
 *   - `match` / `no_match` → resolve with `verdict.lookup` (the same
 *     `LookupResponse` a single `lookupMetadata` would have returned; an empty
 *     `results` array is the no-match signal `finalizeRow` already handles).
 *   - `error` (or a missing verdict) → reject that ONE caller. The worker's
 *     catch arm then leaves its row `enriching` for the C6 sweep (#895),
 *     exactly as it did when a single lookup threw. One item's failure never
 *     poisons its batch siblings.
 * If the bulk HTTP call itself throws (timeout, 5xx), every caller in that
 * chunk is rejected — again matching the per-row throw semantics.
 *
 * `extended: true` rides every item: the worker is the canonical
 * `album_metadata` writer (BS#1336) and LML#685 honors per-item `extended` on
 * the bulk path (cache-only there, so zero incremental Discogs cost), so the
 * 8 extended-only `DiscogsMatchResult` fields survive the batch.
 *
 * `allowReleaseResolutionFallback: true` also rides every dispatch (BS#1815):
 * `/lookup/bulk` hardcodes `allow_release_resolution_fallback=false`
 * server-side (LML#671's offline-drain kill switch), which silently dropped
 * non-library album resolution for this worker after the B3 migration off
 * single-item `/lookup` (whose per-item default is `true`) — the actual gap
 * in the "parity with the per-call path" claim above. LML#920 turns the flag
 * into a per-caller query param so this worker can opt back in without
 * re-enabling it for the offline drains that share `bulkLookupMetadata`
 * (`album-level-backfill`, `catalog-popularity-freetext-resolve`,
 * `flowsheet-linked-reenrichment`), which must keep omitting it.
 *
 * Ownership note: this module holds process-global mutable state (the buffer
 * and the flush timer). That is intentional — the coalescing point must be a
 * singleton per worker process so concurrent CDC ticks share one buffer.
 * `_resetLookupBatcherForTest` clears it between tests.
 */

import { bulkLookupMetadata, envInt, LmlClientError, type BulkLookupItem, type LookupResponse } from '@wxyc/lml-client';

/**
 * LML's per-request hard cap on bulk items (kept in lockstep with LML#368 and
 * the client-side `BULK_LOOKUP_INPUT_CAP` guard in `@wxyc/lml-client`). A
 * buffered burst is sliced into chunks no larger than this before dispatch.
 */
const BULK_MAX_ITEMS = 100;

/**
 * How long to hold a buffered lookup before flushing, giving a CDC burst time
 * to coalesce into one call. Kept short so the fire-and-forget latency the
 * worker already tolerates (a background enrichment path) barely moves; the
 * whole point is to trade a few ms of buffering for ~100× fewer round-trips.
 */
export const ENRICHMENT_BULK_WINDOW_MS = envInt('ENRICHMENT_BULK_WINDOW_MS', 50);

// BS#1826 PR 2: `ENRICHMENT_LML_BUDGET_MS` retired here — the batch dispatch
// below now relies on the `enrichment-worker` class-5 policy default
// (28000ms budget / 29000ms timeout, `@wxyc/lml-client` `policy.ts`) instead
// of a locally-duplicated constant. `sweep.ts`'s `STRANDED_TTL_SECONDS`
// derives from `resolveLmlPolicy('enrichment-worker').budgetMs` directly so
// the two stay coupled through the SAME source of truth (previously two
// independent `envInt('ENRICHMENT_LML_BUDGET_MS', 29000)` reads that could
// drift if only one call site's env var was overridden).

/** Caller-class label projected onto the `lml.caller` Sentry span (BS#1235). */
const ENRICHMENT_CALLER = 'enrichment-worker';

/**
 * BS#1978: default-off suppression lever for `X-Caller-Budget-Ms` on THIS
 * worker's bulk dispatch. Set `ENRICHMENT_SUPPRESS_LML_BUDGET=true` to arm
 * it; merging this change is otherwise a byte-for-byte no-op. See the
 * comment on `dispatchChunk`'s `budgetMs` line below for the full WHY.
 *
 * Read at call time (not captured in a module-scope `const`) so a test can
 * flip `process.env` without re-importing the module, and so a live
 * operator's `.env` edit + container restart takes effect without a code
 * change — mirrors `apps/enrichment-worker/enrich.ts`'s
 * `isBandcampReaskEnabled` convention (strict `=== 'true'`; any other value,
 * including `'1'`/`'yes'`, is off).
 */
export function isSuppressLmlBudgetEnabled(): boolean {
  return process.env.ENRICHMENT_SUPPRESS_LML_BUDGET === 'true';
}

/** The per-row fields the worker resolves before enqueuing a lookup. */
export interface EnrichmentLookupInput {
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
}

interface PendingLookup {
  item: BulkLookupItem;
  resolve: (response: LookupResponse) => void;
  reject: (error: unknown) => void;
}

let buffer: PendingLookup[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Build a bulk item from a candidate's fields. `raw_message` is synthesized
 * the same way `lookupMetadata` does (`[artist, album, song].filter().join(' - ')`)
 * so LML's parser sees an identical free-form description on either path.
 */
function toBulkItem(input: EnrichmentLookupInput): BulkLookupItem {
  const artist = input.artist_name || undefined;
  const album = input.album_title ?? undefined;
  const song = input.track_title ?? undefined;
  const rawMessage = [artist, album, song].filter(Boolean).join(' - ');
  const item: BulkLookupItem = { raw_message: rawMessage, extended: true };
  if (artist) item.artist = artist;
  if (album) item.album = album;
  if (song) item.song = song;
  return item;
}

/**
 * Enqueue a lookup into the current burst window. Returns the same
 * `LookupResponse` a single `lookupMetadata(...)` call would have produced for
 * this row (resolves on match/no-match, rejects on a per-item error or a
 * failed bulk call), so callers are drop-in with the per-row path.
 */
export function enrichmentBulkLookup(input: EnrichmentLookupInput): Promise<LookupResponse> {
  return new Promise<LookupResponse>((resolve, reject) => {
    buffer.push({ item: toBulkItem(input), resolve, reject });
    scheduleFlush();
  });
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushBuffer();
  }, ENRICHMENT_BULK_WINDOW_MS);
}

/**
 * Drain the buffer and dispatch it as one or more bulk calls, each capped at
 * `BULK_MAX_ITEMS`. Chunks fire concurrently; the shared client's limiter
 * (Semaphore(5) + TokenBucket) gates their Discogs amplification, so this
 * never over-consumes the shared rate pool even for a large burst.
 */
function flushBuffer(): void {
  const pending = buffer;
  buffer = [];
  for (let start = 0; start < pending.length; start += BULK_MAX_ITEMS) {
    void dispatchChunk(pending.slice(start, start + BULK_MAX_ITEMS));
  }
}

async function dispatchChunk(chunk: PendingLookup[]): Promise<void> {
  try {
    const response = await bulkLookupMetadata(
      chunk.map((pending) => pending.item),
      {
        caller: ENRICHMENT_CALLER,
        // BS#1815: restore non-library album resolution on the live
        // enrichment path. `/lookup/bulk` hardcodes the LML#671 offline-drain
        // kill switch (allow_release_resolution_fallback=false) unless the
        // caller opts in via LML#920's per-caller query flag. The single-item
        // `/lookup` this worker used pre-B3 (BS#1749) defaulted the flag
        // true; only THIS live caller should opt back in — the offline
        // drains (album-level-backfill, catalog-popularity-freetext-resolve,
        // flowsheet-linked-reenrichment) must keep the kill switch on.
        allowReleaseResolutionFallback: true,
        // BS#1978 (blocked by / building on BS#1914): when
        // `ENRICHMENT_SUPPRESS_LML_BUDGET=true`, suppress `X-Caller-Budget-Ms`
        // on this dispatch by passing `budgetMs: null` — the BS#1914 lever
        // (`resolveCallBudgetMs` + `sanitizeCallBudgetMs`, `@wxyc/lml-client`)
        // that omits the header from the wire request entirely, distinct from
        // leaving `budgetMs` unset (which inherits the `enrichment-worker`
        // class-5 policy default of 28000). Flag OFF (default): the object
        // literally has no `budgetMs` key, so this dispatch is byte-for-byte
        // identical to pre-#1978 behavior.
        //
        // WHY suppress at all: BS#1914 established that class 5's header
        // value is mostly symbolic — LML clamps the effective search budget
        // to `min(header − 200ms, LML_SEARCH_BUDGET_MS)` (prod leaves
        // `LML_SEARCH_BUDGET_MS` unset, defaulting to 4000ms), so this
        // caller's real ceiling is ~4s regardless of the header's magnitude.
        // That 4s fast-degrade is the CORRECT, deliberate behavior for the
        // offline drains that share `bulkLookupMetadata`
        // (`album-level-backfill`, `catalog-popularity-freetext-resolve`,
        // `flowsheet-linked-reenrichment`, every other `*-backfill` job) — a
        // hard-miss row should give up quickly and free the shared Discogs
        // ceiling for the next row, so those callers must keep sending the
        // header unconditionally; do not extend this flag to them. It is
        // WRONG for THIS caller specifically: `enrichment-worker` enriches
        // new rotation arrivals — albums in neither `library.db` nor the
        // library-filtered Discogs cache — whose cold non-library release
        // resolution measures 4-20s on prod (2026-08-04 replay evidence,
        // BS#1978/BS#1914). Under the 4s clamp, LML gives up on exactly the
        // rows that need the most time, writing a terminal
        // `enriched_no_match` for an album that a headerless retry would
        // have resolved (59% of one day's 41 rotation-linked no-match rows
        // recovered on replay).
        //
        // MECHANISM: the header's mere PRESENCE — not its magnitude — is
        // what arms two LML-side gates: the empty-state cascade cutoff
        // (WXYC/library-metadata-lookup#345) and the enrichment-tail shed
        // (WXYC/library-metadata-lookup#930). Omitting it does NOT raise
        // either gate's ceiling — it removes the empty-state cutoff so a
        // genuine hard miss falls through to LML's own hard cap instead of
        // giving up early. The resulting bounds once suppressed: LML's
        // `LML_SEARCH_HARD_TIMEOUT_MS` (default 25000ms, unset in prod) on
        // LML's side, and this client's class-5 `timeoutMs` (29000ms,
        // `policy.ts`) on the socket — the AbortController fires at 29s
        // regardless of what LML does, so 29s is the true worst-case ceiling
        // a suppressed call can hold a `defaultLimiter` permit for. `sweep.ts`'s
        // `STRANDED_TTL_SECONDS` (60s) is unaffected by this flag — it
        // derives from the POLICY TABLE's `budgetMs` (`resolveLmlPolicy`),
        // which this per-call override never mutates; see that file's
        // BS#1978 test coverage for the arithmetic confirming 60s still
        // comfortably exceeds the ~34s worst case (29s timeout + up to 5s
        // `LML_LIMITER_MAX_QUEUE_WAIT_MS` pre-admission queue wait).
        //
        // Limiter-occupancy tradeoff (raised explicitly per the BS#1978
        // constraints, not resolved here): this worker shares the
        // process-wide `defaultLimiter` (BS#1748 — deliberately NOT a
        // dedicated one), so a suppressed cold lookup can hold its permit for
        // ~25s (LML's own hard cap) and up to 29s in the worst case (this
        // client's AbortController, if LML overruns that cap), instead of the
        // ~4s the empty-state cutoff bounded it to — reducing concurrent
        // enrichment throughput and increasing pre-admission queue pressure
        // on that shared Semaphore(5). A saturated queue sheds to
        // `outcome: 'shed_limiter_saturated'` (bounded by
        // `LML_LIMITER_MAX_QUEUE_WAIT_MS`, 5s) rather than hanging, and a
        // shed verdict is already rejected as retryable, never resolved into
        // a terminal no-match (BS#1748, the `shed_limiter_saturated` /
        // `shed_breaker_open` branch below). See the BS#1978 PR description
        // for the throughput math; a dedicated limiter for this worker is a
        // candidate follow-up, not filed here.
        ...(isSuppressLmlBudgetEnabled() ? { budgetMs: null } : {}),
      }
    );

    // LML returns one verdict per input in input order, tagged with the
    // zero-based `index`. Map by index (not array position) so a short,
    // reordered, or gap-carrying results array still routes each verdict to
    // the right caller — a missing index rejects only that one caller.
    const byIndex = new Map<number, (typeof response.results)[number]>();
    for (const verdict of response.results ?? []) {
      byIndex.set(verdict.index, verdict);
    }

    chunk.forEach((pending, index) => {
      const verdict = byIndex.get(index);
      if (verdict === undefined) {
        pending.reject(new LmlClientError(`bulk lookup returned no verdict for item ${index}`, 502));
        return;
      }
      if (verdict.status === 'error' || verdict.lookup === null) {
        pending.reject(new LmlClientError(verdict.message ?? `bulk lookup error for item ${index}`, 502));
        return;
      }
      // BS#1748: a shed verdict (`shed_limiter_saturated` / `shed_breaker_open`)
      // carries a NON-null empty `lookup`, so it would otherwise fall through to
      // `resolve` and be finalized as a terminal `enriched_no_match` — burning
      // the row on a transient LML saturation the shed was meant to defer.
      // Unlike the interactive class-2 callers (which re-enrich on the next
      // read), this worker owns the `pending` claim, so a shed MUST be
      // retryable: reject it exactly like a bulk-call failure so the row is
      // left `enriching` for the C6 stranded-claim sweep to recover once LML
      // recovers. (This worker shares the process-wide `defaultLimiter`, which
      // is the limiter that carries the breaker — it is NOT on a dedicated
      // limiter, so it genuinely sees sheds.)
      if (verdict.status === 'shed_limiter_saturated' || verdict.status === 'shed_breaker_open') {
        pending.reject(new LmlClientError(`bulk lookup shed for item ${index}: ${verdict.status}`, 503));
        return;
      }
      pending.resolve(verdict.lookup);
    });
  } catch (err) {
    // The bulk call itself failed (timeout / 5xx / validation). Reject every
    // caller in the chunk; each worker leaves its row `enriching` for the C6
    // sweep, exactly as a single-lookup throw would have.
    for (const pending of chunk) {
      pending.reject(err);
    }
  }
}

/**
 * Test-only: clear the buffer and cancel any pending flush timer without
 * dispatching. Production code must never call this — buffered callers would
 * hang forever. The leading underscore keeps that intent loud.
 */
export function _resetLookupBatcherForTest(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  buffer = [];
}
