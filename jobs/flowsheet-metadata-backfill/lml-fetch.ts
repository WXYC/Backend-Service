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
 *     MusicBrainz fallback chains on long-tail rows; the orchestrator's
 *     throttle caps in-flight requests at one so the longer per-call cap
 *     can't pile up on LML.
 *   - Throws a plain Error on non-2xx, abort, and network failure. The
 *     orchestrator catches and counts as `lml_error`, leaving
 *     `metadata_attempt_at` NULL so the row stays in the retry pool —
 *     same shape #639 codified for the runtime path.
 *
 * Note: this fetcher does NOT go through `apps/backend/services/lml/lml.client.ts`,
 * so the Sentry-span wrap from #646 doesn't apply. Trace propagation
 * relies on @sentry/node v10+ undici auto-instrumentation; verified in the
 * pilot run for #640. If propagation breaks, mirror #646's wrap inside
 * this client (see #638's implementation notes).
 */

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
  // LML's /lookup contract requires `raw_message` even when artist/album/
  // track are already structured. Synthesize "<artist> - <album> - <track>"
  // — matches the shape the parser expects in LML's e2e fixtures.
  const parts = [artist, album, track].filter((p): p is string => Boolean(p));
  const rawMessage = parts.join(' - ');

  const body: Record<string, string> = { artist, raw_message: rawMessage };
  if (album) body.album = album;
  if (track) body.track = track;

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

    return (await response.json()) as LmlLookupResponse;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('LML request timed out', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
