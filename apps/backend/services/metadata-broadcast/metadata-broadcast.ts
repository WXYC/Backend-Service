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
 * Per-row payload includes `id` and `metadata_status` so dj-site can scope
 * a refetch to just the changed row instead of paying for a list refetch.
 * Today's dj-site treats this as a generic update signal; the per-row
 * payload is forward-compat for finer-grained handling.
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

import type { CdcEvent } from '@wxyc/database';
import { onCdcEvent } from '@wxyc/database';
import { serverEventsMgr, Topics, FsEvents } from '../../utils/serverEvents.js';

const TERMINAL_STATUSES = new Set(['enriched_match', 'enriched_no_match', 'failed_no_retry']);

export type MetadataBroadcastPayload = {
  id: number;
  metadata_status: 'enriched_match' | 'enriched_no_match' | 'failed_no_retry';
};

/** Pure filter for testability — returns the broadcast payload on match, null on skip. */
export function filterMetadataUpdate(event: CdcEvent): MetadataBroadcastPayload | null {
  if (event.table !== 'flowsheet') return null;
  if (event.action !== 'UPDATE') return null;
  if (!event.data) return null;

  const data = event.data as Record<string, unknown>;
  const status = data.metadata_status;
  if (typeof status !== 'string' || !TERMINAL_STATUSES.has(status)) return null;

  const id = data.id;
  if (typeof id !== 'number') return null;

  return { id, metadata_status: status as MetadataBroadcastPayload['metadata_status'] };
}

/**
 * Register the metadata-broadcast CDC handler. Call once at startup, after
 * `serverEventsMgr` is ready and alongside `setupCdcWebSocket()` — both
 * register independent `onCdcEvent` handlers against the same per-process
 * LISTEN connection (see `apps/backend/services/cdc/cdc-websocket.ts:89`).
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
      // might).
      console.error('[metadata-broadcast] broadcast failed:', (err as Error).message);
    }
  });
}
