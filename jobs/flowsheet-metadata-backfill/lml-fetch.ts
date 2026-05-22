/**
 * Minimal LML lookup fetcher for the historical metadata drain (#638).
 *
 * Mirrors a subset of `apps/backend/services/lml/lml.client.ts`. Duplicated
 * rather than imported because that file is part of the @wxyc/backend
 * Express app and depends on app-only modules — pulling it into a one-shot
 * job would couple their build graphs and force the job container to ship
 * the entire backend tree. Same reasoning as
 * `jobs/library-canonical-entity-backfill/lml-fetch.ts`.
 *
 * The wrapper:
 *   - Reads LIBRARY_METADATA_URL (same convention as the backend client;
 *     supports a trailing /api/v1).
 *   - Aborts on a 30s per-call timeout. Long enough for LML's Discogs /
 *     MusicBrainz fallback chains on long-tail rows.
 *   - Gates every call through `defaultLmlLimiter` (BS#995): a Semaphore
 *     (BACKFILL_LML_MAX_CONCURRENT, default 1) + TokenBucket
 *     (BACKFILL_LML_RATE_PER_MIN, default 20). The 2026-05-21 incident
 *     (BS#994) confirmed the orchestrator's serial loop alone wasn't a
 *     sufficient safety story — a single in-flight LML call held for the
 *     full 30s catch-arm budget already starved real-time iOS + dj-site
 *     traffic. The bucket caps backfill's call rate independent of the
 *     orchestrator's speed; the permit is belt-and-suspenders defense.
 *   - Throws a plain Error on non-2xx, abort, and network failure. The
 *     orchestrator catches and counts as `lml_error`, leaving
 *     `metadata_attempt_at` NULL so the row stays in the retry pool —
 *     same shape #639 codified for the runtime path.
 *   - Wraps the fetch in `Sentry.startSpan({name: 'lml.lookup', op: 'http.client'})`
 *     so undici auto-instrumentation has a parent transaction context to
 *     attach http.client spans to (#715). Without the wrap the job runs
 *     outside a transaction and emits no spans, which prevents LML#229's
 *     cache_stats projection from joining the trace. Mirrors #646's wrap
 *     in `apps/backend/services/lml/lml.client.ts`. Limiter waits sit
 *     inside the span so queue time shows up in the trace's `lml.lookup`
 *     duration.
 */

import * as Sentry from '@sentry/node';

import { defaultLmlLimiter } from './lml-limiter.js';
import type { LmlLookupResponse } from './lml-types.js';

const TIMEOUT_MS = 30000;

const baseUrl = (): string => {
  const url = process.env.LIBRARY_METADATA_URL;
  if (!url) {
    throw new Error('LIBRARY_METADATA_URL is not configured');
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
};

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<LmlLookupResponse> => {
  // Wrap the call in a Sentry span so undici auto-instrumentation has a
  // parent transaction to attach http.client spans to, and LML's
  // cache_stats lands as attributes on the same trace (LML#229). Same
  // contract as the backend client's #646 wrap.
  return Sentry.startSpan({ name: 'lml.lookup', op: 'http.client' }, async (span) => {
    return defaultLmlLimiter.run(async () => {
      // LML's /lookup contract requires `raw_message` even when artist/album/
      // track are already structured. Synthesize "<artist> - <album> - <track>"
      // — matches the shape the parser expects in LML's e2e fixtures.
      const parts = [artist, album, track].filter((p): p is string => Boolean(p));
      const rawMessage = parts.join(' - ');

      const body: Record<string, string> = { artist, raw_message: rawMessage };
      if (album) body.album = album;
      if (track) body.song = track;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      // LML enforces auth in production (LML_REQUIRE_AUTH=true). Send the
      // bearer header when LML_API_KEY is set; the backend's lml.client.ts
      // does the same. Sending it before the flag flips is harmless.
      const apiKey = process.env.LML_API_KEY;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      try {
        const response = await fetch(`${baseUrl()}/api/v1/lookup`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`LML responded ${response.status} ${response.statusText}`);
        }

        const parsed = (await response.json()) as LmlLookupResponse;

        // cache_stats is freeform on the LML side (additionalProperties: true).
        // Defensively narrow to a real plain object — Object.entries on
        // an array would project junk attributes like lml.cache.0=...
        const stats = (parsed as { cache_stats?: unknown }).cache_stats;
        if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
          const attrs: Record<string, number> = {};
          for (const [key, value] of Object.entries(stats)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
              attrs[`lml.cache.${key}`] = value;
            }
          }
          if (Object.keys(attrs).length > 0) {
            // Observability must never break the lookup contract; swallow.
            try {
              span.setAttributes(attrs);
            } catch {
              /* swallowed */
            }
          }
        }

        return parsed;
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          throw new Error('LML request timed out', { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
  });
};
