/**
 * Minimal LML `bulk-resolve-libraries` fetcher for BS#802.
 *
 * Mirrors the shape of `jobs/flowsheet-metadata-backfill/lml-fetch.ts` and
 * `apps/backend/services/lml/lml.client.ts` — duplicated rather than imported
 * to keep this one-shot job's build graph independent of the @wxyc/backend
 * Express app.
 *
 * Behavior:
 *   - Reads `LIBRARY_METADATA_URL` (same convention as the backend client;
 *     supports a trailing `/api/v1`).
 *   - Aborts on a 30s per-call timeout.
 *   - Sends `Authorization: Bearer ${LML_API_KEY}` when the env var is set
 *     (LML enforces auth in production per LML#272).
 *   - Wraps the fetch in `Sentry.startSpan({name: 'lml.bulk_resolve_libraries',
 *     op: 'http.client'})` so undici auto-instrumentation has a parent
 *     transaction, and LML's `cache_stats` projects onto the span as
 *     `lml.cache.*` attributes (#646 / LML#229 pattern).
 *   - Throws a plain Error on non-2xx, abort, or network failure. The
 *     orchestrator catches and counts the batch as `lml_error` /
 *     `rows_skipped`; the failed batch is retried on the next run via the
 *     SELECT predicate (idempotent).
 */

import * as Sentry from '@sentry/node';

import type { BulkResolveInput, BulkResolveResponse } from './lml-types.js';

const TIMEOUT_MS = 30000;

const baseUrl = (): string => {
  const url = process.env.LIBRARY_METADATA_URL;
  if (!url) {
    throw new Error('LIBRARY_METADATA_URL is not configured');
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
};

export const bulkResolveLibraries = async (inputs: BulkResolveInput[]): Promise<BulkResolveResponse> => {
  return Sentry.startSpan({ name: 'lml.bulk_resolve_libraries', op: 'http.client' }, async (span) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const apiKey = process.env.LML_API_KEY;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      span.setAttribute('lml.batch_size', inputs.length);

      const response = await fetch(`${baseUrl()}/api/v1/identity/bulk-resolve-libraries`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ inputs }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LML responded ${response.status} ${response.statusText}`);
      }

      const parsed = (await response.json()) as BulkResolveResponse;

      // Project LML's cache_stats onto the span (LML#229 pattern). Defensive
      // narrow to a real plain object so Object.entries can't traverse junk
      // attributes.
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
        throw new Error('LML bulk-resolve request timed out', { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });
};
