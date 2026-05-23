/**
 * CDC event filter + dispatcher for the enrichment consumer (BS#892).
 *
 * The CDC pipeline is documented in docs/cdc.md. Audit completed for #892
 * acceptance: per-process LISTEN connection in `cdc-listener.ts:43-49`
 * (no pool collapse across N workers); `cdc-websocket.ts:89-99` is pure
 * fan-out with no upstream dedup. PG `pg_notify` broadcasts to every
 * `LISTEN`, so each worker instance receives every event. The N×N
 * cardinality from #892 is safe end-to-end.
 *
 * ⚠  pg_notify is fire-and-forget. A worker that drops its LISTEN
 *    connection (network blip, restart, backpressure) misses every event
 *    between disconnect and reconnect, with no replay endpoint
 *    (docs/cdc.md:25). The C6 (#895) cron is the mandatory complement:
 *    it sweeps `metadata_status='pending' AND inserted_at < now() -
 *    interval '15 minutes'` to catch what the consumer missed.
 *
 * For PR-1, the dispatcher only filters + logs. The claim + LML + finalize
 * wiring lands in PR-2.
 */

import type { CdcEvent } from '@wxyc/database';

export type EnrichmentCandidate = {
  id: number;
  entry_type: 'track';
  metadata_status: 'pending';
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
  // Epic D / BS#899: when non-null, the consumer UPSERTs `album_metadata`
  // (keyed by album_id) for the 10 metadata columns and only flips the
  // flowsheet row's `metadata_status`. When null (free-form / unlinked
  // entry), the consumer writes the 10 columns inline on flowsheet as
  // before. The split is enforced in apps/enrichment-worker/enrich.ts.
  album_id: number | null;
};

/**
 * Filter a CDC event to "this is a flowsheet track INSERT that needs
 * enrichment". Returns the typed candidate on match, null on skip.
 *
 * Filter criteria (all must hold):
 *   - table === 'flowsheet'
 *   - action === 'INSERT'
 *   - data is non-null
 *   - data.entry_type === 'track' (markers and messages don't enrich)
 *   - data.metadata_status === 'pending' (already-claimed and terminal
 *     rows are skipped; this also guards against re-delivery)
 *   - data.artist_name is non-empty (LML requires an artist; no-artist
 *     rows would always come back no-match)
 */
export function filterForEnrichment(event: CdcEvent): EnrichmentCandidate | null {
  if (event.table !== 'flowsheet') return null;
  if (event.action !== 'INSERT') return null;
  if (!event.data) return null;

  const data = event.data as Record<string, unknown>;
  if (data.entry_type !== 'track') return null;
  if (data.metadata_status !== 'pending') return null;

  const artist = data.artist_name;
  if (typeof artist !== 'string' || artist.length === 0) return null;

  const id = data.id;
  if (typeof id !== 'number') return null;

  return {
    id,
    entry_type: 'track',
    metadata_status: 'pending',
    artist_name: artist,
    album_title: typeof data.album_title === 'string' ? data.album_title : null,
    track_title: typeof data.track_title === 'string' ? data.track_title : null,
    album_id: typeof data.album_id === 'number' ? data.album_id : null,
  };
}

/**
 * Build a CDC event handler that filters for enrichment candidates and
 * logs them. PR-1's intent: deploy this and verify in prod logs that the
 * dispatch path delivers every flowsheet INSERT to every worker instance
 * (the N×N fan-out from #892's cardinality decision). PR-2 swaps the
 * log for the claim + LML + finalize sequence.
 */
export function makeLogOnlyHandler(): (event: CdcEvent) => void {
  return (event) => {
    const candidate = filterForEnrichment(event);
    if (!candidate) return;
    console.log('[enrichment-worker] would-enrich', {
      id: candidate.id,
      artist: candidate.artist_name,
      album: candidate.album_title,
      track: candidate.track_title,
    });
  };
}
