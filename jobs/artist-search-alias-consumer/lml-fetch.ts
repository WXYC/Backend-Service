/**
 * Minimal LML `POST /api/v1/artists/search-aliases/bulk` fetcher for BS#1266.
 *
 * Mirrors the shape of `jobs/library-identity-consumer/lml-fetch.ts` — duplicated
 * rather than imported so this cron job's build graph stays decoupled from the
 * long-running @wxyc/backend Express app and from @wxyc/lml-client (which has
 * not yet been extended to wrap this endpoint).
 *
 * Behaviour:
 *   - Reads `LIBRARY_METADATA_URL` (same convention as the backend client;
 *     supports a trailing `/api/v1`).
 *   - Aborts on a 30s per-call timeout.
 *   - Sends `Authorization: Bearer ${LML_API_KEY}` when the env var is set
 *     (LML enforces auth in prod).
 *   - Wraps the fetch in `Sentry.startSpan({ name: 'lml.artist_search_aliases_bulk',
 *     op: 'http.client' })` so undici auto-instrumentation has a parent
 *     transaction, and LML's `cache_stats` projects onto the span as
 *     `lml.cache.*` attributes (LML#229 pattern).
 *   - Throws `LmlFetchError` on non-2xx, abort, or network failure. The
 *     orchestrator catches and counts the batch as `lml_error`; the failed
 *     batch is retried on the next run via the SELECT predicate.
 */

import * as Sentry from '@sentry/node';

import type { ArtistSearchAliasesBulkResponse } from './lml-types.js';

const TIMEOUT_MS = 30000;

/**
 * Error variant for LML failures. Carries the HTTP status code (or null for
 * network / abort failures) and a `retryable` hint based on whether the
 * failure looked transient (network, timeout, 5xx) vs. permanent (4xx). The
 * orchestrator counts every failure as `rows_skipped { lml_error }` today
 * regardless of `retryable` — the flag is here for a future retry-with-
 * backoff layer that needs to differentiate without parsing the message.
 */
export class LmlFetchError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, opts: { status: number | null; retryable: boolean; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'LmlFetchError';
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

const baseUrl = (): string => {
  const url = process.env.LIBRARY_METADATA_URL;
  if (!url) {
    throw new Error('LIBRARY_METADATA_URL is not configured');
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
};

export const fetchArtistSearchAliasesBulk = async (names: string[]): Promise<ArtistSearchAliasesBulkResponse> => {
  return Sentry.startSpan({ name: 'lml.artist_search_aliases_bulk', op: 'http.client' }, async (span) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const apiKey = process.env.LML_API_KEY;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      span.setAttribute('lml.batch_size', names.length);

      const response = await fetch(`${baseUrl()}/api/v1/artists/search-aliases/bulk`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ names }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new LmlFetchError(`LML responded ${response.status} ${response.statusText}`, {
          status: response.status,
          retryable: response.status >= 500,
        });
      }

      const parsed = (await response.json()) as ArtistSearchAliasesBulkResponse;

      // Project LML's cache_stats onto the span (LML#229 pattern). Defensive
      // narrow to a real plain object so Object.entries can't traverse junk.
      const stats = (parsed as { cache_stats?: unknown }).cache_stats;
      if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
        const attrs: Record<string, number> = {};
        for (const [key, value] of Object.entries(stats)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            attrs[`lml.cache.${key}`] = value;
          }
        }
        if (Object.keys(attrs).length > 0) {
          try {
            span.setAttributes(attrs);
          } catch {
            /* swallowed: observability must never break the contract */
          }
        }
      }

      return parsed;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new LmlFetchError('LML artist-search-aliases request timed out', {
          status: null,
          retryable: true,
          cause: error,
        });
      }
      if (error instanceof LmlFetchError) throw error;
      throw new LmlFetchError(`LML artist-search-aliases network error: ${(error as Error).message}`, {
        status: null,
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  });
};
