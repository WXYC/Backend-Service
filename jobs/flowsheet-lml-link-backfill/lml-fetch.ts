/**
 * Minimal LML lookup fetcher for the B-2.2 backfill.
 *
 * Mirrors `jobs/library-canonical-entity-backfill/lml-fetch.ts`. Duplicated
 * rather than imported across job packages because importing across job
 * workspaces would couple their build graphs and force one container to
 * ship the other's tree. Kept tight on purpose.
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
  // LML's /lookup contract requires `raw_message` even when artist/album are
  // already structured. Synthesize "<artist> - <album>" — matches the shape
  // the parser expects in LML's e2e fixtures.
  const rawMessage = album ? `${artist} - ${album}` : artist;
  const body: Record<string, string> = { artist, raw_message: rawMessage };
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
