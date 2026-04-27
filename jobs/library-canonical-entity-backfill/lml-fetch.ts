/**
 * Minimal LML lookup fetcher for the B-1.2 backfill.
 *
 * Mirrors a subset of `apps/backend/services/lml/lml.client.ts`. We duplicate
 * rather than import because that file is part of the @wxyc/backend Express
 * app and depends on app-only modules; pulling it into a one-shot job would
 * couple their build graphs and force the job container to ship the entire
 * backend tree.
 *
 * The wrapper:
 *   - Reads LIBRARY_METADATA_URL from env (same convention as the backend
 *     client; supports a trailing /api/v1).
 *   - Aborts on a 5s per-call timeout. The throttle in `orchestrate.ts`
 *     keeps long timeout chains from compounding into LML.
 *   - Throws a plain Error on non-2xx, abort, and network failure. The
 *     orchestrator catches and counts as `error`, so the per-row error
 *     contract stays "bubble up = retry on next sweep."
 */

import type { LmlLookupResponse } from './lml-types.js';

const TIMEOUT_MS = 5000;

const baseUrl = (): string => {
  const url = process.env.LIBRARY_METADATA_URL;
  if (!url) {
    throw new Error('LIBRARY_METADATA_URL is not configured');
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
};

export const lookupMetadata = async (artist: string, album?: string): Promise<LmlLookupResponse> => {
  const body: Record<string, string> = { artist };
  if (album) body.album = album;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl()}/api/v1/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
