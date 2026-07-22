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

/**
 * Budget forwarded to LML as `X-Caller-Budget-Ms`. Mirrors the constant the
 * per-row path used in `handler.ts` (tracks the shared client's 30 s fetch
 * timeout with 1 s of slack) so batching doesn't change the deadline the
 * enrichment path negotiates with LML.
 */
const ENRICHMENT_LML_BUDGET_MS = envInt('ENRICHMENT_LML_BUDGET_MS', 29000);

/** Caller-class label projected onto the `lml.caller` Sentry span (BS#1235). */
const ENRICHMENT_CALLER = 'enrichment-worker';

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
      { budgetMs: ENRICHMENT_LML_BUDGET_MS, caller: ENRICHMENT_CALLER }
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
