/**
 * Minimal LML lookup fetcher for the library.artwork_url backfill (#637).
 *
 * Mirrors `jobs/flowsheet-metadata-backfill/lml-fetch.ts` near-verbatim. The
 * vendored copy (rather than importing `apps/backend/services/lml/lml.client.ts`)
 * keeps the one-shot job's build graph independent of the @wxyc/backend Express
 * app. Same isolation reason — see that file's header for the full rationale.
 *
 * Per-call budget: 30s. The orchestrator caps in-flight requests at one (via
 * the inter-row throttle), so the longer per-call timeout cannot pile up on
 * LML.
 *
 * Note: this fetcher does NOT go through `apps/backend/services/lml/lml.client.ts`,
 * so the Sentry-span wrap from #646 doesn't apply here. Trace propagation
 * relies on @sentry/node v10+ undici auto-instrumentation; same posture as
 * `flowsheet-metadata-backfill`.
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

export const lookupMetadata = async (artist: string, album?: string): Promise<LmlLookupResponse> => {
  // LML's /lookup contract requires `raw_message` even when artist/album are
  // already structured. Synthesize "<artist> - <album>" — matches the shape
  // the parser expects in LML's e2e fixtures.
  const parts = [artist, album].filter((p): p is string => Boolean(p));
  const rawMessage = parts.join(' - ');

  const body: Record<string, string> = { artist, raw_message: rawMessage };
  if (album) body.album = album;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // LML enforces auth in production (LML_REQUIRE_AUTH=true). Send the bearer
  // header when LML_API_KEY is set; the backend's lml.client.ts does the same.
  // Sending it before the flag flips is harmless.
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
