/**
 * Bridges the enrichment consumer's terminal UPDATE → SSE `liveFs:update`
 * broadcast (BS#892 / PR-2; closes BS#893, BS#628).
 *
 * The enrichment-worker is a separate process — it can't call
 * `serverEventsMgr.broadcast()` directly. Rather than add HTTP/IPC between
 * the two, this hook subscribes to the same CDC stream the worker writes
 * into. PG's per-process LISTEN means every BS instance receives the
 * UPDATE NOTIFY; each instance broadcasts only to its own SSE clients
 * (each client is connected to exactly one BS instance), so there's no
 * duplication.
 *
 * Filter criteria (all must hold):
 *   - table === 'flowsheet'
 *   - action === 'UPDATE'
 *   - data.metadata_status is a terminal state
 *     ('enriched_match' | 'enriched_no_match' | 'failed_no_retry')
 *
 * Payload is the flowsheet row from `event.data`, projected through the
 * client-facing `CLIENT_FACING_FLOWSHEET_COLUMNS` allow-list (BS-2 inlined
 * the row; BS#1534 projects it). dj-site's listener middleware patches the
 * row into its RTK Query cache directly — a /live viewer that just opened
 * the page sees post-enrichment fields (`artwork_url`, `release_year`, etc.)
 * without a follow-up GET. The `/events/stream` topic is anonymous
 * (`Topics.liveFs` authz `[]`), so the projection keeps the raw CDC row's
 * internal columns (`search_doc`, `composer`, `legacy_*`, `linkage_*`, …)
 * off the public stream — the same allow-list the mutation echoes and DJ
 * peek use (BS#1513). `wxyc-shared`'s `LiveFsUpdateEvent` is the canonical
 * cross-language shape; this file's `LiveFsUpdatePayload` mirrors that
 * contract. (The `/cdc` WebSocket fan-out stays unprojected by design — it
 * is `CDC_SECRET`-gated and its reconciliation-monitor consumer needs the
 * complete row; see `docs/cdc.md`.)
 *
 * False positives: the filter matches any flowsheet UPDATE that lands in
 * a terminal metadata_status. The historical `flowsheet-metadata-backfill`
 * also writes terminal status (via #891's seed), but it runs nightly and
 * the broadcasts during that window are exactly the signal listeners
 * already need ("a backfill enriched this row, refetch").
 *
 * Idempotency: SSE clients tolerate duplicate `update` events naturally —
 * the worst case is an extra refetch. The CDC pipeline does not dedupe
 * across BS instances, but each instance only owns its own SSE clients,
 * so there's no per-client duplication.
 */

import * as Sentry from '@sentry/node';
import type { CdcEvent } from '@wxyc/database';
import { onCdcEvent } from '@wxyc/database';
import { serverEventsMgr, Topics, FsEvents } from '../../utils/serverEvents.js';
import { pickClientFacingColumns } from '../../utils/flowsheet-projection.js';

const TERMINAL_STATUSES = new Set(['enriched_match', 'enriched_no_match', 'failed_no_retry']);

/**
 * Wire shape of the `liveFs:update` payload. Mirrors `LiveFsUpdateEvent` in
 * `wxyc-shared/api.yaml`. The two required fields (`id`, `metadata_status`)
 * are pinned because we assert them at the filter boundary; the remaining
 * columns are the `CLIENT_FACING_FLOWSHEET_COLUMNS` allow-list subset
 * (`artist_name`, `album_title`, `artwork_url`, ...) that `pickClientFacingColumns`
 * projects (BS#1534) — dj-site / iOS receive them via the typed
 * `FlowsheetSongEntry` schema generated from `@wxyc/shared`, which is the
 * cross-language source of truth.
 */
export type LiveFsUpdatePayload = {
  id: number;
  metadata_status: 'enriched_match' | 'enriched_no_match' | 'failed_no_retry';
  [key: string]: unknown;
};

/** Pure filter for testability — returns the broadcast payload on match, null on skip. */
export function filterMetadataUpdate(event: CdcEvent): LiveFsUpdatePayload | null {
  if (event.table !== 'flowsheet') return null;
  if (event.action !== 'UPDATE') return null;
  if (!event.data) return null;

  const data = event.data as Record<string, unknown>;
  const status = data.metadata_status;
  if (typeof status !== 'string' || !TERMINAL_STATUSES.has(status)) return null;

  const id = data.id;
  if (typeof id !== 'number') return null;

  // Project through the client-facing allow-list before the row hits the
  // anonymous `/events/stream` (BS#1534): internal CDC columns (`search_doc`,
  // `composer`, `legacy_*`, `linkage_*`, …) must not ride the public stream.
  return {
    ...pickClientFacingColumns(data),
    id,
    metadata_status: status as LiveFsUpdatePayload['metadata_status'],
  };
}

/**
 * Register the metadata-broadcast CDC handler. Call once at startup, after
 * `serverEventsMgr` is ready. Sits alongside `setupCdcWebSocket()` — both
 * register independent `onCdcEvent` handlers against the per-process LISTEN
 * connection owned by `startCdcDispatcher()` (see
 * `apps/backend/services/cdc/dispatcher.ts`). The dispatcher runs whether
 * or not the websocket is configured (BS#1187), so this handler fires in
 * environments without `CDC_SECRET`.
 */
export function setupMetadataBroadcast(): void {
  onCdcEvent((event) => {
    const payload = filterMetadataUpdate(event);
    if (!payload) return;
    try {
      serverEventsMgr.broadcast(Topics.liveFs, {
        type: FsEvents.update,
        payload,
      });
    } catch (err) {
      // Broadcast errors must not break the CDC handler chain. The
      // serverEventsMgr.broadcast already swallows per-client errors
      // (unsubAll on write failure); this guard catches anything else
      // (e.g. an empty topic set wouldn't throw, but a future change
      // might). Surface to Sentry so a sudden rate spike isn't invisible.
      Sentry.captureException(err, {
        tags: { module: 'metadata-broadcast', subsystem: 'sse' },
        extra: { id: payload.id, metadata_status: payload.metadata_status },
      });
    }
  });
}
